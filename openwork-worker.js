#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

// --- Credential resolution (env vars > credentials file) ---
let _credFile = {};
try {
  const _credPath = path.join(os.homedir(), ".openwork", "credentials.json");
  if (fs.existsSync(_credPath)) {
    _credFile = JSON.parse(fs.readFileSync(_credPath, "utf8"));
  }
} catch {}

const BASE_URL = process.env.OPENWORK_BASE_URL || _credFile.baseUrl || "https://dealwork.ai";
const AGENT_ID = process.env.OPENWORK_AGENT_ID || _credFile.agentAccountId || "";
const HMAC_SECRET = process.env.OPENWORK_HMAC_SECRET || _credFile.hmacSecret || "";

const OPENCLAW_AGENT_NAME = process.env.OPENWORK_OPENCLAW_AGENT_NAME || "main";
const OPENCLAW_SESSION_ID = process.env.OPENWORK_OPENCLAW_SESSION_ID || "openwork-main";

const JOBS_POLL_MS = Number(process.env.OPENWORK_JOBS_POLL_MS || 10_000);
const BIDS_POLL_MS = Number(process.env.OPENWORK_BIDS_POLL_MS || 20_000);
const HEARTBEAT_POLL_MS = Number(process.env.OPENWORK_HEARTBEAT_POLL_MS || 20_000);
const CONTRACTS_POLL_MS = Number(process.env.OPENWORK_CONTRACTS_POLL_MS || 15_000);
const CONTRACT_DETAIL_POLL_MS = Number(process.env.OPENWORK_CONTRACT_DETAIL_POLL_MS || 20_000);
const CONTRACT_MESSAGES_POLL_MS = Number(process.env.OPENWORK_CONTRACT_MESSAGES_POLL_MS || 45_000);
const REQUEST_TIMEOUT_MS = Number(process.env.OPENWORK_REQUEST_TIMEOUT_MS || 8_000);
const BUYER_CONTRACTS_POLL_MS = Number(process.env.OPENWORK_BUYER_CONTRACTS_POLL_MS || 20_000);
const SKILL_UPDATE_COOLDOWN_MS = Number(process.env.OPENWORK_SKILL_UPDATE_COOLDOWN_MS || 3_600_000);
const MAX_TRACKED_CONTRACTS = Math.max(1, Number(process.env.OPENWORK_MAX_TRACKED_CONTRACTS || 2));
const MAX_TRACKED_BUYER_CONTRACTS = Math.max(1, Number(process.env.OPENWORK_MAX_TRACKED_BUYER_CONTRACTS || 5));
const MAX_BIDS_PER_TICK = Math.max(1, Number(process.env.OPENWORK_MAX_BIDS_PER_TICK || 2));
const ACTION_NOTIFY_COOLDOWN_MS = Number(process.env.OPENWORK_ACTION_NOTIFY_COOLDOWN_MS || 60_000);
const MANAGEMENT_POLL_MS = Number(process.env.OPENWORK_MANAGEMENT_POLL_MS || 300_000);
const MOLTBOOK_GROWTH_POLL_MS = Number(process.env.OPENWORK_MOLTBOOK_GROWTH_POLL_MS || 1_800_000);
const MOLTBOOK_GROWTH_ENABLED = false;
const LISTING_POLL_MS = Number(process.env.OPENWORK_LISTING_POLL_MS || 30_000);

const WS_URL = process.env.OPENWORK_WS_URL || (function() {
  const b = (BASE_URL || "").replace(/\/$/, "");
  if (/localhost|127\.0\.0\.1/.test(b) && b.includes("3000")) return b.replace(/https?:/, "wss:").replace(":3000", ":3001");
  if (b.includes(":3000")) return b.replace(/https?:/, "wss:").replace(":3000", ":3001");
  return "";
})();
const REALTIME_ENABLED = process.env.OPENWORK_REALTIME_ENABLED !== "false";

const PID_FILE = process.env.OPENWORK_WORKER_PID_FILE || path.join(os.homedir(), ".openwork", "openwork-worker.pid");
const SUPERVISOR_PID_FILE = process.env.OPENWORK_SUPERVISOR_PID_FILE || path.join(os.homedir(), ".openwork", "openwork-supervisor.pid");
const STATE_FILE = process.env.OPENWORK_WORKER_STATE_FILE || path.join(os.homedir(), ".openwork", "openwork-worker-state.json");
const EMBEDDED_SKILL_VERSION = "1.4.0";
const HEALTH_FILE = process.env.OPENWORK_WORKER_HEALTH_FILE || path.join(os.homedir(), ".openwork", "openwork-worker-health.json");
const SUPERVISOR_CHECK_MS = Number(process.env.OPENWORK_SUPERVISOR_CHECK_MS || 15_000);
const WORKER_STALE_MS = Number(
  process.env.OPENWORK_WORKER_STALE_MS || Math.max(60_000, HEARTBEAT_POLL_MS * 4),
);
const DRY_RUN = process.argv.includes("--dry-run");
const NO_SUPERVISOR = process.argv.includes("--no-supervisor");

// --- Startup validation ---
if (process.argv.includes("--daemon") || process.argv.includes("--supervisor") || process.argv.includes("--tick-jobs") || process.argv.includes("--tick-worker") || process.argv.includes("--tick-bids")) {
  if (!AGENT_ID || !HMAC_SECRET) {
    console.error("ERROR: Missing dealwork.ai credentials.");
    console.error("Set OPENWORK_AGENT_ID + OPENWORK_HMAC_SECRET env vars,");
    console.error("or create ~/.openwork/credentials.json with {agentAccountId, hmacSecret, baseUrl}");
    process.exit(1);
  }
}

const inFlight = new Set();
const endpointPauseUntil = new Map();
const endpoint429Count = new Map();

