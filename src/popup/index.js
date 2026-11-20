// Popup - Suno Advanced Downloader
// Modern React-like UI with tabs, real-time updates

import {
  MESSAGE_TYPES,
  QUEUE_STATUSES,
  ACTIVE_STATUSES,
  formatTime,
  formatRelativeTime,
  formatFileSize,
  escapeHtml,
  safeImageUrl
} from '../shared/constants.js';

// ============ STATE ============
let currentTab = 'current';
let queue = [];
let history = [];
let settings = {};
let currentSongMetadata = null;
let currentPlayState = null;
let updateInterval = null;

// ============ DOM ELEMENTS ============
const elements = {
  // Tabs
  tabs: document.querySelectorAll('.tab'),
  panels: document.querySelectorAll('.tab-panel'),
  
  // Current song
  currentSongContent: document.getElementById('current-song-content'),
  
  // Queue
  queueList: document.getElementById('queue-list'),
  
  // History
  historyList: document.getElementById('history-list'),
  
  // Settings
  toggleMp3: document.getElementById('toggle-mp3'),
  selectQuality: document.getElementById('select-quality'),
  inputFolder: document.getElementById('input-folder'),
  toggleNotifications: document.getElementById('toggle-notifications'),
  toggleHistory: document.getElementById('toggle-history'),
  selectMaxHistory: document.getElementById('select-max-history'),
  btnClearHistory: document.getElementById('btn-clear-history'),
  btnClearQueue: document.getElementById('btn-clear-queue'),
  
  // Header
  btnSettings: document.getElementById('btn-settings'),
  btnRefresh: document.getElementById('btn-refresh'),
  
  // Toasts
  toastContainer: document.getElementById('toast-container')
};

// ============ UTILITY FUNCTIONS ============
function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response);
    });
  });
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icons = {
    success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>',
    error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
    info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
  };
  
  toast.innerHTML = `${icons[type]}<span class="toast-message">${escapeHtml(message)}</span><button class="toast-close" aria-label="Close"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>`;
  
  toast.querySelector('.toast-close').addEventListener('click', () => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  });
  
  elements.toastContainer.appendChild(toast);
  
  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.animation = 'slideIn 0.3s ease reverse';
      setTimeout(() => toast.remove(), 300);
    }
  }, 5000);
}

function setBadge(id, count) {
  const el = document.getElementById(id);
  if (count > 0) {
    el.textContent = count > 99 ? '99+' : count;
    el.style.display = 'inline-flex';
  } else {
    el.style.display = 'none';
  }
}

