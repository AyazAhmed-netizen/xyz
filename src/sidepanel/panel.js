// Side Panel Controller - Suno Advanced Downloader
// Live pipeline, per-stage progress, activity log, queue, history, settings.

import {
  MESSAGE_TYPES,
  QUEUE_STATUSES,
  formatTime,
  formatFileSize,
  formatRelativeTime,
  escapeHtml,
  safeImageUrl
} from '../shared/constants.js';

const $ = (sel) => document.querySelector(sel);

// ============ STATE ============
let metadata = null;
let playState = null;
let busy = false;
let lastDownloadId = null;
const logEntries = [];

const STAGES = [
  { key: 'detect', label: 'Detect' },
  { key: 'record', label: 'Record' },
  { key: 'encode', label: 'Encode MP3' },
  { key: 'download', label: 'Save' },
  { key: 'done', label: 'Complete' }
];

// ============ MESSAGE HELPER ============
function send(type, payload = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, (res) => {
        void chrome.runtime.lastError;
        resolve(res || {});
      });
    } catch (e) {
      resolve({});
    }
  });
}

// ============ TABS ============
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    tab.classList.add('active');
    $('#view-' + tab.dataset.view).classList.add('active');
    if (tab.dataset.view === 'queue') loadQueue();
    if (tab.dataset.view === 'history') loadHistory();
    if (tab.dataset.view === 'settings') loadSettings();
  });
});

