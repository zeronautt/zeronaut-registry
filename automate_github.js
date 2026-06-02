/**
 * Zeronaut Automated GitHub Repository Provisioner
 * 
 * Connects to the active logged-in Google Chrome session on Port 9222.
 * Navigates to github.com/new and programmatically creates a new public repository
 * called "zeronaut-registry" for hosting the dynamic AI agent syndicate.
 */

const WebSocket = require('ws');
const http = require('http');

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
  console.log("[Provisioner] Connecting to debug Chrome on port 9222...");
  try {
    const tabs = await get("http://127.0.0.1:9222/json/list");
    if (!Array.isArray(tabs) || tabs.length === 0) {
      console.error("[Provisioner] No active Chrome tabs detected. Ensure Chrome is running with remote debugging port 9222.");
      return;
    }

    // Connect to the GitHub tab, or open a new one if not found
    let githubTab = tabs.find(t => t.url && t.url.includes("github.com"));
    if (!githubTab) {
      console.log("[Provisioner] Opening new tab to GitHub...");
      // Ask Chrome to open a new tab
      const newTabRes = await get("http://127.0.0.1:9222/json/new?https://github.com/new");
      githubTab = newTabRes;
      await sleep(3000);
    }

    console.log(`[Provisioner] Connecting to tab: "${githubTab.title}"`);
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
      try {
        await sendCommand("Runtime.enable");
        await sendCommand("Page.enable");

        console.log("[Provisioner] Navigating to https://github.com/new...");
        await sendCommand("Page.navigate", { url: "https://github.com/new" });
        await sleep(4000); // Wait for page loading

        console.log("[Provisioner] Injecting automated repository creation script...");
        
        const createExpr = `
          (() => {
            try {
              // 1. Fill Repository Name
              const nameInput = document.querySelector('input[data-testid="repository-name-input"]') || 
                                document.querySelector('#repository_name') ||
                                document.querySelector('input[name="repository_name"]');
              if (nameInput) {
                nameInput.value = "zeronaut-registry";
                nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                nameInput.dispatchEvent(new Event('change', { bubbles: true }));
              }
              
              // 2. Check public repository option
              const publicRadio = document.querySelector('input[type="radio"][value="public"]') ||
                                  document.querySelector('#repository_public');
              if (publicRadio) {
                publicRadio.checked = true;
                publicRadio.dispatchEvent(new Event('change', { bubbles: true }));
              }
              
              return { success: true, message: "Parameters filled out successfully. Standby for creation click." };
            } catch(e) {
              return { success: false, error: e.message };
            }
          })()
        `;

        const fillRes = await sendCommand("Runtime.evaluate", {
          expression: createExpr,
          returnByValue: true
        });

        console.log("[Provisioner] Fill parameters status:", fillRes.result.value);
        await sleep(3000); // Wait for form validators to verify uniqueness

        // Click create repository button
        const clickExpr = `
          (() => {
            try {
              // Find and click the green Submit button
              const buttons = Array.from(document.querySelectorAll('button[type="submit"]'));
              const createBtn = buttons.find(b => b.innerText.toLowerCase().includes('create repository') || b.textContent.toLowerCase().includes('create repository'));
              
              if (createBtn && !createBtn.disabled) {
                createBtn.click();
                return { clicked: true };
              } else if (createBtn && createBtn.disabled) {
                return { clicked: false, error: "Create button is disabled (repo might already exist)." };
              }
              
              return { clicked: false, error: "Submit button not found." };
            } catch(e) {
              return { clicked: false, error: e.message };
            }
          })()
        `;

        const clickRes = await sendCommand("Runtime.evaluate", {
          expression: clickExpr,
          returnByValue: true
        });

        console.log("[Provisioner] Button click status:", clickRes.result.value);
        await sleep(5000); // Wait for redirect to repository page

        // Retrieve current URL
        const checkUrlRes = await sendCommand("Runtime.evaluate", {
          expression: "window.location.href",
          returnByValue: true
        });

        const repoUrl = checkUrlRes.result.value;
        console.log(`[Provisioner] Redirected Repository page URL: ${repoUrl}`);

        ws.close();
      } catch (err) {
        console.error("[Provisioner] Error during execution:", err.message);
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
    console.error("[Provisioner] Network or connection error:", err.message);
  }
}

main();
