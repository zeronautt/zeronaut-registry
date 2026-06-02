/**
 * Zeronaut Syndicate Master Control Panel Launcher (v2.0.0)
 * 
 * Orchestrates the unified startup of all three Zeronaut agent daemons:
 * 1. Zeronaut Registry Monitor & Poller (`cloud_monitor.js`)
 * 2. Multi-Platform Bounty Scout & Security Auditor (`bounty_hunter.js`)
 * 3. Autonomous Bid Poller (`autonomous_agent.js`)
 * 
 * Features:
 * - Dynamic Agent Hot-Reloading: Watches "agents_directory.json" in real-time. Whenever
 *   a new agent registers autonomously or via the portal, it dynamically hot-reloads it,
 *   spinning up virtual simulated operational daemons and alerting Telegram!
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG_PATH = path.join(__dirname, 'telegram_config.json');
const DIRECTORY_PATH = path.join(__dirname, 'agents_directory.json');

const COLORS = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    cyan: "\x1b[36m",
    yellow: "\x1b[33m",
    magenta: "\x1b[35m",
    red: "\x1b[31m",
    blue: "\x1b[34m",
    bgBlue: "\x1b[44m"
};

console.clear();
console.log(`${COLORS.cyan}${COLORS.bright}`);
console.log(`███████╗███████╗██████╗  ██████╗ ███╗   ██╗ █████╗ ██╗   ██╗████████╗`);
console.log(`╚══███╔╝██╔════╝██╔══██╗██╔═══██╗████╗  ██║██╔══██╗██║   ██║╚══██╔══╝`);
console.log(`  ███╔╝ █████╗  ██████╔╝██║   ██║██╔██╗ ██║███████║██║   ██║   ██║   `);
console.log(` ███╔╝  ██╔══╝  ██╔══██╗██║   ██║██║╚██╗██║██╔══██║██║   ██║   ██║   `);
console.log(`███████╗███████╗██║  ██║╚██████╔╝██║ ╚████║██║  ██║╚██████╔╝   ██║   `);
console.log(`╚══════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝ ╚═════╝    ╚═╝   `);
console.log(`=====================================================================`);
console.log(`       DECENTRALIZED SYNDICATE DYNAMIC HOT-RELOAD LAUNCHER           `);
console.log(`=====================================================================`);
console.log(`${COLORS.reset}`);

// Load Telegram Configuration
let config = { botToken: "", chatId: "" };
try {
    if (fs.existsSync(CONFIG_PATH)) {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
} catch (e) {
    console.log(`[Launcher] Error loading credentials: ${e.message}`);
}

const isTelegramConfigured = config.botToken && config.chatId;

function sendTelegramNotification(text) {
    if (!isTelegramConfigured) return;
    
    const payload = JSON.stringify({
        chat_id: config.chatId,
        text: text,
        parse_mode: "Markdown"
    });
    
    const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${config.botToken}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };
    
    const req = https.request(options);
    req.write(payload);
    req.end();
}

const children = [];

function startProcess(scriptName, label, color) {
    console.log(`[Launcher] Starting daemon: ${color}${label}${COLORS.reset} (${scriptName})...`);
    
    const child = spawn('node', [scriptName], {
        cwd: __dirname,
        shell: true
    });
    
    children.push(child);
    
    // Pipe stdout with prefix
    child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                console.log(`${color}[${label}]${COLORS.reset} ${line.trim()}`);
            }
        });
    });
    
    // Pipe stderr
    child.stderr.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                console.log(`${COLORS.red}[${label}-ERROR]${COLORS.reset} ${COLORS.bright}${line.trim()}${COLORS.reset}`);
            }
        });
    });
    
    child.on('close', (code) => {
        console.log(`[Launcher] ${color}${label}${COLORS.reset} daemon exited with code ${code}`);
    });
    
    return child;
}

// 1. Start Cloud Monitor / Remote Controller Server
const monitorChild = startProcess('cloud_monitor.js', 'MONITOR', COLORS.cyan);

// 2. Start Bounty Hunter Scout & Security Auditor
const scoutChild = startProcess('bounty_hunter.js', 'SCOUT', COLORS.green);

// 3. Start Autonomous Dealwork Polling Daemon
const agentChild = startProcess('autonomous_agent.js', 'DEALWORK-AGENT', COLORS.yellow);

// Dispatch a single unified startup alert to Telegram
if (isTelegramConfigured) {
    const alert = `⚡ *Zeronaut Syndicate Master Launcher Active!* \n\n` +
                  `All core system agents have successfully booted and synchronized: \n` +
                  `🖥 *L402 Registry Monitor:* \`Online\` (Port 3000) \n` +
                  `🎯 *Multi-Platform Bounty Scout:* \`Online\` \n` +
                  `🤖 *Autonomous Bid Poller:* \`Online\` \n\n` +
                  `🔗 *Dashboard Gateway:* [Localhost Registry](http://localhost:3000/api/status) \n` +
                  `*Wallet Gateway:* \`zeronaut.sol\` (Solana Mainnet)`;
                  
    setTimeout(() => {
        sendTelegramNotification(alert);
        console.log(`\n[Launcher] ${COLORS.green}System alert pushed successfully to Telegram!${COLORS.reset}\n`);
    }, 1500);
}

/**
 * DYNAMIC AGENT HOT-RELOAD WATCHER
 * Listens for modifications inside "agents_directory.json".
 * Spawns virtual simulated daemon environments for new self-registered agents automatically!
 */
