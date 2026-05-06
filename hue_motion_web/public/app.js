// ─── Internationalization ───
const I18N = {
  ja: {
    waiting: '待機中...', detected: '検知!', noMotion: '未検知',
    status: '状態', sensor: 'センサー', settings: '設定',
    logs: 'ログ', daily: '日別', alert: '🔔 アラート', urgent: '🚨 緊急',
    back: '戻る', discover: '自動探索', scanRange: 'レンジ探索',
    manualSet: '手動設定', pairing: 'ペアリング', getSensors: '一覧取得',
    change: '変更', notSet: '未設定', configured: '設定済み ✓',
    bridgeIP: 'Bridge IP', apiKey: 'API キー', sensorLabel: 'センサー',
    urgentAlert: '緊急アラート', min: '分',
    hueHint: 'Hue Bridge のボタンを押してからクリック',
    scanning: 'スキャン中...', searching: '探索中...',
    settingUp: '設定中...', connecting: '接続中...',
    success: '成功!', failed: '失敗', done: '設定完了',
    autoFail: '自動探索失敗 (手動で入力してください)',
    notFound: '見つかりません', noSensors: 'センサーが見つかりません',
    times: '回', avg: '平均', max: '最大', min2: '最小',
    logTitle: 'ログ', dailyTitle: '日別サマリー',
  },
  en: {
    waiting: 'Waiting...', detected: 'Detected!', noMotion: 'No motion',
    status: 'Status', sensor: 'Sensor', settings: 'Settings',
    logs: 'Logs', daily: 'Daily', alert: '🔔 Alert', urgent: '🚨 Urgent',
    back: 'Back', discover: 'Auto Discover', scanRange: 'Range Scan',
    manualSet: 'Manual Set', pairing: 'Pair', getSensors: 'Get List',
    change: 'Change', notSet: 'Not set', configured: 'Configured ✓',
    bridgeIP: 'Bridge IP', apiKey: 'API Key', sensorLabel: 'Sensor',
    urgentAlert: 'Urgent Alert', min: 'min',
    hueHint: 'Press the Hue Bridge button first',
    scanning: 'Scanning...', searching: 'Searching...',
    settingUp: 'Setting up...', connecting: 'Connecting...',
    success: 'Success!', failed: 'Failed', done: 'Done',
    autoFail: 'Auto-discovery failed (enter manually)',
    notFound: 'Not found', noSensors: 'No sensors found',
    times: 'x', avg: 'Avg', max: 'Max', min2: 'Min',
    logTitle: 'Logs', dailyTitle: 'Daily Summary',
  }
};

let currentLang = 'ja';
let currentSensor = '';
function t(key) { return (I18N[currentLang] || I18N.ja)[key] || key; }

// ─── Screen switching ───
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}
function showMain() { showScreen('main-screen'); }
function showSetup() { loadConfig(); showScreen('setup-screen'); }
function showLogs() { fetchLogs(); showScreen('log-screen'); }
function showDaily() { fetchDaily(); showScreen('daily-screen'); }

function switchSensor() {
  currentSensor = document.getElementById('sensor-select-main').value;
  loadMainChart();
}

let manualSetup = false;

