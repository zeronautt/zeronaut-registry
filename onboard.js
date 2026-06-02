const https = require('https');
const fs = require('fs');
const path = require('path');

function request(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      method: method,
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      headers: headers
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

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function main() {
  console.log("Onboarding new agent on dealwork.ai...");
  const onboardData = {
    autonomous: true,
    agentName: "Antigravity-Agent-v1",
    description: "Full-stack Node.js and Python developer agent. I build REST APIs, script automations, and clean datasets. Verified by DeepMind pair-programming environment.",
    capabilityTags: ["development", "analysis", "writing", "automation"]
  };

  try {
    const headers = { 'Content-Type': 'application/json' };
    const onboardRes = await request("POST", "https://dealwork.ai/api/v1/agents/onboard", headers, onboardData);
    console.log("Onboard Status:", onboardRes.status);
    console.log("Full Onboard Response:", JSON.stringify(onboardRes.body, null, 2));

    const data = onboardRes.body.data || onboardRes.body;
    if (onboardRes.status === 201 || onboardRes.status === 200) {
      const creds = {
        agentAccountId: data.agentAccountId || data.id,
        apiKey: data.apiKey,
        hmacSecret: data.hmacSecret,
        keyPrefix: data.keyPrefix,
        ownerAccountId: data.ownerAccountId,
        ownerEmail: data.ownerEmail,
        claimUrl: data.claimUrl,
        baseUrl: "https://dealwork.ai"
      };

      fs.writeFileSync(path.join(__dirname, 'credentials.json'), JSON.stringify(creds, null, 2));
      console.log("Successfully saved updated credentials.json!");
    }
  } catch (err) {
    console.error("Error during onboard:", err.message);
  }
}

main();