let activeContractIds = [];
let activeBuyerContractIds = [];
let lastContractState = new Map();
let lastBuyerContractState = new Map();
let lastJobsCount = null;
let workerState = loadWorkerState();
let bidJobIdsLive = new Set();
const jobContextCache = new Map();
let lastHeartbeatBuyerContracts = [];
let lastSkillCheckAt = 0;
let lastSkillHash = "";
let realtimeDebounceTimer = null;

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeJobId(value) {
  return value ? String(value) : "";
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const pid = Number(fs.readFileSync(filePath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function touchWorkerHealth() {
  try {
    fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
    fs.writeFileSync(HEALTH_FILE, JSON.stringify({ ts: Date.now(), at: nowIso() }));
  } catch {}
}

function loadWorkerState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { bidJobIds: {}, actionNotifiedAt: {}, messageCount: {}, skillVersion: null };
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return { bidJobIds: {}, actionNotifiedAt: {}, messageCount: {}, skillVersion: null };
    if (!parsed.bidJobIds || typeof parsed.bidJobIds !== "object") parsed.bidJobIds = {};
    if (!parsed.actionNotifiedAt || typeof parsed.actionNotifiedAt !== "object") parsed.actionNotifiedAt = {};
    if (!parsed.messageCount || typeof parsed.messageCount !== "object") parsed.messageCount = {};
    if (parsed.skillVersion === undefined) parsed.skillVersion = null;
    return parsed;
  } catch {
    return { bidJobIds: {}, actionNotifiedAt: {}, messageCount: {}, skillVersion: null };
  }
}

function saveWorkerState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(workerState, null, 2));
  } catch (err) {
    console.log("[" + nowIso() + "] failed to save state: " + (err && err.message ? err.message : String(err)));
  }
}

function sign(agentId, ts, body) {
  const payload = String(agentId) + String(ts) + String(body);
  return crypto.createHmac("sha256", HMAC_SECRET).update(payload).digest("hex");
}

function buildHeaders(body) {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "Content-Type": "application/json",
    "X-Agent-ID": AGENT_ID,
    "X-Timestamp": String(ts),
    "X-Signature": sign(AGENT_ID, ts, body),
  };
}

function keyFor(method, url) {
  return method + " " + url;
}

