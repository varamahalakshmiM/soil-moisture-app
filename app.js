/**
 * TerraMoist Live - Adafruit IO Soil Moisture Application Logic
 */

// State Management
const state = {
  username: localStorage.getItem('tm_username') || 'Varu_Mohan',
  aioKey: localStorage.getItem('tm_aioKey') || 'aio_avrW11gSxr7fSsXIcKQMklk1hBdp',
  feedKey: localStorage.getItem('tm_feedKey') || 'soil-moisture',
  pollInterval: parseInt(localStorage.getItem('tm_pollInterval') || '3000'),
  chartLimit: 50,
  minThreshold: 35,
  maxThreshold: 75,
  
  // Runtime Data
  rawFeedData: [],
  availableFeeds: [],
  latestValue: null,
  lastFetchTimestamp: null,
  timerId: null,
  countdown: 3,
  countdownTimerId: null,
  chart: null,
  currentPlantPreset: 'houseplants'
};

// Plant Presets Configuration
const plantPresets = {
  houseplants: { min: 40, max: 70, name: 'General Houseplants', advice: 'Keep soil consistently moist but not soggy. Water when top 1 inch feels dry.' },
  succulents: { min: 15, max: 35, name: 'Succulents & Cacti', advice: 'Requires dry soil cycles. Water deeply only when completely dry (under 20%).' },
  tropical: { min: 50, max: 80, name: 'Tropical Plants', advice: 'Prefers high moisture and ambient humidity. Do not let soil drop below 45%.' },
  vegetables: { min: 45, max: 75, name: 'Garden Vegetables', advice: 'Needs steady moisture for healthy fruit and foliage development.' },
  bonsai: { min: 35, max: 60, name: 'Bonsai Trees', advice: 'Requires precise moisture control. Check moisture twice daily.' },
  custom: { min: 35, max: 75, name: 'Custom Range', advice: 'Configured via settings tab.' }
};

// DOM Initialization
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize Lucide Icons
  if (window.lucide) {
    lucide.createIcons();
  }

  // Load Saved Form Settings
  document.getElementById('settingUsername').value = state.username;
  document.getElementById('settingAioKey').value = state.aioKey;
  document.getElementById('settingInterval').value = state.pollInterval;
  document.getElementById('headerUsername').textContent = state.username;
  document.getElementById('currentFeedName').textContent = state.feedKey;
  document.getElementById('metaFeedKey').textContent = state.feedKey;

  // Initialize Chart
  initMoistureChart();

  // 1. Auto-Discover All Adafruit IO User Feeds First
  await fetchUserFeeds();

  // 2. Fetch Live Telemetry from Active Feed
  await fetchLiveTelemetry();

  // 3. Start Polling Loop
  restartPollingTimer();
});

// Switch Active View Tab
function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.mobile-nav-item').forEach(el => el.classList.remove('active'));

  const targetTab = document.getElementById(tabId);
  if (targetTab) {
    targetTab.classList.add('active');
  }

  const desktopBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  if (desktopBtn) desktopBtn.classList.add('active');

  const mobileBtn = document.querySelector(`.mobile-nav-item[data-tab="${tabId}"]`);
  if (mobileBtn) mobileBtn.classList.add('active');

  if (window.lucide) lucide.createIcons();
}

