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
  console.log("Listing open tabs in Chrome...");
  try {
    const res = await get("http://127.0.0.1:9222/json/list");
    console.log("Tabs list:");
    if (Array.isArray(res.body)) {
      res.body.forEach((tab, index) => {
        console.log(`[Tab ${index + 1}] Title: "${tab.title}" | URL: ${tab.url}`);
      });
    } else {
      console.log("No tabs or unexpected response:", res.body || res.rawBody);
    }
  } catch (err) {
    console.error("Error listing tabs:", err.message);
  }
}

main();
