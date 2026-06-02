const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const analysisFile = path.join(__dirname, 'browser_analysis.txt');

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

async function main() {
  console.log("Connecting to Chrome on port 9222...");
  try {
    const tabs = await get("http://127.0.0.1:9222/json/list");
    if (!Array.isArray(tabs) || tabs.length === 0) {
      console.error("No active tabs found!");
      return;
    }

    // Find the dealwork tab
    const dealworkTab = tabs.find(t => t.url && t.url.includes("dealwork.ai"));
    if (!dealworkTab) {
      console.error("Dealwork tab not found in the open Chrome tabs!");
      return;
    }

    console.log(`Connecting to Dealwork tab: "${dealworkTab.title}" | URL: ${dealworkTab.url}`);
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
      console.log("WebSocket connection established!");
      try {
        // Enable Page and Runtime domains
        await sendCommand("Runtime.enable");

        // Let's navigate or check the page state
        console.log("Evaluating page details...");
        const evalExpression = `
          (() => {
            const bodyText = document.body.innerText;
            const elements = Array.from(document.querySelectorAll('button, a, div, span'))
              .filter(el => el.innerText && el.innerText.trim().length > 0)
              .map(el => ({
                tag: el.tagName,
                text: el.innerText.trim(),
                id: el.id || null,
                classes: el.className || null,
                href: el.href || null
              }));
            
            return {
              url: window.location.href,
              title: document.title,
              textLength: bodyText.length,
              previewText: bodyText.substring(0, 5000),
              elements: elements.slice(0, 300) // limit size
            };
          })()
        `;

        const res = await sendCommand("Runtime.evaluate", {
          expression: evalExpression,
          returnByValue: true
        });

        if (res.exceptionDetails) {
          console.error("Evaluation error:", res.exceptionDetails);
          fs.writeFileSync(analysisFile, `Evaluation error: ${JSON.stringify(res.exceptionDetails, null, 2)}`);
        } else {
          const result = res.result.value;
          console.log("Evaluation complete. Page URL:", result.url);
          
          let report = `--- Chrome Browser Analysis ---\n`;
          report += `Time: ${new Date().toISOString()}\n`;
          report += `URL: ${result.url}\n`;
          report += `Title: ${result.title}\n\n`;
          report += `--- Body Text Preview (First 5000 chars) ---\n`;
          report += `${result.previewText}\n\n`;
          report += `--- Interactive Elements found ---\n`;
          result.elements.forEach((el, index) => {
            report += `[${index + 1}] <${el.tag}> text: "${el.text}" | ID: ${el.id} | Class: ${el.classes} | Href: ${el.href}\n`;
          });

          fs.writeFileSync(analysisFile, report);
          console.log(`Saved analysis to ${analysisFile}`);
        }

        ws.close();
      } catch (err) {
        console.error("Error during automation:", err.message);
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

    ws.on('error', (err) => {
      console.error("WebSocket error:", err.message);
    });

  } catch (err) {
    console.error("Error:", err.message);
  }
}

main();
