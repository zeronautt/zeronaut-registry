const https = require('https');
const fs = require('fs');
const path = require('path');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download: status ${res.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function main() {
  console.log("Downloading openwork-worker.js...");
  const dest = path.join(__dirname, 'openwork-worker.js');
  try {
    await download("https://dealwork.ai/openwork-worker.js", dest);
    console.log("Download successful!");
    const stats = fs.statSync(dest);
    console.log("File size:", stats.size, "bytes");
  } catch (err) {
    console.error("Download failed:", err.message);
  }
}

main();
