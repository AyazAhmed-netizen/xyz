// popup.js - Advanced Popup Logic for Suno Downloader

// ============ STATE ============
let currentTab = 'queue';
let currentHistoryFilter = 'all';
let settings = {};

// ============ DOM ELEMENTS ============
const elements = {
  // Tabs
  tabs: document.querySelectorAll('.tab'),
  panels: document.querySelectorAll('.tab-panel'),
  
  // Queue
  queueList: document.getElementById('queue-list'),
  queueEmpty: document.getElementById('queue-empty'),
  queueBadge: document.getElementById('queue-badge'),
  addCurrentBtn: document.getElementById('add-current-btn'),
  clearQueueBtn: document.getElementById('clear-queue-btn'),
  
  // History
  historyList: document.getElementById('history-list'),
  historyEmpty: document.getElementById('history-empty'),
  historyBadge: document.getElementById('history-badge'),
  historyFilters: document.querySelectorAll('.filter-btn'),
  statTotal: document.getElementById('stat-total'),
  statMp3: document.getElementById('stat-mp3'),
  statWebm: document.getElementById('stat-webm'),
  statSize: document.getElementById('stat-size'),
  
  // Settings
  settingAutoRecord: document.getElementById('setting-auto-record'),
  settingAutoMp3: document.getElementById('setting-auto-mp3'),
  settingQuality: document.getElementById('setting-quality'),
  settingFolder: document.getElementById('setting-folder'),
  settingNotifications: document.getElementById('setting-notifications'),
  settingKeepHistory: document.getElementById('setting-keep-history'),
  settingMaxHistory: document.getElementById('setting-max-history'),
  clearHistoryBtn: document.getElementById('clear-history-btn'),
  permissionsBtn: document.getElementById('permissions-btn'),
  
  // Header
  refreshBtn: document.getElementById('refresh-btn'),
  settingsBtn: document.getElementById('settings-btn'),
  
  // Toast
  toast: document.getElementById('toast'),
  toastIcon: document.getElementById('toast-icon'),
  toastMessage: document.getElementById('toast-message')
};

// ============ UTILITY FUNCTIONS ============
function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} hours ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} days ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function showToast(message, type = 'info') {
  elements.toastMessage.textContent = message;
  elements.toast.className = `toast ${type} show`;
  
  // Update icon based on type
  const icons = {
    success: '<polyline points="20 6 9 17 4 12"></polyline>',
    error: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
    info: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>'
  };
  
  elements.toastIcon.innerHTML = icons[type] || icons.info;
  elements.toastIcon.setAttribute('viewBox', '0 0 24 24');
  elements.toastIcon.setAttribute('fill', 'none');
  elements.toastIcon.setAttribute('stroke', 'currentColor');
  elements.toastIcon.setAttribute('stroke-width', '2');
  
  setTimeout(() => {
    elements.toast.classList.remove('show');
  }, 3000);
}

function sendMessage(type, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...data }, (response) => {
      resolve(response);
    });
  });
}

// ============ TAB SWITCHING ============
function switchTab(tabName) {
  currentTab = tabName;
  
  elements.tabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  
  elements.panels.forEach(panel => {
    panel.classList.toggle('active', panel.id === `${tabName}-panel`);
  });
  
  // Load data for the active tab
  if (tabName === 'queue') {
    loadQueue();
  } else if (tabName === 'history') {
    loadHistory();
  } else if (tabName === 'settings') {
    loadSettings();
  }
}

elements.tabs.forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ============ QUEUE MANAGEMENT ============
async function loadQueue() {
  const response = await sendMessage('GET_QUEUE');
  const queue = response?.queue || [];
  
  // Update badge
  const pendingCount = queue.filter(item => 
    item.status === 'pending' || item.status === 'recording' || item.status === 'encoding'
  ).length;
  elements.queueBadge.textContent = pendingCount;
  elements.queueBadge.style.display = pendingCount > 0 ? 'inline-flex' : 'none';
  
  // Render queue
  if (queue.length === 0) {
    elements.queueList.innerHTML = '';
    elements.queueEmpty.style.display = 'block';
    return;
  }
  
  elements.queueEmpty.style.display = 'none';
  elements.queueList.innerHTML = queue.map(item => createQueueItemHTML(item)).join('');
  
  // Add event listeners
  attachQueueItemListeners();
}