async function apiRequest(method, path, bodyObj) {
  if (!AGENT_ID || !HMAC_SECRET) {
    console.log("[" + nowIso() + "] missing OPENWORK_AGENT_ID / OPENWORK_HMAC_SECRET");
    return { ok: false, status: 0, json: null };
  }

  const url = BASE_URL + path;
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const key = keyFor(method, url);

  const pauseUntil = endpointPauseUntil.get(key) || 0;
  if (Date.now() < pauseUntil) {
    return { ok: false, status: 429, json: null };
  }
  if (inFlight.has(key)) {
    return { ok: false, status: 0, json: null };
  }

  inFlight.add(key);
  try {
    if (DRY_RUN) {
      console.log("[dry-run] " + method + " " + path);
      return { ok: true, status: 200, json: { data: {} } };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(url, {
      method,
      headers: buildHeaders(body),
      body: method === "GET" ? undefined : body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    let json = null;
    try {
      json = await res.json();
    } catch {}

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") || "5");
      const current429 = (endpoint429Count.get(key) || 0) + 1;
      endpoint429Count.set(key, current429);
      const extraPauseSec = current429 >= 3 ? 300 : retryAfter;
      endpointPauseUntil.set(key, Date.now() + extraPauseSec * 1000);
    } else {
      endpoint429Count.set(key, 0);
    }

    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    console.log("[" + nowIso() + "] request error " + method + " " + path + ": " + (err && err.message ? err.message : String(err)));
    return { ok: false, status: 0, json: null };
  } finally {
    inFlight.delete(key);
  }
}

async function fetchJobContext(contract) {
  const jobId = contract.jobId || contract.job_id;
  if (!jobId) return null;
  if (jobContextCache.has(jobId)) return jobContextCache.get(jobId);
  const res = await apiRequest("GET", "/api/v1/jobs/" + jobId);
  if (!res.ok || !res.json || !res.json.data) return null;
  const ctx = {
    title: res.json.data.title || "Unknown",
    description: res.json.data.description || "",
    acceptanceCriteria: res.json.data.acceptanceCriteria || contract.acceptanceCriteria || {},
  };
  jobContextCache.set(jobId, ctx);
  return ctx;
}

async function fetchLatestRevisionFeedback(contractId) {
  const res = await apiRequest("GET", "/api/v1/contracts/" + contractId + "/messages");
  if (!res.ok || !res.json || !Array.isArray(res.json.data)) return "";
  const revisionMsgs = res.json.data.filter((m) => m.type === "revision_request" || (m.content && m.content.toLowerCase().includes("revision")));
  if (revisionMsgs.length === 0) return "";
  const latest = revisionMsgs[revisionMsgs.length - 1];
  return latest.content || "";
}

async function pollJobs() {
  // Request only AI-biddable jobs (server returns ai_only + any); avoids human_only in list
  const jobsRes = await apiRequest("GET", "/api/v1/jobs?per_page=20&eligible_worker_types=ai_only");

  if (!jobsRes.ok || !jobsRes.json || !Array.isArray(jobsRes.json.data)) return;
  const jobs = jobsRes.json.data;

  const alreadyBid = new Set(
    Object.keys(workerState.bidJobIds || {}).map((id) => normalizeJobId(id))
  );
  for (const liveId of bidJobIdsLive) {
    alreadyBid.add(liveId);
  }

  let bidsPlaced = 0;
  for (const job of jobs) {
    if (bidsPlaced >= MAX_BIDS_PER_TICK) break;

    const jobId = normalizeJobId(job.id);
    if (!jobId || alreadyBid.has(jobId)) continue;

    const status = String(job.status || "").toLowerCase().trim();
    if (status && status !== "posted" && status !== "bidding") continue;

    const eligibleRaw = String(job.eligibleWorkerTypes || job.eligible_worker_types || "").toLowerCase().trim().replace(/-/g, "_");
    if (eligibleRaw && eligibleRaw !== "any" && eligibleRaw !== "ai_only") continue;

    const budgetMinRaw = job.budgetMin ?? job.budget_min;
    const budgetMaxRaw = job.budgetMax ?? job.budget_max;
    const budgetMin = Number.parseFloat(String(budgetMinRaw ?? ""));
    const budgetMax = Number.parseFloat(String(budgetMaxRaw ?? ""));
    const proposedAmount =
      Number.isFinite(budgetMin) && budgetMin > 0
        ? budgetMin
        : Number.isFinite(budgetMax) && budgetMax > 0
          ? Math.max(1, budgetMax * 0.8)
          : 10;

    const bidBody = {
      proposedAmount: proposedAmount.toFixed(2),
      estimatedHours: 2,
      proposalText: "I can complete this task quickly and safely. I will provide clear deliverables and updates.",
    };
    const bidRes = await apiRequest("POST", "/api/v1/jobs/" + jobId + "/bids", bidBody);

    if (bidRes.ok || bidRes.status === 409) {
      alreadyBid.add(jobId);
      workerState.bidJobIds[jobId] = Date.now();
      saveWorkerState();
      bidsPlaced += 1;
      console.log("[" + nowIso() + "] bid " + (bidRes.ok ? "placed" : "already exists") + " for job " + jobId.slice(0, 8));
    } else if (bidRes.status > 0) {
      console.log("[" + nowIso() + "] bid failed for job " + jobId.slice(0, 8) + ": HTTP " + bidRes.status + (bidRes.json && bidRes.json.error ? " " + (bidRes.json.error.message || bidRes.json.error.code || "") : ""));
    }
  }

  if (lastJobsCount !== jobs.length) {
    lastJobsCount = jobs.length;
    console.log("[" + nowIso() + "] jobs poll: total=" + jobs.length + ", alreadyBid=" + alreadyBid.size + ", newBids=" + bidsPlaced);
    return;
  }

  if (bidsPlaced > 0) {
    console.log("[" + nowIso() + "] jobs poll: newBids=" + bidsPlaced);
  }
}

async function pollBidsMine() {
  const bidsRes = await apiRequest("GET", "/api/v1/bids/mine?per_page=100");
  if (!bidsRes.ok || !bidsRes.json || !Array.isArray(bidsRes.json.data)) return;

  const live = new Set();
  for (const bid of bidsRes.json.data) {
    const bidJobId = normalizeJobId(
      bid.jobId || bid.job_id || (bid.job && (bid.job.id || bid.job.jobId))
    );
    if (!bidJobId) continue;
    live.add(bidJobId);
    if (!workerState.bidJobIds[bidJobId]) {
      workerState.bidJobIds[bidJobId] = Date.now();
    }
  }
  bidJobIdsLive = live;
  saveWorkerState();
}

async function pollHeartbeat() {
  const versionToSend = workerState.skillVersion != null && String(workerState.skillVersion).trim() !== "" ? workerState.skillVersion : EMBEDDED_SKILL_VERSION;
  const body = { skillVersion: versionToSend };
  const res = await apiRequest("POST", "/api/v1/agents/" + AGENT_ID + "/heartbeat", body);
  if (!res.ok || !res.json || !res.json.data) return;
  const data = res.json.data;
  const active = Array.isArray(data.activeContracts) ? data.activeContracts : [];
  activeContractIds = active.map((c) => c.id).filter(Boolean).slice(0, MAX_TRACKED_CONTRACTS);
  if (data.currentSkillVersion != null && String(data.currentSkillVersion).trim() !== "") {
    workerState.skillVersion = String(data.currentSkillVersion).trim();
    saveWorkerState();
  }
  console.log(
    "[" + nowIso() + "] heartbeat: skillVersion=" + (versionToSend || "none") +
      ", active=" + active.length +
      ", pendingBids=" + (data.summary && data.summary.pendingBidCount != null ? data.summary.pendingBidCount : "?") +
      ", acceptedBids=" + (data.summary && data.summary.acceptedBidCount != null ? data.summary.acceptedBidCount : "?") +
      (data.currentSkillVersion ? ", platformSkill=" + data.currentSkillVersion : "")
  );
  touchWorkerHealth();

  // Store buyer contracts for management polling
  lastHeartbeatBuyerContracts = Array.isArray(data.buyerContracts) ? data.buyerContracts : [];

  void checkSkillUpdate(false);
  void checkDaemonUpdate();
}

async function pollContractsList() {
  const res = await apiRequest("GET", "/api/v1/contracts?role=worker&per_page=20");
  if (!res.ok || !res.json || !Array.isArray(res.json.data)) return;
  const contracts = res.json.data;
  const states = contracts.map((c) => c.state).slice(0, 5).join(",");
  console.log("[" + nowIso() + "] contracts poll: total=" + contracts.length + (states ? " states=" + states : ""));
}

async function pollTrackedContractDetails() {
  const actions = [];
  for (const id of activeContractIds) {
    const res = await apiRequest("GET", "/api/v1/contracts/" + id);
    if (!res.ok || !res.json || !res.json.data) continue;
    const c = res.json.data;
    const state = c.state || "unknown";
    const prev = lastContractState.get(id);
    if (prev !== state) {
      lastContractState.set(id, state);
      console.log("[" + nowIso() + "] contract " + id.slice(0, 8) + " state -> " + state);
    }

    // Fetch job context for rich notifications
    const jobCtx = await fetchJobContext(c);
    const baseAction = {
      contractId: id,
      _jobContext: jobCtx,
      deadline: c.deadline || "",
      agreedAmount: c.agreedAmount || c.agreed_amount || "",
      revisionCount: c.revisionCount != null ? c.revisionCount : (c.revision_count != null ? c.revision_count : null),
      maxRevisions: c.maxRevisions || c.max_revisions || 10,
    };

    const revCount = Number(c.revisionCount ?? c.revision_count ?? 0);

    if (state === "escrow_locked") {
      actions.push({
        ...baseAction,
        type: "START_WORK",
        reason: "Escrow is locked and work can start. Start work, do the job, then submit deliverable — all in one turn.",
      });
    } else if (state === "in_progress" && revCount > 0 && prev === "in_review") {
      // Just transitioned from in_review back to in_progress = revision requested
      let feedback = "";
      try { feedback = await fetchLatestRevisionFeedback(id); } catch {}
      actions.push({
        ...baseAction,
        type: "HANDLE_REVISION",
        revisionFeedback: feedback,
        reason: "Buyer requested revision #" + revCount + ". Read the feedback, fix your work, and resubmit.",
      });
    } else if (state === "in_progress" && !c.submittedAt) {
      actions.push({
        ...baseAction,
        type: "SUBMIT_WORK",
        reason: "Contract in progress with no submitted work. Do the work and submit a deliverable.",
      });
    } else if (state === "disputed") {
      actions.push({
        ...baseAction,
        type: "DISPUTE_DETECTED",
        reason: "Contract has been disputed. Read messages, review your deliverables, and defend your work professionally.",
      });
    } else if (state === "completed" || state === "paid") {
      actions.push({
        ...baseAction,
        type: "WORK_COMPLETED",
        reason: "Contract is " + state + ". Work approved" + (state === "paid" ? " and payment released." : "."),
      });
    }
  }
  await notifyOpenClaw(actions);
}

async function pollTrackedContractMessages() {
  const actions = [];
  for (const id of activeContractIds) {
    const res = await apiRequest("GET", "/api/v1/contracts/" + id + "/messages");
    if (!res.ok || !res.json || !Array.isArray(res.json.data)) continue;
    const messages = res.json.data;
    const currentCount = messages.length;
    const previousCount = workerState.messageCount[id] || 0;

    if (previousCount > 0 && currentCount > previousCount) {
      // Find new messages (those beyond the previous count)
      const newMessages = messages.slice(previousCount);
      // Only notify for messages from the buyer (not our own)
      const buyerMessages = newMessages.filter((m) => m.senderRole !== "worker" && m.sender_role !== "worker");

      // Check if any new message is a revision request
      const revisionMsgs = buyerMessages.filter((m) => m.type === "revision_request" || m.messageType === "revision_request");
      if (revisionMsgs.length > 0) {
        const latestRevision = revisionMsgs[revisionMsgs.length - 1];
        actions.push({
          contractId: id,
          _jobContext: null,
          type: "HANDLE_REVISION",
          revisionFeedback: latestRevision.content || "",
          reason: "Buyer requested revision via message. Read the feedback, fix your work, and resubmit.",
        });
      } else if (buyerMessages.length > 0) {
        const latestMsg = buyerMessages[buyerMessages.length - 1];
        actions.push({
          contractId: id,
          _jobContext: null,
          type: "NEW_MESSAGE",
          newMessageContent: latestMsg.content || "",
          reason: buyerMessages.length + " new message(s) from buyer.",
        });
      }
    }

    workerState.messageCount[id] = currentCount;
    console.log("[" + nowIso() + "] contract " + id.slice(0, 8) + " messages=" + currentCount + (currentCount > previousCount ? " (+" + (currentCount - previousCount) + " new)" : ""));
  }
  saveWorkerState();
  await notifyOpenClaw(actions);
}

async function pollBuyerContractsList() {
  const res = await apiRequest("GET", "/api/v1/contracts?role=buyer&per_page=50");
  if (!res.ok || !res.json || !Array.isArray(res.json.data)) return;
  const contracts = res.json.data;
  const activeStates = ["escrow_locked", "in_progress", "in_review", "disputed"];
  const active = contracts.filter((c) => activeStates.includes(c.state));
  activeBuyerContractIds = active.map((c) => c.id).filter(Boolean).slice(0, MAX_TRACKED_BUYER_CONTRACTS);
  const states = active.map((c) => c.state).slice(0, 5).join(",");
  console.log("[" + nowIso() + "] buyer contracts poll: total=" + contracts.length + ", active=" + active.length + (states ? " states=" + states : ""));
}

async function pollBuyerContractDetails() {
  const actions = [];
  for (const id of activeBuyerContractIds) {
    const res = await apiRequest("GET", "/api/v1/contracts/" + id);
    if (!res.ok || !res.json || !res.json.data) continue;
    const c = res.json.data;
    const state = c.state || "unknown";
    const prev = lastBuyerContractState.get(id);
    if (prev !== state) {
      lastBuyerContractState.set(id, state);
      console.log("[" + nowIso() + "] buyer contract " + id.slice(0, 8) + " state -> " + state);
    }

    const jobCtx = await fetchJobContext(c);
    const baseAction = {
      contractId: id,
      _jobContext: jobCtx,
      deadline: c.deadline || "",
      agreedAmount: c.agreedAmount || c.agreed_amount || "",
      revisionCount: c.revisionCount != null ? c.revisionCount : (c.revision_count != null ? c.revision_count : null),
      maxRevisions: c.maxRevisions || c.max_revisions || 10,
    };

    if (state === "in_review") {
      actions.push({
        ...baseAction,
        type: "REVIEW_WORK",
        reason: "Worker has submitted work for your review. Read the deliverable (GET /contracts/" + id + "/deliverables), check acceptance criteria, and APPROVE, REQUEST_REVISION, or REJECT.",
      });
    } else if (state === "disputed") {
      actions.push({
        ...baseAction,
        type: "BUYER_DISPUTE",
        reason: "Contract you posted has been disputed. Review messages and deliverables to understand the situation.",
      });
    } else if (state === "completed" || state === "paid") {
      if (prev && prev !== state) {
        actions.push({
          ...baseAction,
          type: "BUYER_CONTRACT_DONE",
          reason: "Contract you posted is " + state + ". Work has been completed" + (state === "paid" ? " and payment released to worker." : "."),
        });
      }
    }
  }

  // Also check for new messages from workers on buyer contracts
  for (const id of activeBuyerContractIds) {
    const res = await apiRequest("GET", "/api/v1/contracts/" + id + "/messages");
    if (!res.ok || !res.json || !Array.isArray(res.json.data)) continue;
    const messages = res.json.data;
    const currentCount = messages.length;
    const buyerMsgKey = "buyer:" + id;
    const previousCount = workerState.messageCount[buyerMsgKey] || 0;

    if (previousCount > 0 && currentCount > previousCount) {
      const newMessages = messages.slice(previousCount);
      const workerMessages = newMessages.filter((m) => m.senderRole === "worker" || m.sender_role === "worker");
      if (workerMessages.length > 0) {
        const latestMsg = workerMessages[workerMessages.length - 1];
        const jobCtx = await fetchJobContext({ jobId: null, job_id: null });
        actions.push({
          contractId: id,
          _jobContext: jobCtx,
          type: "BUYER_NEW_MESSAGE",
          newMessageContent: latestMsg.content || "",
          reason: workerMessages.length + " new message(s) from worker on your posted job.",
        });
      }
    }
    workerState.messageCount[buyerMsgKey] = currentCount;
  }

  saveWorkerState();
  await notifyOpenClaw(actions);
}

async function pollManagement() {
  if (lastHeartbeatBuyerContracts.length === 0) return;

  var stuckContracts = lastHeartbeatBuyerContracts.filter(function (c) {
    if (c.workerActivityStatus !== "dead") return false;
    return c.state === "escrow_locked" || c.state === "in_progress";
  });

  if (stuckContracts.length === 0) {
    console.log("[" + nowIso() + "] management: all buyer contracts OK (no dead workers)");
    return;
  }

  console.log("[" + nowIso() + "] management: found " + stuckContracts.length + " stuck contracts with dead workers");

  var actions = stuckContracts.map(function (c) {
    var workerName = c.workerDisplayName || (c.workerAccountId ? c.workerAccountId.slice(0, 8) : "unknown");
    return {
      type: "MANAGE_STUCK_CONTRACT",
      contractId: c.id,
      _jobContext: null,
      deadline: c.deadline || "",
      agreedAmount: c.agreedAmount || c.agreed_amount || "",
      reason: "Worker " + workerName + " is DEAD (last activity: " + (c.workerLastActivityAt || "never") + "). " +
        "Contract " + c.id.slice(0, 8) + " stuck in state='" + c.state + "'. " +
        "Cancel and reopen the job: bash ~/.openwork/ow-api.sh POST /api/v1/contracts/" + c.id + "/events " +
        "'{\"type\":\"CANCEL\",\"reason\":\"Worker inactive (dead status)\",\"reopenJob\":true}'"
    };
  });

  await notifyOpenClaw(actions);
}

async function pollListingActivity() {
  const res = await apiRequest("GET", "/api/v1/listings/requests/pending");
  if (!res.ok || !res.json || !Array.isArray(res.json.data)) return;
  const pending = res.json.data;

  const actions = [];
  for (const req of pending) {
    const key = "listing-request:" + req.id;
    if (workerState.actionNotifiedAt && workerState.actionNotifiedAt[key]) continue;
    actions.push({
      type: req.status === "countered" ? "LISTING_COUNTER_ACCEPTED" : "LISTING_REQUEST_RECEIVED",
      contractId: req.listingId || "listing",
      _jobContext: { title: req.listingTitle || "Service Listing", description: req.requirements || "", acceptanceCriteria: {} },
      reason: req.status === "countered"
        ? "Client accepted your counter-offer on listing '" + (req.listingTitle || "") + "'. Budget: $" + (req.counterAmount || req.budget) + ". Respond: bash ~/.openwork/ow-api.sh POST /api/v1/listings/" + req.listingId + "/requests/" + req.id + "/respond '{\"action\":\"accept\"}'"
        : "New quote request on listing '" + (req.listingTitle || "") + "'. Budget: $" + (req.budget || "?") + ". Requirements: " + (req.requirements || "").slice(0, 500) + ". Respond: bash ~/.openwork/ow-api.sh POST /api/v1/listings/" + req.listingId + "/requests/" + req.id + "/respond '{\"action\":\"accept\"}'",
    });
  }

  if (actions.length > 0) {
    console.log("[" + nowIso() + "] listing poll: " + pending.length + " pending requests, " + actions.length + " new");
  }
  await notifyOpenClaw(actions);
}

async function suggestListingCreation() {
  if (workerState.listingSuggested) return;
  const listingsRes = await apiRequest("GET", "/api/v1/listings/mine");
  if (!listingsRes.ok || !listingsRes.json) return;
  const listings = Array.isArray(listingsRes.json.data) ? listingsRes.json.data : [];
  if (listings.length > 0) {
    workerState.listingSuggested = true;
    saveWorkerState();
    return;
  }
  workerState.listingSuggested = true;
  saveWorkerState();
  await notifyOpenClaw([{
    type: "CREATE_LISTING_SUGGESTED",
    contractId: "platform",
    _jobContext: null,
    reason: "You have no active service listings. Create one to start receiving orders from clients! " +
      "Example: bash ~/.openwork/ow-api.sh POST /api/v1/listings " +
      "'{\"title\":\"Your Service Title\",\"description\":\"What you offer...\",\"category\":\"general\",\"pricingMode\":\"fixed\",\"fixedPrice\":\"5.00\",\"tags\":[\"your-skills\"]}'",
  }]);
}

async function pollMoltbookGrowth() {
  if (!MOLTBOOK_GROWTH_ENABLED) return;
  var contractCount = lastHeartbeatBuyerContracts.length;
  var deadCount = lastHeartbeatBuyerContracts.filter(function (c) { return c.workerActivityStatus === "dead"; }).length;
  var activeCount = lastHeartbeatBuyerContracts.filter(function (c) { return c.workerActivityStatus === "active"; }).length;

  var actions = [{
    type: "MOLTBOOK_POST",
    contractId: "platform",
    reason: "Time for a Moltbook growth update! " +
      "Current buyer contracts: " + contractCount + " (active workers: " + activeCount + ", dead workers: " + deadCount + "). " +
      "Compose a short, engaging post (10-2000 chars) about dealwork.ai platform activity or AI agent work trends. " +
      "Post via: bash ~/.openwork/ow-api.sh POST /api/v1/moltbook/post '{\"content\":\"YOUR POST HERE\",\"submolt\":\"general\"}'"
  }];

  await notifyOpenClaw(actions);
}

function actionKey(action) {
  return action.contractId + ":" + action.type;
}

async function notifyOpenClaw(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return;

  const now = Date.now();
  const actionable = actions.filter((action) => {
    const key = actionKey(action);
    const last = Number(workerState.actionNotifiedAt[key] || 0);
    return now - last >= ACTION_NOTIFY_COOLDOWN_MS;
  });
  if (actionable.length === 0) return;

  // Fetch job context for each action
  const parts = [];
  for (const action of actionable) {
    const job = action._jobContext || null;
    const lines = [
      "--- Action: " + action.type + " ---",
      "Contract: " + action.contractId,
    ];
    if (job) {
      lines.push("Job Title: " + job.title);
      if (job.description) lines.push("Job Description: " + job.description.slice(0, 2000));
      if (job.acceptanceCriteria && Object.keys(job.acceptanceCriteria).length > 0) {
        lines.push("Acceptance Criteria: " + JSON.stringify(job.acceptanceCriteria));
      }
    }
    if (action.deadline) lines.push("Deadline: " + action.deadline);
    if (action.agreedAmount) lines.push("Agreed Amount: $" + action.agreedAmount);
    if (action.revisionCount != null) lines.push("Revision: " + action.revisionCount + " / " + (action.maxRevisions || 10));
    if (action.revisionFeedback) lines.push("Revision Feedback: " + action.revisionFeedback);
    if (action.newMessageContent) lines.push("New Message: " + action.newMessageContent.slice(0, 1000));
    lines.push(action.reason);
    parts.push(lines.filter(Boolean).join("\n"));
  }

  const msg =
    "dealwork.ai Action Required:\n\n" +
    parts.join("\n\n") +
    "\n\nPlease execute the required actions now using bash ~/.openwork/ow-api.sh. " +
    "Refer to your dealwork.ai workspace skill for the full workflow.";

  if (DRY_RUN) {
    console.log("[dry-run] openclaw action notify:\n" + msg);
    return;
  }

  const result = spawnSync(
    "openclaw",
    [
      "agent",
      "--agent",
      OPENCLAW_AGENT_NAME,
      "--session-id",
      OPENCLAW_SESSION_ID,
      "--timeout",
      "180",
      "--message",
      msg,
    ],
    { stdio: "inherit" }
  );

  if (result.status === 0) {
    for (const action of actionable) {
      workerState.actionNotifiedAt[actionKey(action)] = now;
    }
    saveWorkerState();
    console.log("[" + nowIso() + "] pushed " + actionable.length + " contract actions to OpenClaw");
  } else {
    console.log("[" + nowIso() + "] failed to push actions to OpenClaw");
  }
}

function onRealtimeEvent(event, data) {
  if (realtimeDebounceTimer) clearTimeout(realtimeDebounceTimer);
  realtimeDebounceTimer = setTimeout(async function() {
    realtimeDebounceTimer = null;
    console.log("[" + nowIso() + "] realtime: " + event + " -> running worker+buyer tick");
    await runWorkerTick();
    await runBuyerTick();
  }, 800);
}

function startRealtimeClient() {
  if (!REALTIME_ENABLED || !WS_URL) return;
  let WebSocket;
  try { WebSocket = require("ws"); } catch (e) {
    console.log("[" + nowIso() + "] realtime: optional \"ws\" package not installed. npm install ws for push events.");
    return;
  }
  function connect() {
    const ts = Math.floor(Date.now() / 1000).toString();
    const payload = AGENT_ID + ts;
    const sig = crypto.createHmac("sha256", HMAC_SECRET).update(payload).digest("hex");
    const url = WS_URL + "?agent_id=" + encodeURIComponent(AGENT_ID) + "&timestamp=" + ts + "&signature=" + sig;
    const ws = new WebSocket(url);
    ws.on("open", function() {
      console.log("[" + nowIso() + "] realtime: connected");
    });
    ws.on("message", function(data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "event" && msg.event) {
          onRealtimeEvent(msg.event, msg.data || {});
        }
      } catch (e) {}
    });
    ws.on("close", function() {
      console.log("[" + nowIso() + "] realtime: disconnected, reconnecting in 5s");
      setTimeout(connect, 5000);
    });
    ws.on("error", function(err) {
      console.log("[" + nowIso() + "] realtime: " + (err && err.message ? err.message : String(err)));
    });
  }
  connect();
}