// Fetch All Feeds from User Account
async function fetchUserFeeds() {
  const url = `https://io.adafruit.com/api/v2/${state.username}/feeds?aio_key=${encodeURIComponent(state.aioKey)}`;
  const select = document.getElementById('settingFeedSelect');
  const feedCountEl = document.getElementById('availableFeedCount');

  try {
    const res = await fetch(url, {
      headers: { 'X-AIO-Key': state.aioKey }
    });
    
    if (!res.ok) {
      console.warn('Feed discovery response not ok:', res.status);
      return;
    }

    const feeds = await res.json();
    state.availableFeeds = feeds;

    if (Array.isArray(feeds) && feeds.length > 0) {
      if (select) {
        select.innerHTML = '';
        feeds.forEach(f => {
          const opt = document.createElement('option');
          opt.value = f.key;
          opt.textContent = `${f.name} (key: ${f.key})`;
          if (f.key === state.feedKey) opt.selected = true;
          select.appendChild(opt);
        });
      }

      if (feedCountEl) {
        feedCountEl.textContent = `${feeds.length} feeds found`;
      }

      // If current feedKey is not in the list, set to first feed key (e.g. soil-moisture)
      const feedKeys = feeds.map(f => f.key);
      if (!feedKeys.includes(state.feedKey)) {
        state.feedKey = feedKeys[0];
        localStorage.setItem('tm_feedKey', state.feedKey);
        document.getElementById('currentFeedName').textContent = state.feedKey;
        document.getElementById('metaFeedKey').textContent = state.feedKey;
      }
    }
  } catch (e) {
    console.error('Feed discovery error:', e);
  }
}

