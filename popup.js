// popup.js - Popup UI logic for Suno Downloader

document.addEventListener('DOMContentLoaded', () => {
  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
      
      if (tab.dataset.tab === 'history') loadHistory();
      if (tab.dataset.tab === 'overview') loadStats();
    });
  });
  
  // Load initial stats
  loadStats();
  
  // Buttons
  document.getElementById('btn-open-panel').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.url?.includes('suno.com')) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_PANEL' });
        window.close();
      } else {
        alert('Please open a Suno page first.');
      }
    });
  });
  
  document.getElementById('btn-refresh').addEventListener('click', loadStats);
  
  document.getElementById('btn-clear-history').addEventListener('click', async () => {
    if (confirm('Clear all download history?')) {
      await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
      loadHistory();
      loadStats();
    }
  });
  
  document.getElementById('btn-clear-data').addEventListener('click', async () => {
    if (confirm('Clear ALL extension data including settings and history? This cannot be undone.')) {
      await chrome.storage.local.clear();
      loadStats();
      loadHistory();
      alert('All data cleared.');
    }
  });
  
  // Toggle switches
  document.querySelectorAll('.toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      toggle.classList.toggle('active');
      saveSettings();
    });
  });
  
  loadSettings();
});

async function loadStats() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
  if (response?.stats) {
    document.getElementById('stat-total-songs').textContent = response.stats.totalSongs;
    document.getElementById('stat-total-time').textContent = response.stats.formattedDuration;
  }
}

async function loadHistory() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  const list = document.getElementById('history-list');
  
  if (!response?.history || response.history.length === 0) {
    list.innerHTML = '<div class="history-empty">No downloads yet.<br>Play a song on Suno to start recording!</div>';
    return;
  }
  
  list.innerHTML = response.history.map(item => `
    <div class="history-item">
      <div class="history-info">
        <div class="history-title">${escapeHtml(item.title)}</div>
        <div class="history-meta">
          <span>${escapeHtml(item.artist)}</span>
          <span>${formatTime(item.duration)}</span>
          <span>${new Date(item.timestamp).toLocaleString()}</span>
        </div>
      </div>
      <div class="history-actions">
        <button onclick="reDownload(${item.id})">Re-download</button>
        <button onclick="deleteHistoryItem(${item.id})">Delete</button>
      </div>
    </div>
  `).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

async function saveSettings() {
  const settings = {
    autoRecord: document.getElementById('toggle-auto-record').classList.contains('active'),
    autoStop: document.getElementById('toggle-auto-stop').classList.contains('active'),
    showPanel: document.getElementById('toggle-show-panel').classList.contains('active')
  };
  await chrome.storage.local.set({ sunoSettings: settings });
}

async function loadSettings() {
  const result = await chrome.storage.local.get('sunoSettings');
  const settings = result.sunoSettings || { autoRecord: true, autoStop: true, showPanel: true };
  
  document.getElementById('toggle-auto-record').classList.toggle('active', settings.autoRecord);
  document.getElementById('toggle-auto-stop').classList.toggle('active', settings.autoStop);
  document.getElementById('toggle-show-panel').classList.toggle('active', settings.showPanel);
}

// Global functions for history actions
window.reDownload = function(id) {
  alert('Re-download requires playing the song again on Suno and recording.');
};

window.deleteHistoryItem = async function(id) {
  if (confirm('Remove this item from history?')) {
    const result = await chrome.storage.local.get('sunoHistory');
    const history = result.sunoHistory || [];
    const filtered = history.filter(item => item.id !== id);
    await chrome.storage.local.set({ sunoHistory: filtered });
    loadHistory();
    loadStats();
  }
};