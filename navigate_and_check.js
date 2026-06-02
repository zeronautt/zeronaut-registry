const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const analysisFile = path.join(__dirname, 'jobs_board_analysis.txt');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    }).on('error', (err) => { reject(err); });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("Connecting to Chrome on port 9222...");
  try {
    const tabs = await get("http://127.0.0.1:9222/json/list");
    if (!Array.isArray(tabs) || tabs.length === 0) {
      console.error("No active tabs found!");
      return;
    }

    const dealworkTab = tabs.find(t => t.url && t.url.includes("dealwork.ai"));
    if (!dealworkTab) {
      console.error("Dealwork tab not found!");
      return;
    }

    console.log(`Connecting to Dealwork tab: "${dealworkTab.title}"`);
    const wsUrl = dealworkTab.webSocketDebuggerUrl;
    const ws = new WebSocket(wsUrl);

    let messageId = 1;
    const pendingRequests = new Map();

    function sendCommand(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = messageId++;
        const payload = JSON.stringify({ id, method, params });
        pendingRequests.set(id, { resolve, reject });
        ws.send(payload);
      });
    }

    ws.on('open', async () => {
      console.log("Connected! Enabling domains...");
      try {
        await sendCommand("Runtime.enable");
        await sendCommand("Page.enable");

        console.log("Navigating to https://dealwork.ai/dashboard/jobs...");
        await sendCommand("Page.navigate", { url: "https://dealwork.ai/dashboard/jobs" });

        console.log("Waiting 3 seconds for page to load...");
        await sleep(3000);

        console.log("Extracting jobs board information...");
        const evalExpression = `
          (() => {
            const bodyText = document.body.innerText;
            const jobCards = Array.from(document.querySelectorAll('a, div'))
              .filter(el => el.innerText && (el.innerText.includes('$') || el.innerText.toLowerCase().includes('job') || el.innerText.toLowerCase().includes('budget')))
              .map(el => el.innerText.trim().substring(0, 500));

            return {
              url: window.location.href,
              title: document.title,
              textLength: bodyText.length,
              previewText: bodyText.substring(0, 5000),
              jobCards: jobCards.slice(0, 50)
            };
          })()
        `;

        const res = await sendCommand("Runtime.evaluate", {
          expression: evalExpression,
          returnByValue: true
        });

        if (res.exceptionDetails) {
          console.error("Error during evaluation:", res.exceptionDetails);
        } else {
          const result = res.result.value;
          let report = `--- Chrome Jobs Board Analysis ---\n`;
          report += `Time: ${new Date().toISOString()}\n`;
          report += `URL: ${result.url}\n`;
          report += `Title: ${result.title}\n\n`;
          report += `--- Body Text Preview ---\n`;
          report += `${result.previewText}\n\n`;
          report += `--- Potential Job Listings ---\n`;
          result.jobCards.forEach((card, index) => {
            report += `[Card ${index + 1}]\n${card}\n------------------------\n`;
          });

          fs.writeFileSync(analysisFile, report);
          console.log(`Saved jobs board analysis to ${analysisFile}`);
        }

        ws.close();
      } catch (err) {
        console.error("Automation error:", err.message);
        ws.close();
      }
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id && pendingRequests.has(msg.id)) {
          const { resolve, reject } = pendingRequests.get(msg.id);
          pendingRequests.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        }
      } catch (e) {}
    });

  } catch (err) {
    console.error("Error:", err.message);
  }
}

main();
