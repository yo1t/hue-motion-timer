const express = require('express');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

// Fill in defaults
const DEFAULTS = {
  bridgeIP: '', apiKey: '', port: 3000, pollInterval: 2000,
  resetTimeout: 180000, authUser: 'admin', authPass: '',
  allowedNetworks: [], lang: 'ja',
  sensors: [],  // [{name, id, alertMinutes, urgentMinute}]
};
for (const [key, def] of Object.entries(DEFAULTS)) {
  if (config[key] === undefined || config[key] === null) config[key] = def;
}

// Migrate from old single-sensor config
if (config.sensorName && config.sensors.length === 0) {
  config.sensors.push({
    name: config.sensorName,
    id: null,
    alertMinutes: config.alertMinutes || [15, 20, 30, 45, 60],
    urgentMinute: config.urgentMinute || 20,
  });
  delete config.sensorName;
  delete config.alertMinutes;
  delete config.urgentMinute;
  saveConfig();
  console.log('[Config] Migrated single sensor to multi-sensor format');
}

// Validation
const errs = [];
if (typeof config.port !== 'number' || config.port < 1 || config.port > 65535) errs.push('port: 1-65535');
if (typeof config.pollInterval !== 'number' || config.pollInterval < 500) errs.push('pollInterval: >= 500');
if (typeof config.resetTimeout !== 'number' || config.resetTimeout < 10000) errs.push('resetTimeout: >= 10000');
if (!Array.isArray(config.sensors)) errs.push('sensors must be array');
if (!Array.isArray(config.allowedNetworks)) errs.push('allowedNetworks must be array');
if (errs.length) { console.error('[Config] Errors:', errs); process.exit(1); }
console.log(`[Config] Loaded (${config.sensors.length} sensors)`);

const app = express();
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
function ipToLong(ip) { return ip.split('.').reduce((a, o) => (a << 8) + parseInt(o), 0) >>> 0; }
function isAllowedIP(clientIP) {
  if (ALLOWED_NETWORKS.length === 0) return true;
  let ip = clientIP;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const cl = ipToLong(ip);
  for (const cidr of ALLOWED_NETWORKS) {
    const [net, bits] = cidr.split('/');
    const mask = bits ? (~0 << (32 - parseInt(bits))) >>> 0 : 0xFFFFFFFF;
    if ((cl & mask) === (ipToLong(net) & mask)) return true;
  }
  return false;
}
app.use('/hue', (req, res, next) => {
  if (!isAllowedIP(req.ip)) return res.status(403).send('Access denied');
  next();
});

// ─── Security: Basic auth ───
const AUTH_USER = config.authUser || 'admin';
const AUTH_PASS = config.authPass || '';
function basicAuth(req, res, next) {
  if (!AUTH_PASS) return next();
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Hue Motion Timer"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  const uOk = crypto.timingSafeEqual(crypto.createHash('sha256').update(user||'').digest(), crypto.createHash('sha256').update(AUTH_USER).digest());
  const pOk = crypto.timingSafeEqual(crypto.createHash('sha256').update(pass||'').digest(), crypto.createHash('sha256').update(AUTH_PASS).digest());
  if (uOk && pOk) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Hue Motion Timer"');
  return res.status(401).send('Authentication required');
}
app.use('/hue', basicAuth);

// ─── Security: Rate limiting ───
const rlMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip, now = Date.now();
  const e = rlMap.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > e.resetAt) { e.count = 0; e.resetAt = now + 60000; }
  e.count++; rlMap.set(ip, e);
  if (e.count > 120) return res.status(429).json({ error: 'Too many requests' });
  next();
}
app.use('/hue/api', rateLimit);
setInterval(() => { const now = Date.now(); for (const [k, v] of rlMap) { if (now > v.resetAt) rlMap.delete(k); } }, 60000);