function createQueueItemHTML(item) {
  const statusClass = item.status;
  const progress = item.progress || 0;
  const addedTime = formatRelativeTime(item.addedAt);
  const startedTime = item.startedAt ? formatRelativeTime(item.startedAt) : 'Waiting...';
  
  let statusIcon = '';
  switch (item.status) {
    case 'pending':
      statusIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
      break;
    case 'recording':
      statusIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4" fill="currentColor"></circle></svg>';
      break;
    case 'encoding':
      statusIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path></svg>';
      break;
    case 'completed':
      statusIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="16 12 10 16 8 12"></polyline></svg>';
      break;
    case 'failed':
      statusIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
      break;
  }
  
  return `
    <div class="queue-item ${statusClass}" data-id="${item.id}">
      <div class="queue-item-icon">
        ${statusIcon}
      </div>
      <div class="queue-item-info">
        <div class="queue-item-title">${escapeHtml(item.songName || 'Unknown Song')}</div>
        <div class="queue-item-artist">${escapeHtml(item.artist || 'Unknown Artist')}</div>
        <div class="queue-item-meta">
          <span>${item.duration ? formatTime(item.duration * 1000) : 'Unknown'}</span>
          <span>Added: ${addedTime}</span>
          ${item.startedAt ? `<span>Started: ${startedTime}</span>` : ''}
        </div>
      </div>
      <div class="queue-item-progress">
        <div class="queue-progress-bar">
          <div class="queue-progress-fill" style="width: ${progress}%"></div>
        </div>
        <div class="queue-item-status">${item.status}</div>
        <div class="queue-item-time">${progress}%</div>
      </div>
      <div class="queue-item-actions">
        ${item.status === 'pending' || item.status === 'recording' || item.status === 'encoding' ? `
          <button class="queue-action-btn cancel-btn" title="Cancel" data-id="${item.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        ` : ''}
        ${item.status === 'completed' ? `
          <button class="queue-action-btn open-folder-btn" title="Show in Folder" data-id="${item.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"></path></svg>
          </button>
        ` : ''}
        ${item.status === 'failed' ? `
          <button class="queue-action-btn retry-btn" title="Retry" data-id="${item.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 102.13-9.36L1 10"></path></svg>
          </button>
        ` : ''}
        <button class="queue-action-btn remove-btn" title="Remove from Queue" data-id="${item.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
        </button>
      </div>
    </div>
  `;
}

function attachQueueItemListeners() {
  // Cancel buttons
  document.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      await sendMessage('REMOVE_FROM_QUEUE', { id });
      showToast('Removed from queue', 'info');
      loadQueue();
    });
  });
  
  // Remove buttons
  document.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      await sendMessage('REMOVE_FROM_QUEUE', { id });
      loadQueue();
    });
  });
  
  // Retry buttons - use dedicated RETRY_QUEUE_ITEM handler
  document.querySelectorAll('.retry-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      await sendMessage('RETRY_QUEUE_ITEM', { id });
      showToast('Retrying download...', 'info');
      loadQueue();
    });
  });
  
  // Open folder buttons (would need native integration)
  document.querySelectorAll('.open-folder-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showToast('Open folder not available in extension', 'info');
    });
  });
}

elements.addCurrentBtn.addEventListener('click', async () => {
  // Get current song metadata from content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: 'https://suno.com/*' });
  if (!tab) {
    showToast('No Suno tab open', 'error');
    return;
  }
  
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_METADATA' });
    if (response?.metadata) {
      await sendMessage('ADD_TO_QUEUE', { 
        item: { 
          songName: response.metadata.songName,
          artist: response.metadata.artist,
          duration: response.metadata.duration,
          pageUrl: tab.url
        }
      });
      showToast('Added to queue!', 'success');
      loadQueue();
    } else {
      showToast('Could not get song info - play a song first', 'error');
    }
  } catch (error) {
    // Content script is missing or orphaned ("Extension context invalidated") - re-inject it
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      showToast('Reconnected to page - try again', 'success');
    } catch (injectErr) {
      showToast('Please refresh the Suno page (F5) and try again', 'error');
    }
  }
});

elements.clearQueueBtn.addEventListener('click', async () => {
  if (confirm('Clear all queue items?')) {
    await sendMessage('CLEAR_QUEUE');
    showToast('Queue cleared', 'info');
    loadQueue();
  }
});

// ============ HISTORY MANAGEMENT ============
async function loadHistory() {
  const response = await sendMessage('GET_HISTORY');
  const history = response?.history || [];
  
  // Update badge
  elements.historyBadge.textContent = history.length;
  elements.historyBadge.style.display = history.length > 0 ? 'inline-flex' : 'none';
  
  // Calculate stats
  const total = history.length;
  const mp3Count = history.filter(h => h.format === 'mp3').length;
  const webmCount = history.filter(h => h.format === 'webm').length;
  const totalSize = history.reduce((sum, h) => sum + (h.fileSize || 0), 0);
  
  elements.statTotal.textContent = total;
  elements.statMp3.textContent = mp3Count;
  elements.statWebm.textContent = webmCount;
  elements.statSize.textContent = formatFileSize(totalSize);
  
  // Filter history
  let filtered = history;
  if (currentHistoryFilter === 'mp3') {
    filtered = history.filter(h => h.format === 'mp3');
  } else if (currentHistoryFilter === 'webm') {
    filtered = history.filter(h => h.format === 'webm');
  }
  
  // Render history
  if (filtered.length === 0) {
    elements.historyList.innerHTML = '';
    elements.historyEmpty.style.display = 'block';
    return;
  }
  
  elements.historyEmpty.style.display = 'none';
  elements.historyList.innerHTML = filtered.map(item => createHistoryItemHTML(item)).join('');
  
  // Add event listeners
  attachHistoryItemListeners();
}

function createHistoryItemHTML(item) {
  const timeAgo = formatRelativeTime(item.downloadedAt);
  const formatBadge = item.format === 'mp3' ? 'MP3' : 'WebM';
  
  return `
    <div class="history-item" data-id="${item.id}">
      <img class="history-item-cover" src="${item.coverUrl || ''}" alt="" onerror="this.style.display='none'">
      <div class="history-item-info">
        <div class="history-item-title">${escapeHtml(item.songName || 'Unknown Song')}</div>
        <div class="history-item-artist">${escapeHtml(item.artist || 'Unknown Artist')}</div>
        <div class="history-item-meta">
          <span>${item.duration ? formatTime(item.duration * 1000) : 'Unknown'}</span>
          <span>${formatFileSize(item.fileSize || 0)}</span>
        </div>
      </div>
      <div class="history-item-actions">
        <div class="history-item-time">${timeAgo}</div>
        <span class="history-item-format">${formatBadge}</span>
      </div>
    </div>
  `;
}

function attachHistoryItemListeners() {
  // History item click - could open file or show details
  document.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.id;
      showToast('History item clicked - open file not available', 'info');
    });
  });
}

// Filter buttons
elements.historyFilters.forEach(btn => {
  btn.addEventListener('click', () => {
    elements.historyFilters.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentHistoryFilter = btn.dataset.filter;
    loadHistory();
  });
});

// ============ SETTINGS MANAGEMENT ============
async function loadSettings() {
  const response = await sendMessage('GET_SETTINGS');
  settings = response?.settings || {};
  
  // Populate form
  elements.settingAutoRecord.checked = settings.autoRecord !== false;
  elements.settingAutoMp3.checked = settings.autoConvertToMP3 !== false;
  elements.settingQuality.value = settings.quality || 192;
  elements.settingFolder.value = settings.downloadFolder || 'Suno Downloads';
  elements.settingNotifications.checked = settings.showNotifications !== false;
  elements.settingKeepHistory.checked = settings.keepHistory !== false;
  elements.settingMaxHistory.value = settings.maxHistoryItems || 100;
}

// Settings change handlers
const settingInputs = [
  { el: elements.settingAutoRecord, key: 'autoRecord', type: 'bool' },
  { el: elements.settingAutoMp3, key: 'autoConvertToMP3', type: 'bool' },
  { el: elements.settingQuality, key: 'quality', type: 'int' },
  { el: elements.settingFolder, key: 'downloadFolder', type: 'string' },
  { el: elements.settingNotifications, key: 'showNotifications', type: 'bool' },
  { el: elements.settingKeepHistory, key: 'keepHistory', type: 'bool' },
  { el: elements.settingMaxHistory, key: 'maxHistoryItems', type: 'int' }
];

settingInputs.forEach(({ el, key, type }) => {
  const handler = async () => {
    let value;
    if (type === 'bool') value = el.checked;
    else if (type === 'int') value = parseInt(el.value);
    else value = el.value;
    
    const response = await sendMessage('UPDATE_SETTINGS', { settings: { [key]: value } });
    settings = response?.settings || settings;
    showToast('Settings saved', 'success');
  };
  
  if (el.tagName === 'SELECT' || el.tagName === 'INPUT' && el.type === 'text') {
    el.addEventListener('change', handler);
  } else {
    el.addEventListener('click', handler);
  }
});

elements.clearHistoryBtn.addEventListener('click', async () => {
  if (confirm('Delete all download history? This cannot be undone.')) {
    await sendMessage('CLEAR_HISTORY');
    showToast('History cleared', 'info');
    loadHistory();
  }
});

elements.permissionsBtn.addEventListener('click', () => {
  // No options page in manifest - open Chrome's extension permissions settings instead
  const url = `chrome://extensions/?id=${chrome.runtime.id}`;
  chrome.tabs.create({ url }).then(() => {
    showToast('Extension settings opened in a new tab', 'info');
  }).catch(() => {
    showToast('Could not open extension settings', 'error');
  });
});

// ============ HEADER BUTTONS ============
elements.refreshBtn.addEventListener('click', async () => {
  elements.refreshBtn.classList.add('spinning');
  
  if (currentTab === 'queue') await loadQueue();
  else if (currentTab === 'history') await loadHistory();
  else if (currentTab === 'settings') await loadSettings();
  
  setTimeout(() => {
    elements.refreshBtn.classList.remove('spinning');
  }, 500);
  
  showToast('Refreshed', 'success');
});

elements.settingsBtn.addEventListener('click', () => {
  switchTab('settings');
});

// ============ REAL-TIME UPDATES ============
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'QUEUE_CHANGED') {
    loadQueue();
  } else if (message.type === 'HISTORY_CHANGED') {
    loadHistory();
  }
});

// ============ INITIALIZATION ============
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function init() {
  // Load initial data
  await loadQueue();
  
  // Listen for storage changes from other contexts
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.suno_download_queue) loadQueue();
      if (changes.suno_download_history) loadHistory();
      if (changes.suno_settings) loadSettings();
    }
  });
  
  console.log('Suno Advanced Downloader popup initialized');
}

document.addEventListener('DOMContentLoaded', init);