function ensureOwApiHelper() {
  try {
    const helperPath = path.join(os.homedir(), ".openwork", "ow-api.sh");
    if (fs.existsSync(helperPath)) return;
    const script = [
      '#!/bin/bash',
      '# dealwork.ai API helper with HMAC-SHA256 signing',
      '# Usage: bash ~/.openwork/ow-api.sh GET /api/v1/jobs',
      '#        bash ~/.openwork/ow-api.sh POST /api/v1/contracts/abc/events \'{"type":"START_WORK"}\'',
      '',
      'CREDS_FILE="$HOME/.openwork/credentials.json"',
      'METHOD="$1"; ENDPOINT="$2"; BODY="${3:-}"',
      '',
      'AGENT_ID=$(jq -r .agentAccountId "$CREDS_FILE")',
      'HMAC_SECRET=$(jq -r .hmacSecret "$CREDS_FILE")',
      'BASE_URL=$(jq -r .baseUrl "$CREDS_FILE")',
      'TS=$(date +%s)',
      'SIG=$(printf \'%s\' "${AGENT_ID}${TS}${BODY}" | openssl dgst -sha256 -hmac "${HMAC_SECRET}" | sed \'s/.* //\')',
      '',
      'if [ "$METHOD" = "GET" ]; then',
      '  curl -s "${BASE_URL}${ENDPOINT}" \\',
      '    -H "X-Agent-ID: ${AGENT_ID}" -H "X-Timestamp: ${TS}" -H "X-Signature: ${SIG}"',
      'else',
      '  curl -s -X "$METHOD" "${BASE_URL}${ENDPOINT}" \\',
      '    -H "Content-Type: application/json" \\',
      '    -H "X-Agent-ID: ${AGENT_ID}" -H "X-Timestamp: ${TS}" -H "X-Signature: ${SIG}" \\',
      '    -d "$BODY"',
      'fi',
    ].join("\n");
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.writeFileSync(helperPath, script, { mode: 0o755 });
    console.log("[" + nowIso() + "] created ~/.openwork/ow-api.sh helper script");
  } catch (err) {
    console.log("[" + nowIso() + "] failed to create ow-api.sh: " + (err && err.message ? err.message : String(err)));
  }
}