// Fetch Live Telemetry from Active Adafruit IO Feed
async function fetchLiveTelemetry() {
  const spinner = document.getElementById('refreshSpinner');
  if (spinner) spinner.classList.add('spin-animation');

  const startTime = performance.now();

  // Read the feed directly from Adafruit IO.
  // The API returns the newest records first, but we also sort by
  // created_at below so the dashboard always uses the actual newest value.
  const url = `https://io.adafruit.com/api/v2/${encodeURIComponent(state.username)}/feeds/${encodeURIComponent(state.feedKey)}/data?limit=${state.chartLimit}&aio_key=${encodeURIComponent(state.aioKey)}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'X-AIO-Key': state.aioKey,
        'Accept': 'application/json'
      }
    });

    const latency = Math.round(performance.now() - startTime);

    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.text();
        if (body) detail = ` - ${body.slice(0, 200)}`;
      } catch (_) {}
      throw new Error(`Adafruit IO HTTP ${response.status}${detail}`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error('Adafruit IO returned an unexpected response.');
    }

    // Always identify the newest Adafruit IO record by timestamp.
    data.sort((a, b) =>
      new Date(b.created_at || 0).getTime() -
      new Date(a.created_at || 0).getTime()
    );

    state.rawFeedData = data;
    state.lastFetchTimestamp = new Date();

    updateConnectionStatus(true, `${latency} ms`);

    if (data.length === 0) {
      state.latestValue = null;
      setTextIfPresent('moistureValue', '--');
      setTextIfPresent('moistureStatusText', 'NO DATA IN FEED');
      updateConnectionStatus(false, 'Adafruit IO feed has no data');
      return;
    }

    // THIS is the value displayed on the gauge:
    // the newest value currently stored in the Adafruit IO feed.
    const latestRecord = data[0];
    const latestValue = Number.parseFloat(latestRecord.value);

    if (!Number.isFinite(latestValue)) {
      throw new Error(`Latest Adafruit IO value is not numeric: ${latestRecord.value}`);
    }

    state.latestValue = latestValue;

    updateGauge(latestValue);
    updateMetrics(data);
    updateChart(data);
    renderHistoryTable(data);
    checkThresholdAlerts(latestValue);

    // Show exactly when Adafruit IO recorded the value.
    const latestTime = latestRecord.created_at
      ? new Date(latestRecord.created_at).toLocaleString()
      : 'unknown time';
    setTextIfPresent('lastUpdatedTime', `Adafruit IO: ${latestTime}`);

    console.log('Adafruit IO latest soil-moisture:', {
      value: latestValue,
      created_at: latestRecord.created_at,
      id: latestRecord.id,
      feed: state.feedKey
    });

  } catch (error) {
    console.error('Adafruit IO Fetch Error:', error);
    updateConnectionStatus(false, error.message);
    showToast(`Adafruit IO Sync Failed: ${error.message}`, 'error');
  } finally {
    if (spinner) spinner.classList.remove('spin-animation');
    resetCountdown();
  }
}

// Switch Feed Key Dynamically
function changeFeedKey(newKey) {
  state.feedKey = newKey;
  localStorage.setItem('tm_feedKey', newKey);
  document.getElementById('currentFeedName').textContent = newKey;
  document.getElementById('metaFeedKey').textContent = newKey;
  showToast(`Switched active feed to: ${newKey}`, 'info');
  fetchLiveTelemetry();
}

// Connection Status Updater
function updateConnectionStatus(isOnline, latencyText) {
  const badge = document.getElementById('connectionBadge');
  const text = document.getElementById('connectionText');
  const latencyEl = document.getElementById('apiLatency');

  if (isOnline) {
    if (badge) badge.className = 'status-badge';
    if (text) text.textContent = 'Live Syncing';
    if (latencyEl) latencyEl.textContent = `${latencyText}`;
  } else {
    if (badge) badge.className = 'status-badge offline';
    if (text) text.textContent = 'Sync Error';
    if (latencyEl) latencyEl.textContent = `${latencyText}`;
  }
}

// Update Gauge Needle and Percentage
function updateGauge(val) {
  const valueEl = document.getElementById('moistureValue');
  const needleGroup = document.getElementById('needleGroup');
  const statusTag = document.getElementById('moistureStatusTag');
  const statusText = document.getElementById('moistureStatusText');
  const statusIcon = document.getElementById('moistureStatusIcon');
  const lastUpdatedEl = document.getElementById('lastUpdatedTime');

  if (isNaN(val)) return;

  // Clamp value 0 to 100
  const clampedVal = Math.max(0, Math.min(100, val));
  valueEl.textContent = clampedVal.toFixed(1);

  // Map 0 - 100% to -90 deg to +90 deg rotation angle
  const angle = -90 + (clampedVal / 100) * 180;
  if (needleGroup) {
    needleGroup.setAttribute('transform', `rotate(${angle} 130 130)`);
  }

  // Update Status Pill Tag & Colors
  if (clampedVal < 25) {
    statusTag.className = 'moisture-tag tag-dry';
    statusText.textContent = 'CRITICALLY DRY';
    if (statusIcon) statusIcon.setAttribute('data-lucide', 'alert-circle');
  } else if (clampedVal >= 25 && clampedVal < state.minThreshold) {
    statusTag.className = 'moisture-tag tag-low';
    statusText.textContent = 'NEEDS WATERING';
    if (statusIcon) statusIcon.setAttribute('data-lucide', 'droplet');
  } else if (clampedVal >= state.minThreshold && clampedVal <= state.maxThreshold) {
    statusTag.className = 'moisture-tag tag-optimal';
    statusText.textContent = 'OPTIMAL MOISTURE';
    if (statusIcon) statusIcon.setAttribute('data-lucide', 'check-circle-2');
  } else {
    statusTag.className = 'moisture-tag tag-wet';
    statusText.textContent = 'SATURATED / WET';
    if (statusIcon) statusIcon.setAttribute('data-lucide', 'waves');
  }

  if (window.lucide) lucide.createIcons();

  if (lastUpdatedEl) {
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    lastUpdatedEl.textContent = `Updated: ${timeStr}`;
  }

  updatePlantAdvice(clampedVal);
}

// Calculate & Update Overview Metrics
function setTextIfPresent(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function updateMetrics(data) {
  const numericValues = data.map(d => parseFloat(d.value)).filter(v => !isNaN(v));
  if (numericValues.length === 0) return;

  const maxVal = Math.max(...numericValues);
  const minVal = Math.min(...numericValues);
  const avgVal = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;

  setTextIfPresent('metricMax', `${maxVal.toFixed(1)}%`);
  setTextIfPresent('metricMin', `${minVal.toFixed(1)}%`);
  setTextIfPresent('metricAvg', `${avgVal.toFixed(1)}%`);
  // This element is optional in the current dashboard.
  setTextIfPresent('totalDataCount', `${data.length} records`);
}

// Check Thresholds & Display Alert Banner
function checkThresholdAlerts(val) {
  const alertBanner = document.getElementById('alertBanner');
  const alertMsg = document.getElementById('alertMessage');

  if (val < state.minThreshold) {
    alertMsg.textContent = `Warning: Soil moisture (${val.toFixed(1)}%) is below minimum target of ${state.minThreshold}%. Water plant soon!`;
    alertBanner.style.display = 'flex';
  } else if (val > state.maxThreshold) {
    alertMsg.textContent = `Caution: Soil moisture (${val.toFixed(1)}%) exceeds maximum target of ${state.maxThreshold}%. Avoid over-watering!`;
    alertBanner.style.display = 'flex';
  } else {
    alertBanner.style.display = 'none';
  }
}

function dismissAlert() {
  document.getElementById('alertBanner').style.display = 'none';
}

// Chart Initialization & Rendering
function initMoistureChart() {
  const canvas = document.getElementById('moistureChart');
  if (!canvas) return;

  // Chart.js is loaded from the CDN in index.html. If it has not finished
  // loading yet, wait for it instead of crashing the dashboard.
  if (typeof Chart === 'undefined') {
    setTextIfPresent('chartStatus', 'Loading chart library...');
    window.addEventListener('load', () => {
      if (!state.chart) initMoistureChart();
    }, { once: true });
    return;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const oldChart = Chart.getChart(canvas);
  if (oldChart) oldChart.destroy();

  const gradient = ctx.createLinearGradient(0, 0, 0, 320);
  gradient.addColorStop(0, 'rgba(0, 242, 254, 0.35)');
  gradient.addColorStop(1, 'rgba(0, 242, 254, 0.0)');

  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Soil Moisture (%)',
        data: [],
        borderColor: '#00F2FE',
        borderWidth: 3,
        backgroundColor: gradient,
        fill: true,
        tension: 0.35,
        pointBackgroundColor: '#00F2FE',
        pointBorderColor: '#090D16',
        pointBorderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 7,
        spanGaps: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => items.length ? items[0].label : '',
            label: (context) => `Moisture: ${Number(context.parsed.y).toFixed(1)}%`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#9CA3AF', maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#9CA3AF', callback: (val) => `${val}%` }
        }
      }
    }
  });

  updateChart(state.rawFeedData || []);
}

function updateChart(data) {
  const canvas = document.getElementById('moistureChart');
  const status = document.getElementById('chartStatus');

  if (!canvas) return;

  // If Chart.js became available after app startup, initialize now.
  if (!state.chart) {
    if (typeof Chart === 'undefined') {
      if (status) status.textContent = 'Chart library is still loading...';
      return;
    }
    initMoistureChart();
  }
  if (!state.chart) return;

  const points = (Array.isArray(data) ? data : [])
    .map(item => ({
      time: new Date(item.created_at),
      value: Number.parseFloat(item.value),
      id: item.id
    }))
    .filter(p => Number.isFinite(p.value) && !Number.isNaN(p.time.getTime()))
    .sort((a, b) => a.time - b.time);

  if (points.length === 0) {
    state.chart.data.labels = [];
    state.chart.data.datasets[0].data = [];
    state.chart.update('none');
    if (status) status.textContent = 'No historical soil-moisture data found in Adafruit IO.';
    return;
  }

  const labels = points.map(p => p.time.toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }));
  const values = points.map(p => p.value);

  state.chart.data.labels = labels;
  state.chart.data.datasets[0].data = values;
  state.chart.update('none');

  if (status) {
    status.textContent = `${points.length} Adafruit IO readings • ${points[0].time.toLocaleTimeString()} → ${points[points.length - 1].time.toLocaleTimeString()}`;
  }
}

function setChartLimit(limit, btnEl) {
  state.chartLimit = limit;
  document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  fetchLiveTelemetry();
}

// Render History Table
function renderHistoryTable(data) {
  const tbody = document.getElementById('historyTableBody');
  if (!tbody) return;

  tbody.innerHTML = '';

  data.forEach((item, idx) => {
    const val = parseFloat(item.value);
    const date = new Date(item.created_at).toLocaleString();

    let tagClass = 'tag-optimal';
    let tagText = 'Optimal';
    if (val < 25) { tagClass = 'tag-dry'; tagText = 'Dry'; }
    else if (val < state.minThreshold) { tagClass = 'tag-low'; tagText = 'Needs Water'; }
    else if (val > state.maxThreshold) { tagClass = 'tag-wet'; tagText = 'Saturated'; }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${date}</td>
      <td style="font-weight:700; color:var(--accent-primary);">${val.toFixed(1)}%</td>
      <td><span class="moisture-tag ${tagClass}" style="padding:0.2rem 0.6rem; font-size:0.7rem;">${tagText}</span></td>
      <td style="color:var(--text-dim); font-size:0.75rem;">${item.id}</td>
    `;
    tbody.appendChild(tr);
  });

  if (window.lucide) lucide.createIcons();
}

