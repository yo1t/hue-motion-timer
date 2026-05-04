// ─── 画面切り替え ───
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}
function showMain() { showScreen('main-screen'); }
function showSetup() { loadConfig(); showScreen('setup-screen'); }
function showLogs() { fetchLogs(); showScreen('log-screen'); }
function showDaily() { fetchDaily(); showScreen('daily-screen'); }

let manualSetup = false;

// ─── HTML エスケープ ───
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ─── 時刻フォーマット ───
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

// ─── メイン画面更新 ───
let lastPresenceTime = 0;

async function updateState() {
  try {
    const res = await fetch('/hue/api/state');
    const data = await res.json();

    // 接続状態
    const dot = document.getElementById('connection');
    dot.className = `dot ${data.connected ? 'connected' : 'disconnected'}`;

    // M5Stack ステータス
    const m5 = document.getElementById('m5-status');
    m5.className = `m5-badge ${data.m5Online ? 'online' : 'offline'}`;

    // 未設定で初回表示のみセットアップ画面に遷移
    const mainVisible = !document.getElementById('main-screen').classList.contains('hidden');
    if (!data.configured && mainVisible) {
      showSetup();
      return;
    }
    if (!mainVisible) return;

    // センサー名
    document.getElementById('sensor-name').textContent = `センサー: ${data.sensorName}`;

    // ステータス
    const statusEl = document.getElementById('status');
    if (!data.everDetected) {
      statusEl.textContent = '待機中...';
      statusEl.className = 'status waiting';
    } else if (data.presence || (Date.now() - lastPresenceTime < 5000)) {
      statusEl.textContent = '検知!';
      statusEl.className = 'status detected';
      if (data.presence) lastPresenceTime = Date.now();
    } else {
      statusEl.textContent = '未検知';
      statusEl.className = 'status no-motion';
    }

    // タイマー
    const timerEl = document.getElementById('timer');
    timerEl.textContent = data.everDetected ? formatElapsed(data.elapsed) : '--:--:--';

    // 日次最大
    const maxEl = document.getElementById('daily-max');
    if (data.dailyMax > 0) {
      const today = new Date();
      const dateStr = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}`;
      const timeStr = data.todayMaxTime ? ` (${data.todayMaxTime})` : '';
      maxEl.textContent = `${dateStr} MAX ${formatElapsed(data.dailyMax)}${timeStr}`;
    } else {
      maxEl.textContent = '';
    }

    // アラート
    if (data.alertTriggered) {
      timerEl.classList.add('alert-flash');
      playAlert();
      setTimeout(() => timerEl.classList.remove('alert-flash'), 2000);
    }

    // 時計
    const now = new Date();
    document.getElementById('clock').textContent =
      `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  } catch (e) {
    console.error('Update error:', e);
  }
}

// ─── アラート音 (Web Audio API) ───
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

// ─── ログ表示 ───
async function fetchLogs() {
  const res = await fetch('/hue/api/logs');
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

// ─── 日別表示 ───
async function fetchDaily() {
  const res = await fetch('/hue/api/daily');
  const daily = await res.json();
  const list = document.getElementById('daily-list');
  const entries = Object.entries(daily).sort((a, b) => a[0].localeCompare(b[0])); // 古い順
  list.innerHTML = entries.slice().reverse().map(([date, d]) => {
    const avg = d.count > 0 ? Math.floor(d.total / d.count) : 0;
    const minVal = d.min === Infinity ? 0 : d.min;
    return `<div class="daily-entry">
      <div class="date">${esc(date)}</div>
      <div class="stats">${esc(String(d.count))}回 平均${esc(formatElapsed(avg*1000))} 最大${esc(formatElapsed(d.max*1000))} 最小${esc(formatElapsed(minVal*1000))}</div>
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

  const labels = entries.map(([date]) => date);
  const avgData = entries.map(([, d]) => d.count > 0 ? secToMin(d.total / d.count) : 0);
  const maxData = entries.map(([, d]) => secToMin(d.max || 0));
  const totalData = entries.map(([, d]) => {
    const avg = d.count > 0 ? d.total / d.count : 0;
    return secToMin(d.count * avg);
  });

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
          ticks: { color: '#aaa' },
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

// ─── セットアップ ───
async function loadConfig() {
  try {
    const res = await fetch('/hue/api/config');
    const cfg = await res.json();
    document.getElementById('cfg-bridge').textContent = cfg.bridgeIP || '未設定';
    document.getElementById('cfg-apikey').textContent = cfg.hasApiKey ? '設定済み ✓' : '未設定';
    document.getElementById('cfg-sensor').textContent = cfg.sensorName || '未設定';
    document.getElementById('cfg-urgent').textContent = `${cfg.urgentMinute || 20}分`;
    document.getElementById('sensor-select-row').style.display = 'none';
  } catch (e) {
    console.error('Config load error:', e);
  }
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

async function loadSensors() {
  const res = await fetch('/hue/api/sensors');
  const sensors = await res.json();
  const select = document.getElementById('sensor-select');
  if (sensors.length === 0) {
    select.innerHTML = '<option>センサーが見つかりません</option>';
  } else {
    select.innerHTML = sensors.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
  }
  document.getElementById('sensor-select-row').style.display = 'flex';
}

async function setUrgentMinute() {
  const val = parseInt(document.getElementById('urgent-input').value);
  if (!val || val < 1 || val > 120) return;
  const status = document.getElementById('urgent-status');
  status.textContent = '設定中...';
  const res = await fetch('/hue/api/set-urgent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minute: val })
  });
  const data = await res.json();
  if (data.success) {
    status.textContent = '設定完了';
    document.getElementById('cfg-urgent').textContent = `${val}分`;
    document.getElementById('urgent-input').value = '';
  } else {
    status.textContent = `失敗: ${data.error}`;
  }
}

async function selectSensor() {
  const name = document.getElementById('sensor-select').value;
  if (!name) return;
  const res = await fetch('/hue/api/select-sensor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const data = await res.json();
  if (data.success) {
    document.getElementById('cfg-sensor').textContent = name;
    document.getElementById('sensor-select-row').style.display = 'none';
  }
}

// ─── 初期化 ───
setInterval(updateState, 1000);
updateState();
loadMainChart();

// 5分ごとにメイン画面のグラフを更新
setInterval(loadMainChart, 300000);

async function loadMainChart() {
  try {
    const res = await fetch('/hue/api/daily');
    const daily = await res.json();
    const entries = Object.entries(daily).sort((a, b) => a[0].localeCompare(b[0]));
    renderMainChart(entries);
  } catch (e) {}
}

// ─── リモートアラート ───
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
    // 高音 B5
    const osc1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    osc1.connect(g1); g1.connect(ctx.destination);
    osc1.frequency.value = 988;
    osc1.type = 'square';
    g1.gain.setValueAtTime(0.4, time);
    osc1.start(time); osc1.stop(time + 0.3);
    time += 0.35;
    // 低音 F#5
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.connect(g2); g2.connect(ctx.destination);
    osc2.frequency.value = 740;
    osc2.type = 'square';
    g2.gain.setValueAtTime(0.4, time);
    osc2.start(time); osc2.stop(time + 0.3);
    time += 0.35;
  }
  // 最後の長い高音
  const osc3 = ctx.createOscillator();
  const g3 = ctx.createGain();
  osc3.connect(g3); g3.connect(ctx.destination);
  osc3.frequency.value = 988;
  osc3.type = 'square';
  g3.gain.setValueAtTime(0.4, time);
  g3.gain.exponentialRampToValueAtTime(0.01, time + 0.6);
  osc3.start(time); osc3.stop(time + 0.6);
}