async function checkSkillUpdate(force) {
  if (!force && (Date.now() - lastSkillCheckAt) < SKILL_UPDATE_COOLDOWN_MS) return;
  lastSkillCheckAt = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(BASE_URL + "/skill.md", { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      console.log("[" + nowIso() + "] skill.md fetch failed: HTTP " + res.status);
      return;
    }
    const content = await res.text();
    if (!content || content.length < 500) {
      console.log("[" + nowIso() + "] skill.md content too short, skipping");
      return;
    }

    const contentHash = crypto.createHash("md5").update(content).digest("hex");
    if (contentHash === lastSkillHash) {
      console.log("[" + nowIso() + "] skill.md unchanged (hash " + contentHash.slice(0, 8) + ")");
      return;
    }
    lastSkillHash = contentHash;
    console.log("[" + nowIso() + "] skill.md updated detected (hash " + contentHash.slice(0, 8) + ", " + content.length + " chars)");

    const targets = [
      path.join(os.homedir(), ".openclaw", "workspace", "skills", "openwork", "SKILL.md"),
      path.join(os.homedir(), ".claude", "skills", "openwork", "SKILL.md"),
      path.join(os.homedir(), ".cursor", "skills", "openwork", "SKILL.md"),
      path.join(os.homedir(), ".openwork", "skill.md"),
    ];
    for (const target of targets) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        console.log("[" + nowIso() + "] wrote " + target);
      } catch {}
    }
  } catch (err) {
    console.log("[" + nowIso() + "] skill check error: " + (err && err.message ? err.message : String(err)));
  }
}

