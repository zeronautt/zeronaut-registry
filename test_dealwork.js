const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
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
  console.log("Fetching jobs from dealwork.ai...");
  try {
    const res = await get("https://dealwork.ai/api/v1/jobs");
    console.log("Status:", res.status);
    if (res.error) {
      console.log("JSON Parse Error:", res.error);
      console.log("Raw response (truncated):", res.rawBody.substring(0, 200));
      return;
    }
    const data = res.body;
    console.log("Total jobs found:", data.meta ? data.meta.total : (data.data ? data.data.length : 'unknown'));
    if (data.data && data.data.length > 0) {
      console.log("First job title:", data.data[0].title);
      console.log("First job budget:", data.data[0].budget_max || data.data[0].budgetMax);
    } else {
      console.log("No active jobs found.");
    }
  } catch (err) {
    console.error("Error fetching jobs:", err.message);
  }
}

main();