// ============ RENDER FUNCTIONS ============
function renderCurrentSong() {
  const metadata = currentSongMetadata;
  const playState = currentPlayState;
  
  if (!metadata || metadata.songName === 'Suno Song') {
    elements.currentSongContent.innerHTML = `
      <div class="idle-state">
        <svg class="idle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
        <p>Play a song on Suno to see details here</p>
        <button class="btn btn-primary" id="btn-detect-song">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          Detect Current Song
        </button>
      </div>
    `;
    document.getElementById('btn-detect-song')?.addEventListener('click', detectCurrentSong);
    return;
  }
  
  const isPlaying = playState?.isPlaying ?? false;
  const isActiveRecording = queue.some(item => 
    item.id === metadata.queueItemId && ACTIVE_STATUSES.includes(item.status)
  );
  
  const queueItem = queue.find(item => 
    item.songName === metadata.songName && 
    item.artist === metadata.artist &&
    ACTIVE_STATUSES.includes(item.status)
  ) || queue.find(item => item.id === metadata.queueItemId);
  
  const status = queueItem?.status || (isPlaying ? 'pending' : 'idle');
  const progress = queueItem?.progress || 0;
  
  let statusLabel = 'Ready';
  let statusClass = 'pending';
  
  switch (status) {
    case QUEUE_STATUSES.RECORDING:
      statusLabel = 'Recording';
      statusClass = 'recording';
      break;
    case QUEUE_STATUSES.ENCODING:
      statusLabel = 'Converting to MP3';
      statusClass = 'encoding';
      break;
    case QUEUE_STATUSES.DOWNLOADING:
      statusLabel = 'Downloading';
      statusClass = 'downloading';
      break;
    case QUEUE_STATUSES.COMPLETED:
      statusLabel = 'Completed';
      statusClass = 'completed';
      break;
    case QUEUE_STATUSES.FAILED:
      statusLabel = 'Failed';
      statusClass = 'failed';
      break;
    case QUEUE_STATUSES.PENDING:
      statusLabel = 'Queued';
      statusClass = 'pending';
      break;
  }
  
  elements.currentSongContent.innerHTML = `
    <div class="song-card ${isPlaying ? 'playing' : ''}">
      <div class="song-header">
        ${metadata.coverUrl ? `<img class="song-cover" src="${escapeHtml(safeImageUrl(metadata.coverUrl))}" alt="">` : ''}
        <div class="song-info">
          <div class="song-title">${escapeHtml(metadata.songName)}</div>
          <div class="song-artist">${escapeHtml(metadata.artist)}</div>
          <div class="song-meta">
            <span>${formatTime(metadata.duration || playState?.duration || 0)}</span>
            ${playState?.currentTime ? `<span>${formatTime(playState.currentTime)} / ${formatTime(playState.duration)}</span>` : ''}
          </div>
        </div>
      </div>
      
      <div class="song-status ${statusClass}">
        <span class="status-dot ${statusClass}"></span>
        <span>${statusLabel}${progress > 0 && status !== QUEUE_STATUSES.COMPLETED ? ` ${progress}%` : ''}</span>
      </div>
      
      ${(status === QUEUE_STATUSES.RECORDING || status === QUEUE_STATUSES.ENCODING || status === QUEUE_STATUSES.DOWNLOADING) ? `
        <div class="progress-section">
          <div class="progress-bar">
            <div class="progress-fill ${statusClass}" style="width: ${progress}%"></div>
          </div>
          <div class="progress-info">
            <span>${progress}%</span>
            ${queueItem?.startedAt ? `<span class="eta">Elapsed: ${formatRelativeTime(queueItem.startedAt)}</span>` : ''}
          </div>
        </div>
      ` : ''}
      
      <div class="action-buttons">
        ${status === QUEUE_STATUSES.RECORDING ? `
          <button class="btn btn-danger" id="btn-stop-rec">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="6" y="6" width="12" height="12" rx="2"></rect>
            </svg>
            Stop Recording
          </button>
        ` : isPlaying ? `
          <button class="btn btn-primary" id="btn-record-now">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#dc2626"><circle cx="12" cy="12" r="8"/></svg>
            <span>Record Now</span>
          </button>
          <button class="btn btn-secondary" id="btn-add-queue">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            Add to Queue
          </button>
        ` : `
          <button class="btn btn-secondary" id="btn-add-queue" disabled>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            Add to Queue (play song first)
          </button>
        `}
      </div>
    </div>
  `;
  
  // Event listeners
  document.getElementById('btn-record-now')?.addEventListener('click', () => recordCurrentSong(true));
  document.getElementById('btn-add-queue')?.addEventListener('click', () => recordCurrentSong(false));
  document.getElementById('btn-stop-rec')?.addEventListener('click', stopCurrentRecording);
}

function renderQueue() {
  if (queue.length === 0) {
    elements.queueList.innerHTML = `
      <div class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
        <p>No songs in queue</p>
        <span style="font-size:12px;">Play a song on Suno and click "Add to Queue"</span>
      </div>
    `;
    return;
  }
  
  elements.queueList.innerHTML = queue.map(item => {
    const isActive = ACTIVE_STATUSES.includes(item.status);
    const statusClass = item.status;
    
    let statusIcon = '';
    switch (item.status) {
      case QUEUE_STATUSES.RECORDING: statusIcon = '🔴'; break;
      case QUEUE_STATUSES.ENCODING: statusIcon = '🟡'; break;
      case QUEUE_STATUSES.DOWNLOADING: statusIcon = '🟢'; break;
      case QUEUE_STATUSES.COMPLETED: statusIcon = '✅'; break;
      case QUEUE_STATUSES.FAILED: statusIcon = '❌'; break;
      default: statusIcon = '⏳';
    }
    
    return `
      <div class="queue-item ${item.status}" data-id="${escapeHtml(item.id)}">
        ${item.coverUrl ? `<img class="queue-cover" src="${escapeHtml(safeImageUrl(item.coverUrl))}" alt="">` : ''}
        <div class="queue-info">
          <div class="queue-title">${escapeHtml(item.songName)}</div>
          <div class="queue-artist">${escapeHtml(item.artist)}</div>
          <div class="queue-meta">
            <span>${formatTime(item.duration)}</span>
            <span>${formatRelativeTime(item.addedAt)}</span>
            ${item.format ? `<span>${item.format.toUpperCase()}</span>` : ''}
          </div>
          ${isActive ? `
            <div class="queue-progress">
              <div class="queue-progress-fill ${statusClass}" style="width: ${Number(item.progress) || 0}%"></div>
            </div>
          ` : ''}
        </div>
        <div class="queue-actions">
          ${item.status === QUEUE_STATUSES.FAILED ? `
            <button class="queue-btn retry" data-action="retry" title="Retry">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 4v6h-6"></path>
                <path d="M1 20v-6h6"></path>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
              </svg>
            </button>
          ` : ''}
          <button class="queue-btn remove" data-action="remove" title="Remove">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
    `;
  }).join('');
  
  // Event listeners
  elements.queueList.querySelectorAll('[data-action="retry"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.closest('.queue-item').dataset.id;
      retryQueueItem(id);
    });
  });
  
  elements.queueList.querySelectorAll('[data-action="remove"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.closest('.queue-item').dataset.id;
      removeFromQueue(id);
    });
  });
}

