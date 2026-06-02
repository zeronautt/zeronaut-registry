const http = require('http');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, rawBody: data, error: e.message });
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function main() {
  console.log("Checking if Chrome is running on port 9222...");
  try {
    const res = await get("http://127.0.0.1:9222/json/version");
    console.log("Status:", res.status);
    console.log("Response:", res.body || res.rawBody);
  } catch (err) {
    console.error("Chrome is not listening on port 9222. Error:", err.message);
  }
}

main();