// CSV Data Export
function exportCSV() {
  if (!state.rawFeedData || state.rawFeedData.length === 0) {
    showToast('No history data available to export.', 'error');
    return;
  }

  let csvContent = 'data:text/csv;charset=utf-8,ID,Timestamp,Value_Percent,FeedKey\n';
  state.rawFeedData.forEach(row => {
    csvContent += `"${row.id}","${row.created_at}",${row.value},"${state.feedKey}"\n`;
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `soil_moisture_${state.feedKey}_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('CSV History downloaded successfully!', 'success');
}

// Live Sensor Tester: Publish Reading to Adafruit IO
async function publishLiveReading() {
  const slider = document.getElementById('moistureSlider');
  const val = parseFloat(slider.value);

  appendLog(`Sending POST request: value = ${val}% to ${state.feedKey}...`, 'info');

  const url = `https://io.adafruit.com/api/v2/${state.username}/feeds/${state.feedKey}/data?aio_key=${encodeURIComponent(state.aioKey)}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-AIO-Key': state.aioKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ value: val })
    });

    const resData = await response.json();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${resData.error || response.statusText}`);
    }

    appendLog(`[HTTP 200 OK] Data created! ID: ${resData.id}, Value: ${resData.value}%`, 'success');
    showToast(`Transmitted ${val}% to Adafruit IO feed (${state.feedKey})!`, 'success');

    // Trigger immediate refresh to update gauge & chart
    fetchLiveTelemetry();

  } catch (err) {
    console.error('Push Live Data Error:', err);
    appendLog(`[ERROR] Failed to send data: ${err.message}`, 'error');
    showToast(`Publish Error: ${err.message}`, 'error');
  }
}

function updateSliderLabel(val) {
  document.getElementById('sliderValueText').textContent = `${val}%`;
}

function setSliderValue(val) {
  const slider = document.getElementById('moistureSlider');
  slider.value = val;
  updateSliderLabel(val);
}

function appendLog(msg, type = 'info') {
  const logConsole = document.getElementById('logConsole');
  if (!logConsole) return;

  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">[${timeStr}]</span> <span class="log-${type}">${msg}</span>`;
  
  logConsole.appendChild(entry);
  logConsole.scrollTop = logConsole.scrollHeight;
}