// ─── HTML escape ───
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ─── Time formatting ───
function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function formatHM(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2,'0')}`;
}

// ─── Main screen update ───
let lastPresenceTime = 0;

async function updateState() {
  try {
    const res = await fetch(`/hue/api/state?sensor=${encodeURIComponent(currentSensor)}`);
    const data = await res.json();

    // Update sensor dropdown
    if (data.sensors && data.sensors.length > 0) {
      const sel = document.getElementById('sensor-select-main');
      if (sel.options.length !== data.sensors.length) {
        sel.innerHTML = data.sensors.map(s => `<option value="${esc(s)}" ${s === data.sensorName ? 'selected' : ''}>${esc(s)}</option>`).join('');
      }
      if (!currentSensor) currentSensor = data.sensorName;
    }

    // Connection status
    const dot = document.getElementById('connection');
    dot.className = `dot ${data.connected ? 'connected' : 'disconnected'}`;

    // M5Stack status
    const m5 = document.getElementById('m5-status');
    m5.className = `m5-badge ${data.m5Online ? 'online' : 'offline'}`;

    // Disable alert buttons when M5 is offline
    const alertBtn = document.querySelector('.alert-btn');
    const urgentBtn = document.querySelector('.urgent-btn');
    if (alertBtn) { alertBtn.disabled = !data.m5Online; alertBtn.style.opacity = data.m5Online ? '1' : '0.4'; }
    if (urgentBtn) { urgentBtn.disabled = !data.m5Online; urgentBtn.style.opacity = data.m5Online ? '1' : '0.4'; }

    // Language setting
    if (data.lang && data.lang !== currentLang) {
      currentLang = data.lang;
      applyLang();
    }

    // Redirect to setup screen only if unconfigured and main is visible
    const mainVisible = !document.getElementById('main-screen').classList.contains('hidden');
    if (!data.configured && mainVisible) {
      showSetup();
      return;
    }
    if (!mainVisible) return;

    // Status
    const statusEl = document.getElementById('status');
    if (!data.everDetected) {
      statusEl.textContent = t('waiting');
      statusEl.className = 'status waiting';
    } else if (data.presence || (Date.now() - lastPresenceTime < 5000)) {
      statusEl.textContent = t('detected');
      statusEl.className = 'status detected';
      if (data.presence) lastPresenceTime = Date.now();
    } else {
      statusEl.textContent = t('noMotion');
      statusEl.className = 'status no-motion';
    }

    // Timer
    const timerEl = document.getElementById('timer');
    timerEl.textContent = data.everDetected ? formatElapsed(data.elapsed) : '--:--:--';

    // Daily max
    const maxEl = document.getElementById('daily-max');
    if (data.dailyMax > 0) {
      const today = new Date();
      const dateStr = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}`;
      const timeStr = data.todayMaxTime ? ` (${data.todayMaxTime})` : '';
      maxEl.textContent = `${dateStr} MAX ${formatElapsed(data.dailyMax)}${timeStr}`;
    } else {
      maxEl.textContent = '';
    }

    // Alert
    if (data.alertTriggered) {
      timerEl.classList.add('alert-flash');
      playAlert();
      setTimeout(() => timerEl.classList.remove('alert-flash'), 2000);
    }

    // Clock
    const now = new Date();
    document.getElementById('clock').textContent =
      `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  } catch (e) {
    console.error('Update error:', e);
  }
}

// ─── Alert sound (Web Audio API) ───
function playAlert() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const notes = [392, 392, 392, 494, 440, 392, 440, 494, 392, 392, 494, 587, 659];
  const durations = [0.6, 0.6, 0.2, 0.4, 0.4, 0.6, 0.2, 0.4, 0.6, 0.2, 0.4, 0.4, 0.8];
  let time = ctx.currentTime;
  for (let i = 0; i < notes.length; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = notes[i];
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + durations[i] - 0.05);
    osc.start(time);
    osc.stop(time + durations[i]);
    time += durations[i] + 0.03;
  }
}

// ─── Log display ───
async function fetchLogs() {
  const res = await fetch(`/hue/api/logs?sensor=${encodeURIComponent(currentSensor)}`);
  const logs = await res.json();
  const list = document.getElementById('log-list');
  list.innerHTML = logs.map(log => {
    const sec = Math.floor(log.elapsed / 1000);
    const over10 = sec >= 600;
    return `<div class="log-entry ${over10 ? 'over10' : ''}">
      <div class="dot-mark"></div>
      <span>${esc(log.date)} ${esc(log.time)} ${esc(formatElapsed(log.elapsed))}</span>
    </div>`;
  }).join('');
}

// ─── Daily display ───
async function fetchDaily() {
  const res = await fetch(`/hue/api/daily?sensor=${encodeURIComponent(currentSensor)}`);
  const daily = await res.json();
  const list = document.getElementById('daily-list');
  const entries = Object.entries(daily).sort((a, b) => a[0].localeCompare(b[0])); // oldest first
  list.innerHTML = entries.slice().reverse().map(([date, d]) => {
    const avg = d.count > 0 ? Math.floor(d.total / d.count) : 0;
    const minVal = d.min === Infinity ? 0 : d.min;
    return `<div class="daily-entry">
      <div class="date">${esc(date)}</div>
      <div class="stats">${esc(String(d.count))}${t('times')} ${t('avg')}${esc(formatElapsed(avg*1000))} ${t('max')}${esc(formatElapsed(d.max*1000))} ${t('min2')}${esc(formatElapsed(minVal*1000))}</div>
    </div>`;
  }).join('');

  // チャート描画
  renderDailyChart(entries);
}

let dailyChart = null;
let mainChart = null;

function secToMin(sec) { return Math.round(sec / 60 * 10) / 10; }

function renderDailyChart(entries) {
  const ctx = document.getElementById('daily-chart');
  if (dailyChart) dailyChart.destroy();
  dailyChart = buildChart(ctx, entries);
}

function renderMainChart(entries) {
  const ctx = document.getElementById('main-chart');
  if (!ctx) return;
  if (mainChart) mainChart.destroy();
  mainChart = buildChart(ctx, entries);
}

function buildChart(ctx, entries) {

  // Fill missing dates with 0 for continuous date axis
  const dataMap = {};
  for (const [date, d] of entries) {
    dataMap[date] = d;
  }

  const labels = [];
  const avgData = [];
  const maxData = [];
  const totalData = [];

  if (entries.length > 0) {
    // From first date to today
    const firstParts = entries[0][0].split('/');
    const now = new Date();
    const year = now.getFullYear();
    const start = new Date(year, parseInt(firstParts[0]) - 1, parseInt(firstParts[1]));
    const end = new Date(year, now.getMonth(), now.getDate());

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
      labels.push(key);
      const stat = dataMap[key];
      if (stat && stat.count > 0) {
        const avg = stat.total / stat.count;
        avgData.push(secToMin(avg));
        maxData.push(secToMin(stat.max || 0));
        totalData.push(secToMin(stat.count * avg));
      } else {
        avgData.push(0);
        maxData.push(0);
        totalData.push(0);
      }
    }
  }

  return new Chart(ctx, {
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: '最大 (分)',
          data: maxData,
          backgroundColor: 'rgba(255, 99, 71, 0.6)',
          borderColor: 'rgba(255, 99, 71, 1)',
          borderWidth: 1,
          yAxisID: 'y',
          order: 2,
        },
        {
          type: 'line',
          label: '平均 (分)',
          data: avgData,
          borderColor: '#00d4ff',
          backgroundColor: 'rgba(0, 212, 255, 0.1)',
          borderWidth: 2,
          pointRadius: 4,
          tension: 0.3,
          yAxisID: 'y',
          order: 1,
        },
        {
          type: 'line',
          label: '合計 (分)',
          data: totalData,
          borderColor: '#ffdd00',
          backgroundColor: 'rgba(255, 221, 0, 0.1)',
          borderWidth: 2,
          borderDash: [5, 3],
          pointRadius: 4,
          tension: 0.3,
          yAxisID: 'y1',
          order: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: '#ccc', font: { size: 11 } }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}分`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#aaa', maxTicksLimit: 10, maxRotation: 45 },
          grid: { color: 'rgba(255,255,255,0.1)' }
        },
        y: {
          type: 'linear',
          position: 'left',
          title: { display: true, text: '平均/最大 (分)', color: '#aaa' },
          ticks: { color: '#aaa' },
          grid: { color: 'rgba(255,255,255,0.1)' },
          beginAtZero: true,
        },
        y1: {
          type: 'linear',
          position: 'right',
          title: { display: true, text: '合計 (分)', color: '#ffdd00' },
          ticks: { color: '#ffdd00' },
          grid: { drawOnChartArea: false },
          beginAtZero: true,
        },
      },
    },
  });
}

