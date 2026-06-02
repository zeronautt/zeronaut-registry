const https = require('https');
const fs = require('fs');
const path = require('path');

const credsFile = path.join(__dirname, 'credentials.json');
const logFile = path.join(__dirname, 'agent_log.txt');
const pendingWorkFile = path.join(__dirname, 'pending_work.json');

function log(msg) {
  const time = new Date().toISOString();
  const line = `[${time}] ${msg}\n`;
  console.log(line.trim());
  fs.appendFileSync(logFile, line);
}

if (!fs.existsSync(credsFile)) {
  console.error("credentials.json not found! Run onboard.js first.");
  process.exit(1);
}

const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
const BASE_URL = creds.baseUrl || "https://dealwork.ai";
const AGENT_ID = creds.agentAccountId;
const API_KEY = creds.apiKey;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + urlPath);
    const options = {
      method: method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
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

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// Keep track of handled state to prevent duplicate logs/triggers
const handledContracts = new Set();

async function heartbeat() {
  try {
    const res = await request("POST", `/api/v1/agents/${AGENT_ID}/heartbeat`, { skillVersion: "1.4.0" });
    if (res.status === 200 && res.body && res.body.data) {
      const active = res.body.data.activeContracts || [];
      const pendingBids = res.body.data.summary ? res.body.data.summary.pendingBidCount : 0;
      log(`Heartbeat successful. Active contracts: ${active.length}, Pending bids: ${pendingBids}`);
    } else {
      log(`Heartbeat failed: HTTP ${res.status}`);
    }
  } catch (err) {
    log(`Heartbeat error: ${err.message}`);
  }
}

async function checkBalance() {
  try {
    const res = await request("GET", "/api/v1/wallet/balance");
    if (res.status === 200 && res.body && res.body.data) {
      const b = res.body.data;
      log(`Wallet Balance: Available=${b.available} USD, Locked=${b.locked} USD, Total=${b.total} USD`);
    } else {
      log(`Failed to fetch balance: HTTP ${res.status}`);
    }
  } catch (err) {
    log(`Balance error: ${err.message}`);
  }
}

async function pollContracts() {
  try {
    const res = await request("GET", "/api/v1/contracts?role=worker&state=escrow_locked,in_progress");
    if (res.status !== 200 || !res.body || !Array.isArray(res.body.data)) {
      log(`Failed to fetch active contracts: HTTP ${res.status}`);
      return;
    }

    const contracts = res.body.data;
    for (const contract of contracts) {
      const cid = contract.id;
      const state = contract.state;

      if (state === 'escrow_locked') {
        log(`Contract ${cid.substring(0, 8)} in state 'escrow_locked'. Starting work...`);
        const startRes = await request("POST", `/api/v1/contracts/${cid}/events`, { type: "START_WORK" });
        if (startRes.status === 200) {
          log(`Successfully started work on contract ${cid.substring(0, 8)}!`);
          
          // Send kickoff message
          await request("POST", `/api/v1/contracts/${cid}/messages`, {
            content: "I have started the task. I am analyzing the requirements and will deliver the requested work shortly. Thank you!"
          });
        } else {
          log(`Failed to start work on contract ${cid.substring(0, 8)}: HTTP ${startRes.status}`);
        }
      } else if (state === 'in_progress') {
        // If contract is in progress, check if there is a pending_work file with a deliverable for this contract
        if (fs.existsSync(pendingWorkFile)) {
          let work;
          try {
            work = JSON.parse(fs.readFileSync(pendingWorkFile, 'utf8'));
          } catch (e) {
            log(`Error reading pending_work.json: ${e.message}`);
            continue;
          }

          if (work && work.contractId === cid) {
            log(`Found pending work for contract ${cid.substring(0, 8)}. Submitting deliverable...`);
            
            // Step 1: POST deliverable
            const delivRes = await request("POST", `/api/v1/contracts/${cid}/deliverables`, {
              description: work.description || "Completed the task successfully according to criteria.",
              outputData: work.outputData || {}
            });

            if (delivRes.status === 201 || delivRes.status === 200) {
              const delivId = delivRes.body.data.id || delivRes.body.id;
              log(`Deliverable created successfully: ${delivId}. Submitting for review...`);

              // Step 2: Transition contract to in_review
              const submitRes = await request("POST", `/api/v1/contracts/${cid}/events`, {
                type: "SUBMIT_WORK",
                deliverableId: delivId
              });

              if (submitRes.status === 200) {
                log(`Successfully submitted work for contract ${cid.substring(0, 8)}!`);
                
                // Delete the pending work file so we don't resubmit it
                fs.unlinkSync(pendingWorkFile);
              } else {
                log(`Failed to submit work transition for contract ${cid.substring(0, 8)}: HTTP ${submitRes.status}`);
              }
            } else {
              log(`Failed to upload deliverable for contract ${cid.substring(0, 8)}: HTTP ${delivRes.status}`);
            }
          }
        }
      }
    }
  } catch (err) {
    log(`Contracts poll error: ${err.message}`);
  }
}

// Initial run
log("Autonomous Agent Daemon starting...");
heartbeat();
checkBalance();
pollContracts();

// Interval timers
setInterval(heartbeat, 20000);     // Every 20 seconds
setInterval(checkBalance, 30000);   // Every 30 seconds
setInterval(pollContracts, 10000);  // Every 10 seconds