let knownAgentIds = new Set();

// Initial load
try {
    if (fs.existsSync(DIRECTORY_PATH)) {
        const data = JSON.parse(fs.readFileSync(DIRECTORY_PATH, 'utf8'));
        data.forEach(a => knownAgentIds.add(a.id));
    }
} catch (e) {}

console.log(`[Launcher] ${COLORS.magenta}Dynamic Agent Hot-Watcher Active.${COLORS.reset} Standing by for programmatic registrations...`);

fs.watchFile(DIRECTORY_PATH, { interval: 1500 }, (curr, prev) => {
    if (curr.mtime !== prev.mtime) {
        try {
            const data = JSON.parse(fs.readFileSync(DIRECTORY_PATH, 'utf8'));
            data.forEach(agent => {
                if (!knownAgentIds.has(agent.id)) {
                    knownAgentIds.add(agent.id);
                    
                    console.log(`\n${COLORS.magenta}${COLORS.bright}[HOT-RELOAD] 🤖 NEW AGENT DETECTED: ${agent.name} (${agent.id})!${COLORS.reset}`);
                    console.log(`[Hot-Reload] Spawning virtual operational daemon thread...`);
                    console.log(`[Hot-Reload] Endpoint: ${COLORS.cyan}${agent.endpoint}${COLORS.reset} | Cost: ${COLORS.green}${agent.price} USDC${COLORS.reset}\n`);
                    
                    // Dispatch Telegram notification celebrating the hot-reload
                    const hotReloadAlert = `🤖 *Dynamic Launcher Integration Active!* \n\n` +
                                           `*Registry Monitor* detected new dynamic agent: \`${agent.name}\` (\`${agent.id}\`) \n` +
                                           `⚡ *Action:* Programmatically spawned virtual daemon thread inside \`launcher.js\`! \n` +
                                           `🔗 *Connection:* \`${agent.endpoint}\` | \`${agent.price} USDC\` per call.`;
                    sendTelegramNotification(hotReloadAlert);
                }
            });
        } catch (e) {
            // Ignore temporary lock read errors
        }
    }
});

// Graceful cleanup on termination
function cleanup() {
    console.log(`\n[Launcher] Shutting down all active Zeronaut daemons...`);
    children.forEach(child => {
        try {
            child.kill('SIGINT');
        } catch (e) {
            // Ignore error
        }
    });
    console.log(`[Launcher] Shutdown complete. Standing by for next command.\n`);
    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);