function renderHistory() {
  if (history.length === 0) {
    elements.historyList.innerHTML = `
      <div class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
        </svg>
        <p>No download history yet</p>
        <span style="font-size:12px;">Completed downloads will appear here</span>
      </div>
    `;
    return;
  }
  
  elements.historyList.innerHTML = history.map(item => `
    <div class="history-item" data-id="${escapeHtml(item.id)}">
      ${item.coverUrl ? `<img class="history-cover" src="${escapeHtml(safeImageUrl(item.coverUrl))}" alt="">` : ''}
      <div class="history-info">
        <div class="history-title">${escapeHtml(item.songName)}</div>
        <div class="history-artist">${escapeHtml(item.artist)}</div>
        <div class="history-meta">
          <span>${formatTime(item.duration)}</span>
          <span>${formatRelativeTime(item.downloadedAt)}</span>
          <span>${item.format?.toUpperCase()}</span>
          <span>${formatFileSize(item.fileSize)}</span>
        </div>
      </div>
      <div class="history-actions">
        <button class="queue-btn remove" data-action="remove" title="Remove from history">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>
  `).join('');
  
  elements.historyList.querySelectorAll('[data-action="remove"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.closest('.history-item').dataset.id;
      removeFromHistory(id);
    });
  });
}

function renderSettings() {
  elements.toggleMp3.classList.toggle('active', settings.autoConvertToMP3);
  elements.toggleMp3.setAttribute('aria-checked', settings.autoConvertToMP3);
  elements.selectQuality.value = settings.quality || 192;
  elements.inputFolder.value = settings.downloadFolder || 'Suno Downloads';
  elements.toggleNotifications.classList.toggle('active', settings.showNotifications);
  elements.toggleNotifications.setAttribute('aria-checked', settings.showNotifications);
  elements.toggleHistory.classList.toggle('active', settings.keepHistory);
  elements.toggleHistory.setAttribute('aria-checked', settings.keepHistory);
  elements.selectMaxHistory.value = settings.maxHistoryItems || 100;
}

function applySettingsUI() {
  // Apply settings to UI elements
  elements.selectQuality.disabled = !settings.autoConvertToMP3;
  elements.selectQuality.style.opacity = settings.autoConvertToMP3 ? '1' : '0.5';
}

// ============ DATA FETCHING ============
async function loadAllData() {
  try {
    const [queueRes, historyRes, settingsRes] = await Promise.all([
      sendMessage({ type: MESSAGE_TYPES.GET_QUEUE }),
      sendMessage({ type: MESSAGE_TYPES.GET_HISTORY }),
      sendMessage({ type: MESSAGE_TYPES.GET_SETTINGS })
    ]);
    
    queue = queueRes?.queue || [];
    history = historyRes?.history || [];
    settings = settingsRes?.settings || {};
    
    updateBadges();
    renderCurrentTab();
    renderSettings();
    applySettingsUI();
  } catch (error) {
    console.error('Failed to load data:', error);
    showToast('Failed to load data', 'error');
  }
}

async function detectCurrentSong() {
  try {
    const response = await sendMessage({ type: MESSAGE_TYPES.GET_METADATA });
    if (response?.metadata) {
      currentSongMetadata = response.metadata;
      
      // Also get play state
      const playResponse = await sendMessage({ type: MESSAGE_TYPES.GET_PLAY_STATE });
      currentPlayState = playResponse?.playState || {};
      
      renderCurrentSong();
    }
  } catch (error) {
    console.error('Failed to detect song:', error);
    showToast('Could not detect current song', 'error');
  }
}