// Plant Preset Selection
function selectPlantPreset(presetKey, chipEl) {
  state.currentPlantPreset = presetKey;

  document.querySelectorAll('.plant-chip').forEach(c => c.classList.remove('active'));
  if (chipEl) chipEl.classList.add('active');

  const preset = plantPresets[presetKey];
  if (preset && presetKey !== 'custom') {
    state.minThreshold = preset.min;
    state.maxThreshold = preset.max;
    document.getElementById('settingMinThreshold').value = preset.min;
    document.getElementById('settingMaxThreshold').value = preset.max;
    showToast(`Applied preset: ${preset.name} (${preset.min}% - ${preset.max}%)`, 'info');
  }

  if (state.latestValue !== null) {
    updatePlantAdvice(state.latestValue);
    checkThresholdAlerts(state.latestValue);
  }
}

function updatePlantAdvice(val) {
  const titleEl = document.getElementById('adviceTitle');
  const textEl = document.getElementById('adviceText');
  const preset = plantPresets[state.currentPlantPreset] || plantPresets.houseplants;

  titleEl.textContent = `${preset.name} Target: ${state.minThreshold}% - ${state.maxThreshold}%`;

  if (val < state.minThreshold) {
    textEl.innerHTML = `⚠️ <strong>Moisture Low (${val.toFixed(1)}%)</strong>: Soil is dryer than target min (${state.minThreshold}%). Water thoroughly!`;
  } else if (val > state.maxThreshold) {
    textEl.innerHTML = `🌊 <strong>Moisture High (${val.toFixed(1)}%)</strong>: Soil is wetter than target max (${state.maxThreshold}%). Ensure proper pot drainage.`;
  } else {
    textEl.innerHTML = `✅ <strong>Optimal Conditions (${val.toFixed(1)}%)</strong>: ${preset.advice}`;
  }
}

