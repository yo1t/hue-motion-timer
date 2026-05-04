const express = require('express');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');

// ─── Load configuration & validation ───
const CONFIG_PATH = path.join(__dirname, 'config.json');

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error(`[Config] Failed to load config.json: ${e.message}`);
  console.error('[Config] Copy config.json.example to config.json and edit it.');
  process.exit(1);
}

// Fill in default values
const DEFAULTS = {
  bridgeIP: '',
  apiKey: '',
  sensorName: '',
  port: 3000,
  pollInterval: 2000,
  resetTimeout: 180000,
  alertMinutes: [15, 20, 30, 45, 60],
  urgentMinute: 20,
  authUser: 'admin',
  authPass: '',
  allowedNetworks: [],
  lang: 'ja',
};

for (const [key, defaultVal] of Object.entries(DEFAULTS)) {
  if (config[key] === undefined || config[key] === null) {
    config[key] = defaultVal;
    console.log(`[Config] Missing '${key}', using default: ${JSON.stringify(defaultVal)}`);
  }
}

// Type checking
const configErrors = [];
if (typeof config.port !== 'number' || config.port < 1 || config.port > 65535)
  configErrors.push('port must be 1-65535');
if (typeof config.pollInterval !== 'number' || config.pollInterval < 500)
  configErrors.push('pollInterval must be >= 500ms');
if (typeof config.resetTimeout !== 'number' || config.resetTimeout < 10000)
  configErrors.push('resetTimeout must be >= 10000ms');
if (!Array.isArray(config.alertMinutes))
  configErrors.push('alertMinutes must be an array');
if (typeof config.urgentMinute !== 'number' || config.urgentMinute < 0)
  configErrors.push('urgentMinute must be >= 0');
if (!Array.isArray(config.allowedNetworks))
  configErrors.push('allowedNetworks must be an array');

if (configErrors.length > 0) {
  console.error('[Config] Validation errors:');
  configErrors.forEach(e => console.error(`  - ${e}`));
  process.exit(1);
}

console.log('[Config] Loaded successfully');

const app = express();

// ─── Security: trust proxy (Apache reverse proxy support) ───
app.set('trust proxy', 'loopback');

// ─── Security: Headers ───
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'");
  next();
});

// ─── Security: IP whitelist ───
const ALLOWED_NETWORKS = config.allowedNetworks || [];

function ipToLong(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
}

function isAllowedIP(clientIP) {
  if (ALLOWED_NETWORKS.length === 0) return true; // Allow all if not configured

  // Convert IPv6-mapped IPv4 (::ffff:192.168.1.1 → 192.168.1.1)
  let ip = clientIP;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);

  const clientLong = ipToLong(ip);

  for (const cidr of ALLOWED_NETWORKS) {
    const [network, bits] = cidr.split('/');
    const mask = bits ? (~0 << (32 - parseInt(bits))) >>> 0 : 0xFFFFFFFF;
    const networkLong = ipToLong(network);
    if ((clientLong & mask) === (networkLong & mask)) return true;
  }
  return false;
}

app.use('/hue', (req, res, next) => {
  if (!isAllowedIP(req.ip)) {
    return res.status(403).send('Access denied');
  }
  next();
});

// ─── Security: Basic authentication ───
const AUTH_USER = config.authUser || 'admin';
const AUTH_PASS = config.authPass || '';

function basicAuth(req, res, next) {
  // Skip if authentication is not configured
  if (!AUTH_PASS) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Hue Motion Timer"');
    return res.status(401).send('Authentication required');
  }

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
  const [user, pass] = decoded.split(':');

  // Timing attack prevention (safe even with length mismatch)
  const userHash = crypto.createHash('sha256').update(user || '').digest();
  const passHash = crypto.createHash('sha256').update(pass || '').digest();
  const expectedUserHash = crypto.createHash('sha256').update(AUTH_USER).digest();
  const expectedPassHash = crypto.createHash('sha256').update(AUTH_PASS).digest();
  const userOk = crypto.timingSafeEqual(userHash, expectedUserHash);
  const passOk = crypto.timingSafeEqual(passHash, expectedPassHash);

  if (userOk && passOk) return next();

  res.setHeader('WWW-Authenticate', 'Basic realm="Hue Motion Timer"');
  return res.status(401).send('Authentication required');
}

app.use('/hue', basicAuth);

// ─── Security: Rate limiting (simple) ───
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 120;      // 120 requests per minute

function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW;
  }

  entry.count++;
  rateLimitMap.set(ip, entry);

  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}

app.use('/hue/api', rateLimit);

// Periodic cleanup of rate limit map (every 1 minute)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 60000);