// ============ TOAST ============
let toastTimer = null;
function toast(msg, kind = 'info') {
  const el = $('#toast');
  $('#toast-msg').textContent = msg;
  el.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

// ============ CONNECTION / NOW PLAYING ============
function setConnection(state, text) {
  const dot = $('#conn-dot');
  dot.className = 'dot ' + (state || '');
  $('#conn-text').textContent = text;
}

async function detectSong() {
  toast('Detecting current song...');
  const res = await send(MESSAGE_TYPES.GET_METADATA);
  const play = await send(MESSAGE_TYPES.GET_PLAY_STATE);
  metadata = res?.metadata || null;
  playState = play?.playState || null;
  renderNowPlaying();
  if (metadata && metadata.songName && metadata.songName !== 'Suno Song') {
    setConnection('on', 'SONG FOUND');
    addLog('ok', `Detected: ${metadata.songName}`);
    toast('Song found', 'ok');
  } else {
    setConnection('', 'NO SONG');
    addLog('warn', 'No song detected yet - Start Download will open/play it automatically');
    toast('No song playing yet - download will start it for you', 'info');
  }
}

function renderNowPlaying() {
  const title = $('#np-title');
  const artist = $('#np-artist');
  const time = $('#np-time');
  const cover = $('#np-cover');

  if (metadata && metadata.songName && metadata.songName !== 'Suno Song') {
    title.textContent = metadata.songName;
    title.classList.remove('placeholder');
    artist.textContent = metadata.artist || 'Unknown Artist';
    const coverUrl = safeImageUrl(metadata.coverUrl);
    if (coverUrl) {
      const img = document.createElement('img');
      img.src = coverUrl;
      img.alt = '';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:5px;';
      cover.replaceChildren(img);
    }
  } else {
    title.textContent = 'No song playing yet';
    title.classList.add('placeholder');
    artist.textContent = 'Open a song on suno.com and press Start Download';
  }

  if (playState) {
    const cur = playState.isPlaying;
    $('#page-state').textContent = cur ? 'PLAYING' : 'PAUSED';
    time.textContent = `${formatTime(playState.currentTime || 0)} / ${formatTime(playState.duration || 0)}`;
  } else {
    $('#page-state').textContent = '—';
    time.textContent = '0:00 / 0:00';
  }
}

// ============ PIPELINE ============
function resetPipeline() {
  busy = true;
  document.querySelectorAll('.stage').forEach((s) => {
    s.className = 'stage';
    s.querySelector('.stage-icon').textContent =
      String(STAGES.findIndex((x) => x.key === s.dataset.stage) + 1);
    s.querySelector('.stage-label').textContent = '—';
    s.querySelector('.stage-fill').style.width = '0%';
  });
  setOverall(0);
  $('#pipeline-state').textContent = 'RUNNING';
  setConnection('busy', 'WORKING');
  $('#loader').classList.add('show');
  $('#loader-label').textContent = 'Starting';
  $('#loader-pct').textContent = '0%';
  $('#btn-download').disabled = true;
  $('#result-row').style.display = 'none';
}

function setOverall(pct) {
  const p = Math.max(0, Math.min(100, pct || 0));
  $('#overall-fill').style.width = p + '%';
  $('#overall-pct').textContent = p + '%';
}

function applyStage(name, progress, label) {
  const idx = STAGES.findIndex((s) => s.key === name);
  if (idx < 0) return;

  const stageEl = document.querySelector(`.stage[data-stage="${name}"]`);
  if (name === 'error') return;
  if (name === 'done') {
    document.querySelectorAll('.stage').forEach((s) => {
      s.classList.remove('active'); s.classList.add('done');
      s.querySelector('.stage-icon').textContent = '✓';
      s.querySelector('.stage-label').textContent = label || 'ok';
      s.querySelector('.stage-fill').style.width = '100%';
    });
    setOverall(100);
    $('#pipeline-state').textContent = 'DONE';
    setConnection('on', 'COMPLETE');
    $('#loader').classList.remove('show');
    busy = false;
    $('#btn-download').disabled = false;
    return;
  }

  // mark previous stages done
  document.querySelectorAll('.stage').forEach((s, i) => {
    if (i < idx) {
      s.classList.remove('active'); s.classList.add('done');
      s.querySelector('.stage-icon').textContent = '✓';
      s.querySelector('.stage-fill').style.width = '100%';
    }
  });

  stageEl.classList.remove('done');
  stageEl.classList.add('active');
  stageEl.querySelector('.stage-icon').textContent = '●';
  if (label) stageEl.querySelector('.stage-label').textContent = label;
  const within = Math.max(0, Math.min(100, Math.round((progress || 0))));
  stageEl.querySelector('.stage-fill').style.width = within + '%';

  // overall = stage weight
  const weights = [0.08, 0.47, 0.35, 0.08, 0.02];
  const before = weights.slice(0, idx).reduce((a, b) => a + b, 0);
  setOverall(Math.round((before + weights[idx] * ((progress || 0) / 100)) * 100));

  $('#loader-label').textContent = label || STAGES[idx].label;
  $('#loader-pct').textContent = Math.round(progress || 0) + '%';
}

function failPipeline(msg) {
  document.querySelectorAll('.stage').forEach((s) => s.classList.remove('active'));
  $('#pipeline-state').textContent = 'FAILED';
  setConnection('', 'FAILED');
  $('#loader').classList.remove('show');
  busy = false;
  $('#btn-download').disabled = false;
  toast(String(msg), 'error');
}

// ============ PLAY / SHOW SAVED FILE ============
function playDownload(id) {
  if (id == null) { toast('File location unknown', 'error'); return; }
  try {
    chrome.downloads.open(id);
  } catch (e) {
    toast('Could not open the file (moved or deleted?)', 'error');
  }
}

function showDownload(id) {
  if (id == null) return;
  try { chrome.downloads.show(id); } catch (e) { toast('Could not show the file', 'error'); }
}

// ============ ACTIVITY LOG ============
function addLog(level, text) {
  const empty = $('#log .log-empty');
  if (empty) empty.remove();
  logEntries.unshift({ level, text: String(text), at: Date.now() });
  if (logEntries.length > 60) logEntries.pop();
  renderLog();
}

function renderLog() {
  const log = $('#log');
  if (!logEntries.length) {
    log.innerHTML = '<div class="log-empty">No activity yet</div>';
    return;
  }
  log.innerHTML = logEntries.map((e) => {
    const t = new Date(e.at).toLocaleTimeString([], { hour12: false });
    return `<div class="log-row ${e.level}">
      <span class="log-time">${t}</span>
      <span class="log-dot"></span>
      <span class="log-msg">${escapeHtml(e.text)}</span>
    </div>`;
  }).join('');
}

// ============ QUEUE ============
async function loadQueue() {
  const res = await send(MESSAGE_TYPES.GET_QUEUE);
  const queue = res?.queue || [];
  $('#queue-cnt').textContent = queue.length;
  const list = $('#queue-list');
  if (!queue.length) {
    list.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h16M4 12h16M4 18h10"></path></svg>
      <p>Queue is empty</p></div>`;
    return;
  }
  list.innerHTML = queue.map((item) => {
    const st = item.status || 'pending';
    return `<div class="item">
      <div class="item-top">
        <div style="flex:1;min-width:0">
          <div class="item-name">${escapeHtml(item.songName || 'Suno Track')}</div>
          <div class="item-sub">${escapeHtml(item.artist || 'Unknown')} · ${formatTime(item.duration || 0)}</div>
        </div>
        <span class="status-tag ${st}">${st}</span>
      </div>
      ${st === 'failed' && item.error ? `<div class="item-sub" style="color:var(--rec);margin-top:8px">${escapeHtml(item.error)}</div>` : ''}
      <div class="item-actions">
        ${st === 'failed' ? `<button class="mini-btn" data-retry="${escapeHtml(item.id)}">retry</button>` : ''}
        <button class="mini-btn del" data-remove="${escapeHtml(item.id)}">remove</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
    await send(MESSAGE_TYPES.RETRY_QUEUE_ITEM, { id: b.dataset.retry });
    addLog('info', 'Retry queued');
    loadQueue();
  }));
  list.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    await send(MESSAGE_TYPES.REMOVE_FROM_QUEUE, { id: b.dataset.remove });
    loadQueue();
  }));
}