// Settings Form Submit Handler
function saveSettings(e) {
  e.preventDefault();

  state.username = document.getElementById('settingUsername').value.trim();
  state.aioKey = document.getElementById('settingAioKey').value.trim();
  const feedSelect = document.getElementById('settingFeedSelect');
  if (feedSelect && feedSelect.value) {
    state.feedKey = feedSelect.value.trim();
  }
  state.pollInterval = parseInt(document.getElementById('settingInterval').value);
  state.minThreshold = parseInt(document.getElementById('settingMinThreshold').value);
  state.maxThreshold = parseInt(document.getElementById('settingMaxThreshold').value);

  localStorage.setItem('tm_username', state.username);
  localStorage.setItem('tm_aioKey', state.aioKey);
  localStorage.setItem('tm_feedKey', state.feedKey);
  localStorage.setItem('tm_pollInterval', state.pollInterval.toString());

  document.getElementById('headerUsername').textContent = state.username;
  document.getElementById('currentFeedName').textContent = state.feedKey;
  document.getElementById('metaFeedKey').textContent = state.feedKey;

  showToast('Adafruit IO Credentials & Settings Saved!', 'success');
  restartPollingTimer();
  fetchLiveTelemetry();
  switchTab('tab-dashboard');
}

// Auto-Polling Countdown & Timer
function restartPollingTimer() {
  if (state.timerId) clearInterval(state.timerId);
  if (state.countdownTimerId) clearInterval(state.countdownTimerId);

  resetCountdown();

  state.countdownTimerId = setInterval(() => {
    state.countdown--;
    const cdEl = document.getElementById('countdownSec');
    if (cdEl) cdEl.textContent = `${state.countdown}s`;

    if (state.countdown <= 0) {
      resetCountdown();
    }
  }, 1000);

  state.timerId = setInterval(() => {
    fetchLiveTelemetry();
  }, state.pollInterval);
}

function resetCountdown() {
  state.countdown = Math.round(state.pollInterval / 1000);
  const cdEl = document.getElementById('countdownSec');
  if (cdEl) cdEl.textContent = `${state.countdown}s`;
}

function manualRefresh() {
  fetchUserFeeds().then(() => fetchLiveTelemetry());
  showToast('Syncing with Adafruit IO...', 'info');
}

// Toast Notifications System
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  
  let icon = 'info';
  if (type === 'success') icon = 'check-circle';
  if (type === 'error') icon = 'alert-octagon';

  toast.innerHTML = `<i data-lucide="${icon}"></i> <span>${message}</span>`;
  container.appendChild(toast);

  if (window.lucide) lucide.createIcons();

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