// ─── Setup ───
async function loadConfig() {
  try {
    const res = await fetch('/hue/api/config');
    const cfg = await res.json();
    document.getElementById('cfg-bridge').textContent = cfg.bridgeIP || t('notSet');
    document.getElementById('cfg-apikey').textContent = cfg.hasApiKey ? t('configured') : t('notSet');

    // Sensor checklist
    const checklist = document.getElementById('sensor-checklist');
    if (cfg.sensors && cfg.sensors.length > 0) {
      checklist.innerHTML = cfg.sensors.map(s => `<div class="sensor-check"><input type="checkbox" checked data-name="${esc(s.name)}"><label>${esc(s.name)}</label></div>`).join('');
      document.getElementById('sensor-alerts-section').style.display = 'block';
      const alertSel = document.getElementById('alert-sensor-select');
      alertSel.innerHTML = cfg.sensors.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
      loadSensorAlerts();
    } else {
      checklist.innerHTML = `<p style="color:#888">${t('notSet')}</p>`;
      document.getElementById('sensor-alerts-section').style.display = 'none';
    }

    updateLangButtons();
  } catch (e) { console.error('Config load error:', e); }
}

async function discover() {
  const status = document.getElementById('bridge-status');
  status.textContent = '探索中...';
  const res = await fetch('/hue/api/discover', { method: 'POST' });
  const data = await res.json();
  if (data.success) {
    status.textContent = `発見: ${data.ip}`;
    document.getElementById('cfg-bridge').textContent = data.ip;
  } else {
    status.textContent = '自動探索失敗 (手動で入力してください)';
  }
}

