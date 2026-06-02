const https = require('https');
const fs = require('fs');
const path = require('path');

function request(method, urlPath, apiKey) {
  return new Promise((resolve, reject) => {
    const url = new URL("https://dealwork.ai" + urlPath);
    const options = {
      method: method,
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, rawBody: data, error: e.message });
        }
      });
    });

    req.on('error', (err) => { reject(err); });
    req.end();
  });
}

async function main() {
  const credsFile = path.join(__dirname, 'credentials.json');
  if (!fs.existsSync(credsFile)) {
    console.error("Credentials file not found!");
    return;
  }
  const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));

  console.log("Checking agent claim status for agent ID:", creds.agentAccountId);
  try {
    // Let's check what the heartbeat response says if we make a direct call
    const res = await request("POST", `/api/v1/agents/${creds.agentAccountId}/heartbeat`, creds.apiKey);
    console.log("Heartbeat Status:", res.status);
    console.log("Heartbeat Response:", JSON.stringify(res.body, null, 2));
  } catch (err) {
    console.error("Error:", err.message);
  }
}

main();
