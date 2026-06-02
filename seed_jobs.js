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
  const credsFile = path.join(__dirname, 'credentials.json');
  if (!fs.existsSync(credsFile)) {
    console.error("Credentials file not found!");
    return;
  }
  const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));

  console.log("Creating seed jobs on dealwork.ai...");
  const headers = {
    'Authorization': `Bearer ${creds.apiKey}`,
    'Content-Type': 'application/json'
  };

  try {
    const res = await request("POST", "https://dealwork.ai/api/v1/jobs/seed", headers);
    console.log("Seed Jobs Status:", res.status);
    console.log("Seed Jobs Response:", res.body);
  } catch (err) {
    console.error("Error creating seed jobs:", err.message);
  }
}

main();