async function scanRange() {
  const range = document.getElementById('scan-range').value.trim();
  if (!range) return;
  const status = document.getElementById('bridge-status');
  status.textContent = `${range}.1-254 をスキャン中...`;
  try {
    const res = await fetch('/hue/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ range })
    });
    const data = await res.json();
    if (data.success) {
      status.textContent = `発見: ${data.ip} (${data.name})`;
      document.getElementById('cfg-bridge').textContent = data.ip;
    } else {
      status.textContent = `見つかりません`;
    }
  } catch (e) {
    status.textContent = `エラー: ${e.message}`;
  }
}

async function setBridgeIP() {
  const ip = document.getElementById('bridge-ip-input').value.trim();
  if (!ip) return;
  const status = document.getElementById('bridge-status');
  status.textContent = '設定中...';
  const res = await fetch('/hue/api/set-bridge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip })
  });
  const data = await res.json();
  if (data.success) {
    status.textContent = '設定完了';
    document.getElementById('cfg-bridge').textContent = data.ip;
    document.getElementById('bridge-ip-input').value = '';
  } else {
    status.textContent = `失敗: ${data.error}`;
  }
}

async function pair() {
  const status = document.getElementById('pair-status');
  status.textContent = '接続中...';
  const res = await fetch('/hue/api/pair', { method: 'POST' });
  const data = await res.json();
  if (data.success) {
    status.textContent = '成功!';
    document.getElementById('cfg-apikey').textContent = '設定済み ✓';
  } else {
    status.textContent = `失敗: ${data.error}`;
  }
}

async function loadBridgeSensors() {
  const res = await fetch('/hue/api/bridge-sensors');
  const sensors = await res.json();
  const checklist = document.getElementById('sensor-checklist');
  if (sensors.length === 0) {
    checklist.innerHTML = '<p style="color:#f88">No sensors found on Bridge</p>';
    return;
  }
  // Get currently selected sensors
  const currentNames = [...document.querySelectorAll('#sensor-checklist input:checked')].map(el => el.dataset.name);
  checklist.innerHTML = sensors.map(s => {
    const checked = currentNames.includes(s.name) ? 'checked' : '';
    return `<div class="sensor-check"><input type="checkbox" ${checked} data-name="${esc(s.name)}"><label>${esc(s.name)}</label></div>`;
  }).join('');
}

async function saveSensorSelection() {
  const checked = [...document.querySelectorAll('#sensor-checklist input:checked')];
  const sensors = checked.map(el => ({
    name: el.dataset.name,
    alertMinutes: [15, 20, 30, 45, 60],
    urgentMinute: 20,
  }));
  const status = document.getElementById('sensor-status');
  status.textContent = 'Saving...';
  const res = await fetch('/hue/api/set-sensors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sensors })
  });
  const data = await res.json();
  status.textContent = data.success ? t('done') : `${t('failed')}: ${data.error}`;
  if (data.success) {
    loadConfig();
    if (!currentSensor && data.sensors?.length) currentSensor = data.sensors[0];
  }
}

function loadSensorAlerts() {
  const name = document.getElementById('alert-sensor-select').value;
  fetch('/hue/api/config').then(r => r.json()).then(cfg => {
    const s = cfg.sensors.find(x => x.name === name);
    if (s) {
      document.getElementById('alert-minutes-input').value = s.alertMinutes.join(',');
      document.getElementById('urgent-minute-input').value = s.urgentMinute;
    }
  });
}