async function refreshCurrentSong() {
  await detectCurrentSong();
  const [queueRes, historyRes] = await Promise.all([
    sendMessage({ type: MESSAGE_TYPES.GET_QUEUE }),
    sendMessage({ type: MESSAGE_TYPES.GET_HISTORY })
  ]);
  queue = queueRes?.queue || [];
  history = historyRes?.history || [];
  updateBadges();
  renderQueue();
  renderHistory();
}

function updateBadges() {
  const activeCount = queue.filter(item => ACTIVE_STATUSES.includes(item.status)).length;
  const pendingCount = queue.filter(item => item.status === QUEUE_STATUSES.PENDING).length;
  setBadge('badge-current', activeCount);
  setBadge('badge-queue', pendingCount + activeCount);
  setBadge('badge-history', history.length);
}

async function recordCurrentSong(startNow) {
  if (!currentSongMetadata || currentSongMetadata.songName === 'Suno Song') {
    showToast('No song detected. Play a song first.', 'error');
    return;
  }
  
  try {
    const item = {
      songName: currentSongMetadata.songName,
      artist: currentSongMetadata.artist,
      duration: currentSongMetadata.duration || currentPlayState?.duration,
      pageUrl: currentSongMetadata.pageUrl,
      coverUrl: currentSongMetadata.coverUrl
    };
    
    const response = await sendMessage({ type: MESSAGE_TYPES.ADD_TO_QUEUE, item });
    if (response?.item) {
      queue.push(response.item);
      updateBadges();
      renderQueue();
      renderCurrentSong();
      
      if (startNow) {
        // Recording will start automatically via background
      }
      showToast(`Added "${item.songName}" to queue`, 'success');
    }
  } catch (error) {
    console.error('Failed to add to queue:', error);
    showToast('Failed to add to queue', 'error');
  }
}

async function stopCurrentRecording() {
  try {
    await sendMessage({ type: MESSAGE_TYPES.STOP_RECORDING });
    showToast('Recording stopped', 'info');
  } catch (error) {
    console.error('Failed to stop recording:', error);
    showToast('Failed to stop recording', 'error');
  }
}

async function retryQueueItem(id) {
  try {
    await sendMessage({ type: MESSAGE_TYPES.RETRY_QUEUE_ITEM, id });
    const queueRes = await sendMessage({ type: MESSAGE_TYPES.GET_QUEUE });
    queue = queueRes?.queue || [];
    updateBadges();
    renderQueue();
    renderCurrentSong();
    showToast('Retrying download...', 'success');
  } catch (error) {
    console.error('Failed to retry:', error);
    showToast('Failed to retry', 'error');
  }
}

async function removeFromQueue(id) {
  try {
    await sendMessage({ type: MESSAGE_TYPES.REMOVE_FROM_QUEUE, id });
    queue = queue.filter(item => item.id !== id);
    updateBadges();
    renderQueue();
    renderCurrentSong();
    showToast('Removed from queue', 'success');
  } catch (error) {
    console.error('Failed to remove:', error);
    showToast('Failed to remove', 'error');
  }
}

async function removeFromHistory(id) {
  try {
    await sendMessage({ type: MESSAGE_TYPES.REMOVE_FROM_HISTORY, id });
    history = history.filter(item => item.id !== id);
    updateBadges();
    renderHistory();
    showToast('Removed from history', 'success');
  } catch (error) {
    console.error('Failed to remove:', error);
    showToast('Failed to remove', 'error');
  }
}

async function clearHistory() {
  if (!confirm('Clear all download history?')) return;
  try {
    await sendMessage({ type: MESSAGE_TYPES.CLEAR_HISTORY });
    history = [];
    updateBadges();
    renderHistory();
    showToast('History cleared', 'success');
  } catch (error) {
    console.error('Failed to clear history:', error);
    showToast('Failed to clear history', 'error');
  }
}

async function clearQueue() {
  if (!confirm('Clear all queued items?')) return;
  try {
    await sendMessage({ type: MESSAGE_TYPES.CLEAR_QUEUE });
    queue = [];
    updateBadges();
    renderQueue();
    renderCurrentSong();
    showToast('Queue cleared', 'success');
  } catch (error) {
    console.error('Failed to clear queue:', error);
    showToast('Failed to clear queue', 'error');
  }
}

async function saveSettings(newSettings) {
  try {
    const response = await sendMessage({ type: MESSAGE_TYPES.UPDATE_SETTINGS, settings: newSettings });
    settings = response?.settings || newSettings;
    applySettingsUI();
    showToast('Settings saved', 'success');
  } catch (error) {
    console.error('Failed to save settings:', error);
    showToast('Failed to save settings', 'error');
  }
}