// ============ HISTORY ============
async function loadHistory() {
  const res = await send(MESSAGE_TYPES.GET_HISTORY);
  const history = res?.history || [];
  const list = $('#history-list');
  if (!history.length) {
    list.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>
      <p>No downloads yet</p></div>`;
    return;
  }
  list.innerHTML = history.map((item) => `<div class="item">
    <div class="item-top">
      <div style="flex:1;min-width:0">
        <div class="item-name">${escapeHtml(item.songName || 'Suno Track')}</div>
        <div class="item-sub">${escapeHtml(item.artist || 'Unknown')} · ${formatFileSize(item.fileSize)} · ${formatRelativeTime(item.downloadedAt || Date.now())}</div>
      </div>
      <span class="status-tag completed">${(item.format || 'mp3').toUpperCase()}</span>
    </div>
    ${item.downloadId != null ? `<div class="item-actions"><button class="mini-btn" data-play="${Number(item.downloadId)}">▶ play</button><button class="mini-btn" data-show="${Number(item.downloadId)}">folder</button></div>` : ''}
  </div>`).join('');
  list.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', () => playDownload(Number(b.dataset.play))));
  list.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => showDownload(Number(b.dataset.show))));
}

// ============ SETTINGS ============
async function loadSettings() {
  const res = await send(MESSAGE_TYPES.GET_SETTINGS);
  const s = res?.settings || {};
  const bind = (sel, key) => {
    const el = $(sel);
    el.classList.toggle('on', !!s[key]);
    el.onclick = async () => {
      const next = !el.classList.contains('on');
      el.classList.toggle('on', next);
      await saveSetting(key, next);
    };
  };
  bind('#set-mp3', 'autoConvertToMP3');
  bind('#set-notify', 'showNotifications');
  bind('#set-history', 'keepHistory');

  $('#set-quality').value = String(s.quality || 192);
  $('#set-quality').onchange = async (e) => {
    await saveSetting('quality', parseInt(e.target.value, 10));
    toast('Quality saved', 'ok');
  };
  $('#set-folder').value = s.downloadFolder || 'Suno Downloads';
  $('#set-folder').onchange = async (e) => {
    await saveSetting('downloadFolder', e.target.value);
    toast('Folder saved', 'ok');
  };
}

async function saveSetting(key, value) {
  const cur = await send(MESSAGE_TYPES.GET_SETTINGS);
  const settings = { ...(cur?.settings || {}), [key]: value };
  await send(MESSAGE_TYPES.UPDATE_SETTINGS, { settings });
}

// ============ EVENT LISTENERS ============
$('#btn-detect').addEventListener('click', detectSong);
$('#btn-download').addEventListener('click', async () => {
  if (busy) return;
  resetPipeline();
  addLog('info', 'Download started...');
  await send(MESSAGE_TYPES.DIRECT_DOWNLOAD);
});
$('#btn-play').addEventListener('click', () => playDownload(lastDownloadId));
$('#btn-folder').addEventListener('click', () => showDownload(lastDownloadId));
$('#btn-clear-log').addEventListener('click', () => { logEntries.length = 0; renderLog(); });
$('#btn-clear-queue').addEventListener('click', async () => {
  await send(MESSAGE_TYPES.CLEAR_QUEUE); loadQueue();
});
$('#btn-clear-history').addEventListener('click', async () => {
  await send(MESSAGE_TYPES.CLEAR_HISTORY); loadHistory();
});

// ============ LIVE EVENT STREAM ============
chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case MESSAGE_TYPES.DOWNLOAD_STARTED:
      resetPipeline();
      addLog('info', `Download: ${msg.songName || 'Suno Track'}`);
      break;
    case MESSAGE_TYPES.PIPELINE_STAGE:
      if (msg.stage === 'error') failPipeline(msg.error || msg.label || 'Download failed');
      else applyStage(msg.stage, msg.progress, msg.label);
      break;
    case MESSAGE_TYPES.RECORDING_PROGRESS:
      applyStage('record', msg.progress, msg.label || 'Recording…');
      break;
    case MESSAGE_TYPES.FETCH_PROGRESS:
      break; // stage already carries %; keep for future finer control
    case MESSAGE_TYPES.DOWNLOAD_COMPLETE:
      applyStage('done', 100, 'Complete');
      if (msg.downloadId != null) {
        lastDownloadId = msg.downloadId;
        $('#result-row').style.display = 'flex';
        toast('Saved - press Play to listen', 'ok');
      }
      if (document.querySelector('.tab[data-view="queue"]').classList.contains('active')) loadQueue();
      if (document.querySelector('.tab[data-view="history"]').classList.contains('active')) loadHistory();
      break;
    case MESSAGE_TYPES.ACTIVITY:
      addLog(msg.level || 'info', msg.text || '');
      break;
    case MESSAGE_TYPES.QUEUE_CHANGED:
      $('#queue-cnt').textContent = '';
      loadQueue();
      break;
    case MESSAGE_TYPES.HISTORY_CHANGED:
      if (document.querySelector('.tab[data-view="history"]').classList.contains('active')) loadHistory();
      break;
    case MESSAGE_TYPES.RECORDING_ERROR:
      // The background re-emits this as a PIPELINE_STAGE 'error' + ACTIVITY entry.
      break;
  }
});

// ============ PERIODIC REFRESH (now playing) ============
async function refreshNowPlaying() {
  try {
    const res = await send(MESSAGE_TYPES.GET_PLAY_STATE);
    const play = res?.playState || null;
    if (play) {
      playState = play;
      $('#page-state').textContent = play.isPlaying ? 'PLAYING' : 'PAUSED';
      if (metadata) {
        $('#np-time').textContent = `${formatTime(play.currentTime || 0)} / ${formatTime(play.duration || 0)}`;
      }
    }
  } catch (e) { /* ignore */ }
}
setInterval(refreshNowPlaying, 2000);

// ============ INIT ============
async function init() {
  await detectSong();
  await loadQueue();
  addLog('info', 'Console ready');
  setConnection('on', 'READY');
}
init();