// ─── Static files & JSON parser ───
app.use('/hue', express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1kb' })); // Body size limit

// Redirect to root
app.get('/hue', (req, res) => {
  if (!req.path.endsWith('/')) return res.redirect('/hue/');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── State management ───
let state = {
  presence: false,
  everDetected: false,
  startTime: null,
  lastNoMotionTime: null,
  lastUpdated: '',
  sensorID: null,
  sensorName: config.sensorName || '',
  bridgeIP: config.bridgeIP || '',
  connected: false,
  logs: [],
  dailyStats: {},
  alerts: {},
};

const MAX_LOGS = 1000;

// ─── Security: IP validation ───
function isValidPrivateIP(ip) {
  if (!ip || typeof ip !== 'string') return false;
  // Allow private IP ranges only
  return /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/.test(ip);
}

function isValidSensorName(name) {
  if (!name || typeof name !== 'string') return false;
  return name.length > 0 && name.length <= 100;
}

// ─── Hue Bridge API ───
function hueRequest(apiPath) {
  return new Promise((resolve, reject) => {
    if (!isValidPrivateIP(config.bridgeIP)) {
      return reject(new Error('Invalid bridge IP'));
    }
    const url = `https://${config.bridgeIP}${apiPath}`;
    const req = https.get(url, { rejectUnauthorized: false, timeout: 5000, agent: false }, (res) => {
      let data = '';
      // Response size limit (1MB)
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 1048576) { req.destroy(); return reject(new Error('Response too large')); }
        data += chunk;
      });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function huePost(apiPath, body) {
  return new Promise((resolve, reject) => {
    if (!isValidPrivateIP(config.bridgeIP)) {
      return reject(new Error('Invalid bridge IP'));
    }
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: config.bridgeIP,
      port: 443,
      path: apiPath,
      method: 'POST',
      rejectUnauthorized: false,
      agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': postData.length }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ─── Resolve sensor ID ───
async function resolveSensorID() {
  if (!config.bridgeIP || !config.apiKey) return false;
  try {
    const sensors = await hueRequest(`/api/${config.apiKey}/sensors`);
    if (Array.isArray(sensors)) return false;
    for (const [id, sensor] of Object.entries(sensors)) {
      if (sensor.type === 'ZLLPresence' && sensor.name === config.sensorName) {
        state.sensorID = id;
        state.sensorName = sensor.name;
        console.log(`[Hue] Resolved sensor -> ID ${id}`);
        return true;
      }
    }
  } catch (e) {
    console.error('[Hue] resolveSensorID error:', e.message);
  }
  return false;
}

// ─── Sensor state polling ───
async function pollSensor() {
  if (!state.sensorID || !config.bridgeIP || !config.apiKey) return;
  try {
    const data = await hueRequest(`/api/${config.apiKey}/sensors/${state.sensorID}`);
    if (Array.isArray(data)) return;

    const newPresence = data.state?.presence || false;
    state.lastUpdated = data.state?.lastupdated || '';
    state.connected = true;

    if (newPresence && !state.everDetected) {
      state.startTime = new Date();
      state.everDetected = true;
      state.alerts = {};
    }

    if (state.everDetected) {
      if (newPresence) {
        state.lastNoMotionTime = null;
      } else if (state.presence && !newPresence) {
        state.lastNoMotionTime = new Date();
      }
    }

    state.presence = newPresence;

    if (state.everDetected && !state.presence && state.lastNoMotionTime) {
      const noMotionMs = Date.now() - state.lastNoMotionTime.getTime();
      if (noMotionMs >= config.resetTimeout) {
        const totalMs = Date.now() - state.startTime.getTime();
        const actualMs = Math.max(0, totalMs - config.resetTimeout);
        saveLog(actualMs);
        state.everDetected = false;
        state.startTime = null;
        state.lastNoMotionTime = null;
        state.alerts = {};
      }
    }
  } catch (e) {
    state.connected = false;
  }
}

// ─── Save log ───
function saveLog(elapsedMs) {
  const now = new Date();
  const entry = {
    date: `${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')}`,
    time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`,
    elapsed: elapsedMs,
  };
  state.logs.unshift(entry);
  if (state.logs.length > MAX_LOGS) state.logs.pop();

  const sec = Math.floor(elapsedMs / 1000);
  if (!state.dailyStats[entry.date]) {
    state.dailyStats[entry.date] = { total: 0, count: 0, max: 0, min: Infinity };
  }
  const ds = state.dailyStats[entry.date];
  ds.total += sec;
  ds.count++;
  if (sec > ds.max) ds.max = sec;
  if (sec < ds.min) ds.min = sec;

  const keys = Object.keys(state.dailyStats).sort().reverse();
  if (keys.length > 730) {
    for (const k of keys.slice(730)) delete state.dailyStats[k];
  }

  saveState();
}

// ─── Persistence ───
const STATE_FILE = path.join(__dirname, 'state.json');

function saveState() {
  try {
    const data = {
      logs: state.logs,
      dailyStats: state.dailyStats,
      // Timer state
      timer: {
        everDetected: state.everDetected,
        startTime: state.startTime ? state.startTime.toISOString() : null,
        lastNoMotionTime: state.lastNoMotionTime ? state.lastNoMotionTime.toISOString() : null,
        presence: state.presence,
        savedAt: new Date().toISOString(),
      }
    };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[State] Save error:', e.message);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state.logs = data.logs || [];
      state.dailyStats = data.dailyStats || {};

      // Restore timer (only if saved within the last 1 minute)
      if (data.timer && data.timer.savedAt) {
        const savedAt = new Date(data.timer.savedAt).getTime();
        const elapsed = Date.now() - savedAt;
        if (elapsed < 60000 && data.timer.everDetected && data.timer.startTime) {
          state.everDetected = true;
          state.startTime = new Date(data.timer.startTime);
          state.presence = data.timer.presence;
          if (data.timer.lastNoMotionTime) {
            state.lastNoMotionTime = new Date(data.timer.lastNoMotionTime);
          }
          console.log(`[Recovery] Timer restored (saved ${Math.round(elapsed/1000)}s ago)`);
        }
      }
    }
  } catch (e) {
    console.error('[State] Load error:', e.message);
  }
}

// ─── API endpoints ───
app.get('/hue/api/state', (req, res) => {
  const now = Date.now();
  let elapsed = 0;
  if (state.everDetected && state.startTime) {
    elapsed = now - state.startTime.getTime();
  }

  const today = new Date();
  const todayKey = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}`;
  const todayStats = state.dailyStats[todayKey];
  const todayMax = todayStats ? todayStats.max * 1000 : 0;
  const dailyMaxDisplay = Math.max(todayMax, elapsed);

  const realMs = elapsed > config.resetTimeout ? elapsed - config.resetTimeout : 0;
  const realMins = Math.floor(realMs / 60000);
  let alertTriggered = null;
  if (state.everDetected && !state.presence) {
    for (const min of config.alertMinutes) {
      if (realMins >= min && !state.alerts[min]) {
        state.alerts[min] = true;
        alertTriggered = min;
        break;
      }
    }
  }

  res.json({
    presence: state.presence,
    everDetected: state.everDetected,
    elapsed,
    connected: state.connected,
    sensorName: state.sensorName,
    // Do not expose bridgeIP as it is internal information
    configured: !!(config.bridgeIP && config.sensorName),
    dailyMax: dailyMaxDisplay,
    todayMaxTime: getTodayMaxTime(),
    alertTriggered,
    m5Online: (Date.now() - m5LastSeen) < 15000,
    lang: config.lang || 'ja',
  });
});

app.get('/hue/api/logs', (req, res) => {
  res.json(state.logs);
});

app.get('/hue/api/daily', (req, res) => {
  res.json(state.dailyStats);
});

// Bridge discovery
app.post('/hue/api/discover', async (req, res) => {
  try {
    const resp = await fetch('https://discovery.meethue.com');
    const data = await resp.json();
    if (data.length > 0) {
      const ip = data[0].internalipaddress;
      if (!isValidPrivateIP(ip)) {
        return res.json({ success: false, error: 'Invalid IP from discovery' });
      }
      config.bridgeIP = ip;
      state.bridgeIP = ip;
      saveConfig();
      res.json({ success: true, ip });
    } else {
      res.json({ success: false, error: 'No bridge found' });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Bridge IP range scan (one at a time, low load)
app.post('/hue/api/scan', async (req, res) => {
  const { range } = req.body;
  if (!range || typeof range !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(range)) {
    return res.status(400).json({ success: false, error: 'Invalid range' });
  }

  // Allow private IP ranges only
  if (!range.startsWith('10.') && !range.startsWith('172.') && !range.startsWith('192.168.')) {
    return res.status(400).json({ success: false, error: 'Private IP range only' });
  }

  console.log(`[Scan] Scanning ${range}.1-254...`);

  function probeIP(ip) {
    return new Promise((resolve) => {
      const req = https.get(`https://${ip}/api/config`, {
        rejectUnauthorized: false,
        timeout: 1000,
        agent: false,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.bridgeid || json.modelid) {
              return resolve({ ip, name: json.name || 'Hue Bridge' });
            }
          } catch (e) {}
          resolve(null);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  // Scan all IPs in parallel (low load since there is typically only one bridge)
  const promises = [];
  for (let i = 1; i <= 254; i++) {
    promises.push(probeIP(`${range}.${i}`));
  }
  const results = await Promise.all(promises);
  const found = results.find(r => r !== null);

  if (found) {
    config.bridgeIP = found.ip;
    state.bridgeIP = found.ip;
    saveConfig();
    console.log(`[Scan] Found: ${found.ip}`);
    return res.json({ success: true, ip: found.ip, name: found.name });
  }

  res.json({ success: false, error: 'No bridge found' });
});

// Manually set bridge IP
app.post('/hue/api/set-bridge', (req, res) => {
  const { ip } = req.body;
  if (!ip || typeof ip !== 'string' || !isValidPrivateIP(ip)) {
    return res.status(400).json({ success: false, error: 'Invalid private IP' });
  }
  config.bridgeIP = ip;
  state.bridgeIP = ip;
  saveConfig();
  res.json({ success: true, ip });
});

// Generate API key
app.post('/hue/api/pair', async (req, res) => {
  try {
    const result = await huePost('/api', { devicetype: 'hue_motion_web#browser' });
    if (result[0]?.success?.username) {
      config.apiKey = result[0].success.username;
      saveConfig();
      res.json({ success: true });
    } else {
      const desc = result[0]?.error?.description || 'Unknown error';
      res.json({ success: false, error: desc });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Sensor list
app.get('/hue/api/sensors', async (req, res) => {
  try {
    const sensors = await hueRequest(`/api/${config.apiKey}/sensors`);
    const list = [];
    for (const [id, s] of Object.entries(sensors)) {
      if (s.type === 'ZLLPresence') list.push({ id, name: s.name });
    }
    res.json(list);
  } catch (e) {
    res.json([]);
  }
});

// Select sensor (with input validation)
app.post('/hue/api/select-sensor', (req, res) => {
  const { name } = req.body;
  if (!isValidSensorName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid sensor name' });
  }
  config.sensorName = name;
  state.sensorName = name;
  saveConfig();
  resolveSensorID().then(ok => res.json({ success: ok }));
});

// Return current configuration (mask sensitive info)
app.get('/hue/api/config', (req, res) => {
  res.json({
    bridgeIP: config.bridgeIP || '',
    hasApiKey: !!config.apiKey,
    sensorName: config.sensorName || '',
    urgentMinute: config.urgentMinute || 20,
    alertMinutes: config.alertMinutes || [15, 20, 30, 45, 60],
  });
});

// Change language
app.post('/hue/api/set-lang', (req, res) => {
  const { lang } = req.body;
  if (lang !== 'ja' && lang !== 'en') {
    return res.status(400).json({ success: false, error: 'Invalid lang (ja or en)' });
  }
  config.lang = lang;
  saveConfig();
  res.json({ success: true, lang });
});

// Change urgent alert minute
app.post('/hue/api/set-urgent', (req, res) => {
  const { minute } = req.body;
  if (typeof minute !== 'number' || minute < 1 || minute > 120) {
    return res.status(400).json({ success: false, error: 'Invalid minute (1-120)' });
  }
  config.urgentMinute = minute;
  saveConfig();
  res.json({ success: true, urgentMinute: minute });
});

// ─── M5Stack remote alert ───
let m5AlertPending = false;
let m5UrgentPending = false;
let m5LastSeen = 0;

app.post('/hue/api/alert', (req, res) => {
  m5AlertPending = true;
  res.json({ success: true });
});

app.post('/hue/api/urgent', (req, res) => {
  m5UrgentPending = true;
  res.json({ success: true });
});

app.get('/hue/api/alert-m5', (req, res) => {
  m5LastSeen = Date.now();
  const urgent = m5UrgentPending;
  const alert = m5AlertPending;
  m5UrgentPending = false;
  m5AlertPending = false;
  res.json({ alert, urgent, urgentMinute: config.urgentMinute || 20 });
});

function getTodayMaxTime() {
  const today = new Date();
  const todayKey = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}`;
  let maxElapsed = 0;
  let maxTime = '';
  for (const log of state.logs) {
    if (log.date === todayKey && log.elapsed > maxElapsed) {
      maxElapsed = log.elapsed;
      maxTime = log.time;
    }
  }
  return maxTime;
}

function saveConfig() {
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
}

// ─── Startup ───
loadState();

async function init() {
  if (config.bridgeIP && config.apiKey && config.sensorName) {
    await resolveSensorID();
  }
  setInterval(pollSensor, config.pollInterval);
  setInterval(saveState, 10000);

  // Security: Listen on localhost only
  app.listen(config.port, '127.0.0.1', () => {
    console.log(`Hue Motion Web running at http://127.0.0.1:${config.port}`);
  });
}

init();