async function saveSensorAlerts() {
  const name = document.getElementById('alert-sensor-select').value;
  const alertStr = document.getElementById('alert-minutes-input').value;
  const alertMinutes = alertStr.split(',').map(s => parseInt(s.trim())).filter(n => n > 0);
  const urgentMinute = parseInt(document.getElementById('urgent-minute-input').value) || 0;
  const status = document.getElementById('alert-status');
  status.textContent = 'Saving...';
  const res = await fetch('/hue/api/set-sensor-alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, alertMinutes, urgentMinute })
  });
  const data = await res.json();
  status.textContent = data.success ? t('done') : `${t('failed')}: ${data.error}`;
}

async function setLang(lang) {
  const res = await fetch('/hue/api/set-lang', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang })
  });
  const data = await res.json();
  if (data.success) { currentLang = lang; applyLang(); updateLangButtons(); }
}

function updateLangButtons() {
  document.getElementById('btn-lang-ja').classList.toggle('lang-active', currentLang === 'ja');
  document.getElementById('btn-lang-en').classList.toggle('lang-active', currentLang === 'en');
}

// ─── Initialization ───
setInterval(updateState, 1000);
updateState();
loadMainChart();
applyLang();

// Refresh main screen chart every 5 minutes
setInterval(loadMainChart, 300000);

function applyLang() {
  // Main screen
  document.querySelector('#main-screen .label').textContent = t('status');
  document.querySelectorAll('.bottom-nav button')[0].textContent = t('settings');
  document.querySelectorAll('.bottom-nav button')[1].textContent = t('logs');
  document.querySelectorAll('.bottom-nav button')[2].textContent = t('daily');
  document.querySelectorAll('.bottom-nav button')[3].textContent = t('alert');
  document.querySelectorAll('.bottom-nav button')[4].textContent = t('urgent');
  // Log screen
  document.querySelector('#log-screen h2').textContent = t('logTitle');
  document.querySelector('#log-screen .back-btn').textContent = t('back');
  // Daily screen
  document.querySelector('#daily-screen h2').textContent = t('dailyTitle');
  document.querySelector('#daily-screen .back-btn').textContent = t('back');
  // Settings screen
  document.querySelector('#setup-screen h1').textContent = t('settings');
  document.querySelector('#setup-screen .back-btn').textContent = t('back');
}

async function loadMainChart() {
  try {
    const res = await fetch(`/hue/api/daily?sensor=${encodeURIComponent(currentSensor)}`);
    const daily = await res.json();
    const entries = Object.entries(daily).sort((a, b) => a[0].localeCompare(b[0]));
    renderMainChart(entries);
  } catch (e) {}
}

// ─── Remote alert ───
async function sendAlert() {
  try {
    await fetch('/hue/api/alert', { method: 'POST' });
    playAlert();
  } catch (e) {
    console.error('Alert error:', e);
  }
}

async function sendUrgent() {
  try {
    await fetch('/hue/api/urgent', { method: 'POST' });
    playEvaAlert();
  } catch (e) {
    console.error('Urgent error:', e);
  }
}

function playEvaAlert() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let time = ctx.currentTime;
  for (let i = 0; i < 4; i++) {
    // High note B5
    const osc1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    osc1.connect(g1); g1.connect(ctx.destination);
    osc1.frequency.value = 988;
    osc1.type = 'square';
    g1.gain.setValueAtTime(0.4, time);
    osc1.start(time); osc1.stop(time + 0.3);
    time += 0.35;
    // Low note F#5
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.connect(g2); g2.connect(ctx.destination);
    osc2.frequency.value = 740;
    osc2.type = 'square';
    g2.gain.setValueAtTime(0.4, time);
    osc2.start(time); osc2.stop(time + 0.3);
    time += 0.35;
  }
  // Final long high note
  const osc3 = ctx.createOscillator();
  const g3 = ctx.createGain();
  osc3.connect(g3); g3.connect(ctx.destination);
  osc3.frequency.value = 988;
  osc3.type = 'square';
  g3.gain.setValueAtTime(0.4, time);
  g3.gain.exponentialRampToValueAtTime(0.01, time + 0.6);
  osc3.start(time); osc3.stop(time + 0.6);
}