app.use('/hue', express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2kb' }));
app.get('/hue', (req, res) => { if (!req.path.endsWith('/')) return res.redirect('/hue/'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ─── Multi-sensor state management ───
// state.sensors = { "sensorName": { presence, everDetected, startTime, lastNoMotionTime, alerts, logs[], dailyStats{} } }
let state = { sensors: {} };
const MAX_LOGS = 1000;

function getSensorState(name) {
  if (!state.sensors[name]) {
    state.sensors[name] = {
      presence: false, everDetected: false,
      startTime: null, lastNoMotionTime: null,
      alerts: {}, logs: [], dailyStats: {},
    };
  }
  return state.sensors[name];
}

// ─── Hue Bridge API ───
function isValidPrivateIP(ip) {
  if (!ip || typeof ip !== 'string') return false;
  return /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/.test(ip);
}

function hueRequest(apiPath) {
  return new Promise((resolve, reject) => {
    if (!isValidPrivateIP(config.bridgeIP)) return reject(new Error('Invalid bridge IP'));
    const req = https.get(`https://${config.bridgeIP}${apiPath}`, { rejectUnauthorized: false, timeout: 5000, agent: false }, (res) => {
      let data = '', size = 0;
      res.on('data', c => { size += c.length; if (size > 1048576) { req.destroy(); return reject(new Error('Too large')); } data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function huePost(apiPath, body) {
  return new Promise((resolve, reject) => {
    if (!isValidPrivateIP(config.bridgeIP)) return reject(new Error('Invalid bridge IP'));
    const d = JSON.stringify(body);
    const req = https.request({ hostname: config.bridgeIP, port: 443, path: apiPath, method: 'POST', rejectUnauthorized: false, agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': d.length } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(d); req.end();
  });
}

// ─── Resolve sensor IDs ───
async function resolveAllSensors() {
  if (!config.bridgeIP || !config.apiKey || config.sensors.length === 0) return;
  try {
    const sensors = await hueRequest(`/api/${config.apiKey}/sensors`);
    if (Array.isArray(sensors)) return;
    for (const s of config.sensors) {
      for (const [id, sensor] of Object.entries(sensors)) {
        if (sensor.type === 'ZLLPresence' && sensor.name === s.name) {
          s.id = id;
          break;
        }
      }
    }
    console.log(`[Hue] Resolved ${config.sensors.filter(s => s.id).length}/${config.sensors.length} sensors`);
  } catch (e) {
    console.error('[Hue] resolveAllSensors error:', e.message);
  }
}

// ─── Sensor polling (all sensors) ───
async function pollAllSensors() {
  if (!config.bridgeIP || !config.apiKey) return;
  for (const sensor of config.sensors) {
    if (!sensor.id) continue;
    try {
      const data = await hueRequest(`/api/${config.apiKey}/sensors/${sensor.id}`);
      if (Array.isArray(data)) continue;
      const ss = getSensorState(sensor.name);
      const newPresence = data.state?.presence || false;

      if (newPresence && !ss.everDetected) {
        ss.startTime = new Date();
        ss.everDetected = true;
        ss.alerts = {};
      }

      if (ss.everDetected) {
        if (newPresence) { ss.lastNoMotionTime = null; }
        else if (!newPresence && !ss.lastNoMotionTime) { ss.lastNoMotionTime = new Date(); }
      }

      ss.presence = newPresence;
      ss.connected = true;

      // Reset after no-motion timeout
      if (ss.everDetected && !ss.presence && ss.lastNoMotionTime) {
        const noMotionMs = Date.now() - ss.lastNoMotionTime.getTime();
        if (noMotionMs >= config.resetTimeout) {
          const totalMs = Date.now() - ss.startTime.getTime();
          const actualMs = Math.max(0, totalMs - config.resetTimeout);
          saveLog(sensor.name, actualMs);
          ss.everDetected = false;
          ss.startTime = null;
          ss.lastNoMotionTime = null;
          ss.alerts = {};
        }
      }
    } catch (e) {
      const ss = getSensorState(sensor.name);
      ss.connected = false;
    }
  }
}

// ─── Log saving (per sensor) ───
function saveLog(sensorName, elapsedMs) {
  const ss = getSensorState(sensorName);
  const now = new Date();
  const entry = {
    date: `${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')}`,
    time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`,
    elapsed: elapsedMs,
  };
  ss.logs.unshift(entry);
  if (ss.logs.length > MAX_LOGS) ss.logs.pop();

  const sec = Math.floor(elapsedMs / 1000);
  if (!ss.dailyStats[entry.date]) ss.dailyStats[entry.date] = { total: 0, count: 0, max: 0, min: Infinity };
  const ds = ss.dailyStats[entry.date];
  ds.total += sec; ds.count++;
  if (sec > ds.max) ds.max = sec;
  if (sec < ds.min) ds.min = sec;

  const keys = Object.keys(ss.dailyStats).sort().reverse();
  if (keys.length > 730) { for (const k of keys.slice(730)) delete ss.dailyStats[k]; }

  saveState();
}

// ─── Persistence ───
const STATE_FILE = path.join(__dirname, 'state.json');

function saveState() {
  try {
    const data = { sensors: {} };
    for (const [name, ss] of Object.entries(state.sensors)) {
      data.sensors[name] = {
        logs: ss.logs, dailyStats: ss.dailyStats,
        timer: {
          everDetected: ss.everDetected,
          startTime: ss.startTime ? ss.startTime.toISOString() : null,
          lastNoMotionTime: ss.lastNoMotionTime ? ss.lastNoMotionTime.toISOString() : null,
          presence: ss.presence,
          savedAt: new Date().toISOString(),
        }
      };
    }
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error('[State] Save error:', e.message); }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    // Migrate from old single-sensor state
    if (data.logs && !data.sensors) {
      const name = config.sensors[0]?.name;
      if (name) {
        state.sensors[name] = { presence: false, everDetected: false, startTime: null, lastNoMotionTime: null, alerts: {}, logs: data.logs || [], dailyStats: data.dailyStats || {} };
        if (data.timer && data.timer.savedAt) {
          const elapsed = Date.now() - new Date(data.timer.savedAt).getTime();
          if (elapsed < 60000 && data.timer.everDetected && data.timer.startTime) {
            const ss = state.sensors[name];
            ss.everDetected = true;
            ss.startTime = new Date(data.timer.startTime);
            ss.presence = data.timer.presence;
            if (data.timer.lastNoMotionTime) ss.lastNoMotionTime = new Date(data.timer.lastNoMotionTime);
          }
        }
        console.log('[State] Migrated single-sensor state');
      }
      return;
    }

    // Multi-sensor state
    if (data.sensors) {
      for (const [name, saved] of Object.entries(data.sensors)) {
        const ss = getSensorState(name);
        ss.logs = saved.logs || [];
        ss.dailyStats = saved.dailyStats || {};
        if (saved.timer && saved.timer.savedAt) {
          const elapsed = Date.now() - new Date(saved.timer.savedAt).getTime();
          if (elapsed < 60000 && saved.timer.everDetected && saved.timer.startTime) {
            ss.everDetected = true;
            ss.startTime = new Date(saved.timer.startTime);
            ss.presence = saved.timer.presence;
            if (saved.timer.lastNoMotionTime) ss.lastNoMotionTime = new Date(saved.timer.lastNoMotionTime);
            console.log(`[Recovery] ${name}: timer restored`);
          }
        }
      }
    }
  } catch (e) { console.error('[State] Load error:', e.message); }
}

// ─── API endpoints ───

// Get state for a specific sensor
app.get('/hue/api/state', (req, res) => {
  const sensorName = req.query.sensor || (config.sensors[0]?.name) || '';
  const ss = getSensorState(sensorName);
  const sensorCfg = config.sensors.find(s => s.name === sensorName);

  const now = Date.now();
  let elapsed = 0;
  if (ss.everDetected && ss.startTime) elapsed = now - ss.startTime.getTime();

  const todayKey = `${String(new Date().getMonth()+1).padStart(2,'0')}/${String(new Date().getDate()).padStart(2,'0')}`;
  const todayStats = ss.dailyStats[todayKey];
  const todayMax = todayStats ? todayStats.max * 1000 : 0;
  const dailyMaxDisplay = Math.max(todayMax, elapsed);

  // Alert check
  const alertMinutes = sensorCfg?.alertMinutes || [15, 20, 30, 45, 60];
  const urgentMinute = sensorCfg?.urgentMinute || 20;
  const realMs = elapsed > config.resetTimeout ? elapsed - config.resetTimeout : 0;
  const realMins = Math.floor(realMs / 60000);
  let alertTriggered = null;
  if (ss.everDetected && !ss.presence) {
    for (const min of alertMinutes) {
      if (realMins >= min && !ss.alerts[min]) {
        ss.alerts[min] = true;
        alertTriggered = min;
        break;
      }
    }
  }

  // Today's max time from logs
  let todayMaxTime = '';
  let maxElapsed = 0;
  for (const log of ss.logs) {
    if (log.date === todayKey && log.elapsed > maxElapsed) {
      maxElapsed = log.elapsed;
      todayMaxTime = log.time;
    }
  }

  res.json({
    sensorName,
    presence: ss.presence,
    everDetected: ss.everDetected,
    elapsed,
    connected: ss.connected || false,
    configured: !!(config.bridgeIP && config.sensors.length > 0),
    sensors: config.sensors.map(s => s.name),
    dailyMax: dailyMaxDisplay,
    todayMaxTime,
    alertTriggered,
    m5Online: (Date.now() - m5LastSeen) < 15000,
    lang: config.lang || 'ja',
    sensorOverview: config.sensors.map(s => {
      const ss = getSensorState(s.name);
      let elapsed = 0;
      if (ss.everDetected && ss.startTime) elapsed = Date.now() - ss.startTime.getTime();
      return { name: s.name, active: ss.everDetected, elapsed };
    }),
  });
});

// Get logs for a sensor
app.get('/hue/api/logs', (req, res) => {
  const name = req.query.sensor || (config.sensors[0]?.name) || '';
  res.json(getSensorState(name).logs);
});

// Get daily stats for a sensor
app.get('/hue/api/daily', (req, res) => {
  const name = req.query.sensor || (config.sensors[0]?.name) || '';
  res.json(getSensorState(name).dailyStats);
});

// Get config (masked)
app.get('/hue/api/config', (req, res) => {
  res.json({
    bridgeIP: config.bridgeIP || '',
    hasApiKey: !!config.apiKey,
    sensors: config.sensors.map(s => ({ name: s.name, alertMinutes: s.alertMinutes, urgentMinute: s.urgentMinute })),
    lang: config.lang || 'ja',
  });
});

// Bridge discovery
app.post('/hue/api/discover', async (req, res) => {
  try {
    const resp = await fetch('https://discovery.meethue.com');
    const data = await resp.json();
    if (data.length > 0) {
      const ip = data[0].internalipaddress;
      if (!isValidPrivateIP(ip)) return res.json({ success: false, error: 'Invalid IP' });
      config.bridgeIP = ip; saveConfig();
      res.json({ success: true, ip });
    } else { res.json({ success: false, error: 'No bridge found' }); }
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Bridge IP range scan
app.post('/hue/api/scan', async (req, res) => {
  const { range } = req.body;
  if (!range || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(range)) return res.status(400).json({ success: false, error: 'Invalid range' });
  if (!range.startsWith('10.') && !range.startsWith('172.') && !range.startsWith('192.168.')) return res.status(400).json({ success: false, error: 'Private IP only' });

  function probeIP(ip) {
    return new Promise(resolve => {
      const req = https.get(`https://${ip}/api/config`, { rejectUnauthorized: false, timeout: 1000, agent: false }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { const j = JSON.parse(data); if (j.bridgeid || j.modelid) return resolve({ ip, name: j.name || 'Hue Bridge' }); } catch(e){} resolve(null); });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  const promises = []; for (let i = 1; i <= 254; i++) promises.push(probeIP(`${range}.${i}`));
  const results = await Promise.all(promises);
  const found = results.find(r => r !== null);
  if (found) { config.bridgeIP = found.ip; saveConfig(); return res.json({ success: true, ip: found.ip, name: found.name }); }
  res.json({ success: false, error: 'No bridge found' });
});

// Set bridge IP manually
app.post('/hue/api/set-bridge', (req, res) => {
  const { ip } = req.body;
  if (!isValidPrivateIP(ip)) return res.status(400).json({ success: false, error: 'Invalid private IP' });
  config.bridgeIP = ip; saveConfig();
  res.json({ success: true, ip });
});

// Pair (generate API key)
app.post('/hue/api/pair', async (req, res) => {
  try {
    const result = await huePost('/api', { devicetype: 'hue_motion_web#browser' });
    if (result[0]?.success?.username) { config.apiKey = result[0].success.username; saveConfig(); res.json({ success: true }); }
    else { res.json({ success: false, error: result[0]?.error?.description || 'Unknown' }); }
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Get all ZLLPresence sensors from bridge
app.get('/hue/api/bridge-sensors', async (req, res) => {
  try {
    const sensors = await hueRequest(`/api/${config.apiKey}/sensors`);
    const list = [];
    for (const [id, s] of Object.entries(sensors)) {
      if (s.type === 'ZLLPresence') list.push({ id, name: s.name });
    }
    res.json(list);
  } catch (e) { res.json([]); }
});

// Update sensor list (add/remove sensors with their alert config)
app.post('/hue/api/set-sensors', (req, res) => {
  const { sensors } = req.body;
  if (!Array.isArray(sensors)) return res.status(400).json({ success: false, error: 'sensors must be array' });
  if (sensors.length > 20) return res.status(400).json({ success: false, error: 'Max 20 sensors' });
  // Validate each sensor
  for (const s of sensors) {
    if (!s.name || typeof s.name !== 'string' || s.name.length > 100) return res.status(400).json({ success: false, error: 'Invalid sensor name' });
    if (!Array.isArray(s.alertMinutes)) s.alertMinutes = [15, 20, 30, 45, 60];
    if (typeof s.urgentMinute !== 'number') s.urgentMinute = 20;
  }
  config.sensors = sensors.map(s => ({ name: s.name, id: null, alertMinutes: s.alertMinutes, urgentMinute: s.urgentMinute }));
  saveConfig();
  resolveAllSensors();
  res.json({ success: true, sensors: config.sensors.map(s => s.name) });
});

// Update alert config for a specific sensor
app.post('/hue/api/set-sensor-alerts', (req, res) => {
  const { name, alertMinutes, urgentMinute } = req.body;
  const sensor = config.sensors.find(s => s.name === name);
  if (!sensor) return res.status(404).json({ success: false, error: 'Sensor not found' });
  if (Array.isArray(alertMinutes)) sensor.alertMinutes = alertMinutes;
  if (typeof urgentMinute === 'number') sensor.urgentMinute = urgentMinute;
  saveConfig();
  res.json({ success: true });
});

// Change language
app.post('/hue/api/set-lang', (req, res) => {
  const { lang } = req.body;
  if (lang !== 'ja' && lang !== 'en') return res.status(400).json({ success: false, error: 'Invalid lang' });
  config.lang = lang; saveConfig();
  res.json({ success: true, lang });
});

// ─── M5Stack remote alert ───
let m5AlertPending = false, m5UrgentPending = false, m5LastSeen = 0;
app.post('/hue/api/alert', (req, res) => { m5AlertPending = true; res.json({ success: true }); });
app.post('/hue/api/urgent', (req, res) => { m5UrgentPending = true; res.json({ success: true }); });
app.get('/hue/api/alert-m5', (req, res) => {
  m5LastSeen = Date.now();
  const urgent = m5UrgentPending, alert = m5AlertPending;
  m5UrgentPending = false; m5AlertPending = false;
  const urgentMin = config.sensors[0]?.urgentMinute || 20;
  res.json({ alert, urgent, urgentMinute: urgentMin });
});

function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }

// ─── Startup ───
loadState();

async function init() {
  if (config.bridgeIP && config.apiKey) await resolveAllSensors();
  setInterval(pollAllSensors, config.pollInterval);
  setInterval(saveState, 10000);
  app.listen(config.port, '127.0.0.1', () => { console.log(`Hue Motion Web running at http://127.0.0.1:${config.port}`); });
}
init();
