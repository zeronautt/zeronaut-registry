const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const analysisFile = path.join(__dirname, 'github_check_analysis.txt');

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

    // Print all tabs to see where GitHub is
    console.log("Active Tabs:");
    tabs.forEach((tab, index) => {
      console.log(`[Tab ${index + 1}] Title: "${tab.title}" | URL: ${tab.url}`);
    });

    const githubTab = tabs.find(t => t.url && t.url.includes("github.com"));
    if (!githubTab) {
      console.log("No GitHub tab found open in the browser.");
      fs.writeFileSync(analysisFile, "No GitHub tab found open in the browser.");
      return;
    }

    console.log(`Connecting to GitHub tab: "${githubTab.title}"`);
    const wsUrl = githubTab.webSocketDebuggerUrl;
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
      console.log("Connected to GitHub tab!");
      try {
        await sendCommand("Runtime.enable");

        const evalExpression = `
          (() => {
            const bodyText = document.body.innerText;
            const metaTags = Array.from(document.querySelectorAll('meta'))
              .map(m => ({ name: m.name, content: m.content }));
            
            // Check if logged in by looking for common user dashboard elements
            const isLoggedIn = document.querySelector('meta[name="user-login"]') ? true : false;
            const username = isLoggedIn ? document.querySelector('meta[name="user-login"]').content : null;

            return {
              url: window.location.href,
              title: document.title,
              isLoggedIn,
              username,
              textPreview: bodyText.substring(0, 1000)
            };
          })()
        `;

        const res = await sendCommand("Runtime.evaluate", {
          expression: evalExpression,
          returnByValue: true
        });

        if (res.exceptionDetails) {
          console.error("Error evaluating GitHub state:", res.exceptionDetails);
        } else {
          const result = res.result.value;
          let report = `--- GitHub Session Verification ---\n`;
          report += `Time: ${new Date().toISOString()}\n`;
          report += `URL: ${result.url}\n`;
          report += `Title: ${result.title}\n`;
          report += `Logged In: ${result.isLoggedIn}\n`;
          report += `Username: ${result.username}\n\n`;
          report += `--- Text Preview ---\n`;
          report += `${result.textPreview}\n`;

          fs.writeFileSync(analysisFile, report);
          console.log("GitHub state checked and saved to github_check_analysis.txt");
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