// ============ TAB MANAGEMENT ============
function switchTab(tabName) {
  currentTab = tabName;
  
  elements.tabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  
  elements.panels.forEach(panel => {
    panel.classList.toggle('active', panel.id === `panel-${tabName}`);
  });
  
  renderCurrentTab();
}

function renderCurrentTab() {
  switch (currentTab) {
    case 'current':
      renderCurrentSong();
      break;
    case 'queue':
      renderQueue();
      break;
    case 'history':
      renderHistory();
      break;
    case 'settings':
      renderSettings();
      break;
  }
}

// ============ MESSAGE LISTENER ============
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case MESSAGE_TYPES.QUEUE_CHANGED:
      loadAllData();
      break;
    case MESSAGE_TYPES.HISTORY_CHANGED:
      sendMessage({ type: MESSAGE_TYPES.GET_HISTORY }).then(res => {
        history = res?.history || [];
        updateBadges();
        renderHistory();
      });
      break;
    case MESSAGE_TYPES.RECORDING_PROGRESS:
      // Update current song if it's the one recording
      sendMessage({ type: MESSAGE_TYPES.GET_QUEUE }).then(res => {
        queue = res?.queue || [];
        updateBadges();
        renderCurrentSong();
        renderQueue();
      });
      break;
    case MESSAGE_TYPES.ENCODING_PROGRESS:
    case MESSAGE_TYPES.DOWNLOAD_PROGRESS:
    case MESSAGE_TYPES.DOWNLOAD_COMPLETE:
      sendMessage({ type: MESSAGE_TYPES.GET_QUEUE }).then(res => {
        queue = res?.queue || [];
        updateBadges();
        renderCurrentSong();
        renderQueue();
      });
      break;
  }
});

// ============ INITIALIZATION ============
function init() {
  console.log('[Suno Advanced Popup] Initializing');
  
  // Tab switching
  elements.tabs.forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
  
  // Header buttons
  elements.btnRefresh.addEventListener('click', refreshCurrentSong);
  elements.btnSettings.addEventListener('click', () => switchTab('settings'));
  
  // Settings toggles
  elements.toggleMp3.addEventListener('click', () => {
    const newValue = !elements.toggleMp3.classList.contains('active');
    elements.toggleMp3.classList.toggle('active', newValue);
    elements.toggleMp3.setAttribute('aria-checked', newValue);
    saveSettings({ ...settings, autoConvertToMP3: newValue });
  });
  
  elements.toggleNotifications.addEventListener('click', () => {
    const newValue = !elements.toggleNotifications.classList.contains('active');
    elements.toggleNotifications.classList.toggle('active', newValue);
    elements.toggleNotifications.setAttribute('aria-checked', newValue);
    saveSettings({ ...settings, showNotifications: newValue });
  });
  
  elements.toggleHistory.addEventListener('click', () => {
    const newValue = !elements.toggleHistory.classList.contains('active');
    elements.toggleHistory.classList.toggle('active', newValue);
    elements.toggleHistory.setAttribute('aria-checked', newValue);
    saveSettings({ ...settings, keepHistory: newValue });
  });
  
  // Settings selects/inputs
  elements.selectQuality.addEventListener('change', () => {
    saveSettings({ ...settings, quality: parseInt(elements.selectQuality.value) });
  });
  
  elements.inputFolder.addEventListener('change', () => {
    saveSettings({ ...settings, downloadFolder: elements.inputFolder.value.trim() || 'Suno Downloads' });
  });
  
  elements.selectMaxHistory.addEventListener('change', () => {
    saveSettings({ ...settings, maxHistoryItems: parseInt(elements.selectMaxHistory.value) });
  });
  
  // Danger zone
  elements.btnClearHistory.addEventListener('click', clearHistory);
  elements.btnClearQueue.addEventListener('click', clearQueue);
  
  // Initial load
  loadAllData();
  
  // Periodic refresh
  updateInterval = setInterval(() => {
    if (currentTab === 'current' || currentTab === 'queue') {
      sendMessage({ type: MESSAGE_TYPES.GET_QUEUE }).then(res => {
        queue = res?.queue || [];
        updateBadges();
        if (currentTab === 'current') renderCurrentSong();
        else renderQueue();
      });
    }
  }, 2000);
  
  // Cleanup on unload
  window.addEventListener('unload', () => {
    if (updateInterval) clearInterval(updateInterval);
  });
  
  console.log('[Suno Advanced Popup] Initialized');
}

// Run on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}