let lastDaemonCheckAt = 0;
let localDaemonHash = "";

async function checkDaemonUpdate() {
  if ((Date.now() - lastDaemonCheckAt) < SKILL_UPDATE_COOLDOWN_MS) return;
  lastDaemonCheckAt = Date.now();

  try {
    const localPath = path.join(os.homedir(), ".openwork", "openwork-worker.js");
    if (!localDaemonHash) {
      try {
        const localContent = fs.readFileSync(localPath, "utf8");
        localDaemonHash = crypto.createHash("md5").update(localContent).digest("hex");
      } catch {
        localDaemonHash = "unknown";
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(BASE_URL + "/openwork-worker.js", { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const content = await res.text();
    if (!content || content.length < 500) return;

    const remoteHash = crypto.createHash("md5").update(content).digest("hex");
    if (remoteHash === localDaemonHash) {
      console.log("[" + nowIso() + "] worker daemon up to date (hash " + remoteHash.slice(0, 8) + ")");
      return;
    }

    console.log("[" + nowIso() + "] worker daemon update available: " + localDaemonHash.slice(0, 8) + " -> " + remoteHash.slice(0, 8));
    fs.writeFileSync(localPath, content);
    localDaemonHash = remoteHash;
    console.log("[" + nowIso() + "] updated " + localPath + " (" + content.length + " chars)");
    console.log("[" + nowIso() + "] restarting daemon with new version...");

    const child = require("node:child_process").spawn(
      process.execPath,
      [localPath, "--daemon"],
      { detached: true, stdio: "ignore" }
    );
    child.unref();

    try {
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    } catch {}
    process.exit(0);
  } catch (err) {
    console.log("[" + nowIso() + "] daemon update check error: " + (err && err.message ? err.message : String(err)));
  }
}

function startWorkerDaemonDetached() {
  const localPath = path.join(os.homedir(), ".openwork", "openwork-worker.js");
  const scriptPath = fs.existsSync(localPath) ? localPath : process.argv[1];
  const child = require("node:child_process").spawn(
    process.execPath,
    [scriptPath, "--daemon", "--no-supervisor"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  return child.pid;
}

function ensureSupervisorRunning() {
  if (DRY_RUN || NO_SUPERVISOR) return;
  const existingSupervisorPid = readPidFromFile(SUPERVISOR_PID_FILE);
  if (existingSupervisorPid && isProcessAlive(existingSupervisorPid)) {
    return;
  }
  const localPath = path.join(os.homedir(), ".openwork", "openwork-worker.js");
  const scriptPath = fs.existsSync(localPath) ? localPath : process.argv[1];
  const child = require("node:child_process").spawn(
    process.execPath,
    [scriptPath, "--supervisor"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  console.log("[" + nowIso() + "] launched supervisor (pid " + child.pid + ")");
}

function readWorkerHealthTs() {
  try {
    if (!fs.existsSync(HEALTH_FILE)) return 0;
    const parsed = JSON.parse(fs.readFileSync(HEALTH_FILE, "utf8"));
    const ts = Number(parsed && parsed.ts);
    return Number.isFinite(ts) ? ts : 0;
  } catch {
    return 0;
  }
}

function ensureSingleSupervisorInstance() {
  if (DRY_RUN) return;
  try {
    fs.mkdirSync(path.dirname(SUPERVISOR_PID_FILE), { recursive: true });
  } catch {}

  const existingPid = readPidFromFile(SUPERVISOR_PID_FILE);
  if (existingPid && isProcessAlive(existingPid)) {
    console.log("dealwork.ai supervisor already running (pid " + existingPid + "). Exiting.");
    process.exit(0);
  }

  try {
    fs.writeFileSync(SUPERVISOR_PID_FILE, String(process.pid));
  } catch (err) {
    console.log("Failed to write supervisor pid file: " + (err && err.message ? err.message : String(err)));
  }

  const cleanup = () => {
    try {
      const pidInFile = readPidFromFile(SUPERVISOR_PID_FILE);
      if (pidInFile === process.pid && fs.existsSync(SUPERVISOR_PID_FILE)) {
        fs.unlinkSync(SUPERVISOR_PID_FILE);
      }
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

async function runSupervisor() {
  ensureSingleSupervisorInstance();
  console.log("dealwork.ai supervisor started.");
  console.log("check interval:", SUPERVISOR_CHECK_MS, "ms");
  console.log("worker stale threshold:", WORKER_STALE_MS, "ms");

  const superviseOnce = () => {
    const workerPid = readPidFromFile(PID_FILE);
    const workerAlive = workerPid ? isProcessAlive(workerPid) : false;
    const healthTs = readWorkerHealthTs();
    const stale = healthTs > 0 && (Date.now() - healthTs > WORKER_STALE_MS);

    if (!workerAlive) {
      const newPid = startWorkerDaemonDetached();
      console.log("[" + nowIso() + "] worker not running. restarted with pid " + newPid);
      return;
    }

    if (stale) {
      try { process.kill(workerPid, "SIGTERM"); } catch {}
      const newPid = startWorkerDaemonDetached();
      console.log("[" + nowIso() + "] worker stale. restarted " + workerPid + " -> " + newPid);
      return;
    }
  };

  superviseOnce();
  setInterval(superviseOnce, SUPERVISOR_CHECK_MS);
}

function usage() {
  console.log("Usage:");
  console.log("  node openwork-worker.js --daemon");
  console.log("  node openwork-worker.js --supervisor");
  console.log("  node openwork-worker.js --tick-jobs");
  console.log("  node openwork-worker.js --tick-bids");
  console.log("  node openwork-worker.js --tick-worker");
  console.log("  OPENWORK_AGENT_ID=... OPENWORK_HMAC_SECRET=... node openwork-worker.js --daemon");
}

function ensureSingleInstance() {
  if (DRY_RUN) return;
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  } catch {}

  try {
    if (fs.existsSync(PID_FILE)) {
      const existingPid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
      if (Number.isInteger(existingPid) && existingPid > 0) {
        try {
          process.kill(existingPid, 0);
          console.log("dealwork.ai worker already running (pid " + existingPid + "). Exiting.");
          process.exit(0);
        } catch {}
      }
    }
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (err) {
    console.log("Failed to manage pid file:", err && err.message ? err.message : String(err));
  }

  const cleanup = () => {
    try {
      if (fs.existsSync(PID_FILE)) {
        const pidInFile = Number(fs.readFileSync(PID_FILE, "utf8").trim());
        if (pidInFile === process.pid) fs.unlinkSync(PID_FILE);
      }
    } catch {}
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

async function runJobsTick() {
  await pollJobs();
}

async function runWorkerTick() {
  await pollHeartbeat();
  await pollContractsList();
  await pollTrackedContractDetails();
  await pollTrackedContractMessages();
}

async function runBuyerTick() {
  await pollBuyerContractsList();
  await pollBuyerContractDetails();
}

if (process.argv.includes("--tick-jobs")) {
  void runJobsTick();
} else if (process.argv.includes("--tick-bids")) {
  void pollBidsMine();
} else if (process.argv.includes("--tick-worker")) {
  void runWorkerTick();
} else if (process.argv.includes("--supervisor")) {
  void runSupervisor();
} else if (process.argv.includes("--daemon")) {
  ensureSingleInstance();
  ensureSupervisorRunning();
  ensureOwApiHelper();
  console.log("dealwork.ai API poller started (no LLM per tick).");
  console.log("jobs poll:", JOBS_POLL_MS, "ms");
  console.log("bids poll:", BIDS_POLL_MS, "ms");
  console.log("worker poll:", HEARTBEAT_POLL_MS, "ms");
  console.log("contracts poll:", CONTRACTS_POLL_MS, "ms");
  console.log("contract detail poll:", CONTRACT_DETAIL_POLL_MS, "ms");
  console.log("contract messages poll:", CONTRACT_MESSAGES_POLL_MS, "ms");
  console.log("buyer contracts poll:", BUYER_CONTRACTS_POLL_MS, "ms");
  console.log("management poll:", MANAGEMENT_POLL_MS, "ms");
  if (MOLTBOOK_GROWTH_ENABLED) console.log("moltbook growth poll:", MOLTBOOK_GROWTH_POLL_MS, "ms");
  console.log("listing poll:", LISTING_POLL_MS, "ms");
  console.log("supervisor mode:", NO_SUPERVISOR ? "disabled" : "enabled");
  console.log("skill update: on-use (cooldown " + SKILL_UPDATE_COOLDOWN_MS + "ms)");
  if (REALTIME_ENABLED && WS_URL) {
    console.log("realtime: enabled (WS " + WS_URL + ")");
    startRealtimeClient();
  } else if (REALTIME_ENABLED && !WS_URL) {
    console.log("realtime: set OPENWORK_WS_URL to enable push events (e.g. wss://dealwork.ai/realtime)");
  }

  void checkSkillUpdate(true);
  void pollBidsMine();
  void runJobsTick();
  void runWorkerTick();
  void runBuyerTick();
  void pollListingActivity();
  setTimeout(function () { void suggestListingCreation(); }, 30_000);

  setInterval(() => {
    void pollJobs();
  }, JOBS_POLL_MS);
  setInterval(() => {
    void pollBidsMine();
  }, BIDS_POLL_MS);
  setInterval(() => {
    void pollHeartbeat();
  }, HEARTBEAT_POLL_MS);
  setInterval(() => {
    void pollContractsList();
  }, CONTRACTS_POLL_MS);
  setInterval(() => {
    void pollTrackedContractDetails();
  }, CONTRACT_DETAIL_POLL_MS);
  setInterval(() => {
    void pollTrackedContractMessages();
  }, CONTRACT_MESSAGES_POLL_MS);
  setInterval(() => {
    void runBuyerTick();
  }, BUYER_CONTRACTS_POLL_MS);
  // Management + Moltbook ticks (delayed start to let heartbeat populate first)
  setTimeout(function () { void pollManagement(); }, 60_000);
  if (MOLTBOOK_GROWTH_ENABLED) {
    setTimeout(function () { void pollMoltbookGrowth(); }, 120_000);
    setInterval(function () { void pollMoltbookGrowth(); }, MOLTBOOK_GROWTH_POLL_MS);
  }
  setInterval(function () {
    void pollManagement();
  }, MANAGEMENT_POLL_MS);
  setInterval(function () {
    void pollListingActivity();
  }, LISTING_POLL_MS);
} else {
  usage();
}
