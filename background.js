// background.js - Service Worker for Suno Advanced Downloader
// Handles: Download queue, history storage, MP3 encoding, notifications

// Storage keys
const STORAGE_KEYS = {
  QUEUE: 'suno_download_queue',
  HISTORY: 'suno_download_history',
  SETTINGS: 'suno_settings'
};

// Default settings
const DEFAULT_SETTINGS = {
  autoRecord: true,
  autoConvertToMP3: true,
  quality: 192, // kbps
  downloadFolder: 'Suno Downloads',
  showNotifications: true,
  keepHistory: true,
  maxHistoryItems: 100
};

// Initialize storage
async function initStorage() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.QUEUE, STORAGE_KEYS.HISTORY]);
  
  if (!result[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
  if (!result[STORAGE_KEYS.QUEUE]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: [] });
  }
  if (!result[STORAGE_KEYS.HISTORY]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: [] });
  }
}

initStorage();

// ============ QUEUE MANAGEMENT ============
async function getQueue() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.QUEUE);
  return result[STORAGE_KEYS.QUEUE] || [];
}

async function saveQueue(queue) {
  await chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: queue });
}

async function addToQueue(item) {
  const queue = await getQueue();
  const newItem = {
    id: Date.now().toString(),
    ...item,
    status: 'pending', // pending, recording, encoding, completed, failed
    progress: 0,
    addedAt: Date.now(),
    startedAt: null,
    completedAt: null
  };
  queue.push(newItem);
  await saveQueue(queue);
  notifyQueueChanged();
  await updateBadge();
  return newItem;
}

async function updateQueueItem(id, updates) {
  const queue = await getQueue();
  const index = queue.findIndex(item => item.id === id);
  if (index !== -1) {
    queue[index] = { ...queue[index], ...updates };
    await saveQueue(queue);
    notifyQueueChanged();
    return queue[index];
  }
  return null;
}

async function removeFromQueue(id) {
  const queue = await getQueue();
  const filtered = queue.filter(item => item.id !== id);
  await saveQueue(filtered);
  notifyQueueChanged();
  await updateBadge();
}

async function clearQueue() {
  await saveQueue([]);
  notifyQueueChanged();
  await updateBadge();
}

// ============ HISTORY MANAGEMENT ============
async function getHistory() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  return result[STORAGE_KEYS.HISTORY] || [];
}

async function saveHistory(history) {
  const settings = await getSettings();
  const maxItems = settings.maxHistoryItems || 100;
  const trimmed = history.slice(-maxItems);
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: trimmed });
}

async function addToHistory(item) {
  const history = await getHistory();
  const newItem = {
    id: Date.now().toString(),
    ...item,
    downloadedAt: Date.now()
  };
  history.unshift(newItem); // Add to beginning (most recent first)
  await saveHistory(history);
  notifyHistoryChanged();
  return newItem;
}

async function removeFromHistory(id) {
  const history = await getHistory();
  const filtered = history.filter(item => item.id !== id);
  await saveHistory(filtered);
  notifyHistoryChanged();
}

async function clearHistory() {
  await saveHistory([]);
  notifyHistoryChanged();
}

// ============ SETTINGS MANAGEMENT ============
async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...result[STORAGE_KEYS.SETTINGS] };
}

async function updateSettings(newSettings) {
  const current = await getSettings();
  const updated = { ...current, ...newSettings };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: updated });
  return updated;
}

// ============ NOTIFICATIONS ============
function notifyQueueChanged() {
  chrome.runtime.sendMessage({ type: 'QUEUE_CHANGED' }).catch(() => {});
  updateBadge();
}

function notifyHistoryChanged(payload = null) {
  chrome.runtime.sendMessage({ type: 'HISTORY_CHANGED', ...(payload || {}) }).catch(() => {});
}

// ============ EXTENSION ICON BADGE ============
// Red "REC" while recording, orange count of active queue items otherwise
async function updateBadge() {
  try {
    const queue = await getQueue();
    const active = queue.filter(item =>
      item.status === 'recording' || item.status === 'encoding'
    );
    const pending = queue.filter(item => item.status === 'pending').length;

    if (active.length > 0) {
      const rec = active.find(item => item.status === 'recording');
      await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
      await chrome.action.setBadgeText({ text: 'REC' });
      if (rec) {
        await chrome.action.setTitle({
          title: `Recording: ${rec.songName || 'song'}\n${pending} pending in queue`
        });
      }
    } else if (pending > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#ff4500' });
      await chrome.action.setBadgeText({ text: String(pending) });
      await chrome.action.setTitle({ title: `Suno Downloader - ${pending} song(s) queued` });
    } else {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: 'Suno Advanced Downloader' });
    }
  } catch (error) {
    console.warn('Badge update failed:', error);
  }
}

async function showNotification(title, message, type = 'basic') {
  const settings = await getSettings();
  if (!settings.showNotifications) return;
  
  try {
    await chrome.notifications.create({
      type,
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title,
      message,
      priority: 2
    });
  } catch (error) {
    console.warn('Notification failed:', error);
  }
}

// ============ DOWNLOAD HANDLING ============
async function handleDownloadComplete(item) {
  await updateQueueItem(item.id, { 
    status: 'completed', 
    progress: 100, 
    completedAt: Date.now() 
  });
  
  // Add to history
  const historyItem = await addToHistory({
    songName: item.songName,
    artist: item.artist,
    duration: item.duration,
    fileName: item.fileName,
    fileSize: item.fileSize,
    format: item.format,
    downloadUrl: item.downloadUrl,
    pageUrl: item.pageUrl
  });
  
  // Push completion info to all Suno tabs for in-page toast
  const tabs = await chrome.tabs.query({ url: 'https://suno.com/*' });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'DOWNLOAD_COMPLETE',
      songName: item.songName,
      fileName: item.fileName,
      format: item.format,
      fileSize: item.fileSize
    }).catch(() => {});
  }
  
  await showNotification(
    'Download Complete',
    `"${item.songName}" has been downloaded successfully!`
  );
  
  await updateBadge();
  
  // Process next in queue
  processQueue();
}

async function handleDownloadError(item, error) {
  await updateQueueItem(item.id, { 
    status: 'failed', 
    error: error.message 
  });
  
  await showNotification(
    'Download Failed',
    `Failed to download "${item.songName}": ${error.message}`
  );
  
  await updateBadge();
  
  // Process next in queue
  processQueue();
}

// ============ QUEUE PROCESSOR ============
let isProcessing = false;

async function processQueue() {
  if (isProcessing) return;
  
  const queue = await getQueue();
  const pendingItem = queue.find(item => item.status === 'pending');
  
  if (!pendingItem) return;
  
  isProcessing = true;
  await updateQueueItem(pendingItem.id, { status: 'recording', startedAt: Date.now() });
  
  try {
    // Signal content script to start recording
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: 'https://suno.com/*' });
    if (tab) {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'START_RECORDING',
        queueItemId: pendingItem.id,
        songName: pendingItem.songName,
        artist: pendingItem.artist,
        duration: pendingItem.duration
      });
    }
  } catch (error) {
    await handleDownloadError(pendingItem, error);
  } finally {
    isProcessing = false;
  }
}

// ============ MESSAGE HANDLERS ============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'GET_QUEUE':
        sendResponse({ queue: await getQueue() });
        break;
        
      case 'GET_HISTORY':
        sendResponse({ history: await getHistory() });
        break;
        
      case 'GET_SETTINGS':
        sendResponse({ settings: await getSettings() });
        break;
        
      case 'ADD_TO_QUEUE':
        const newItem = await addToQueue(message.item);
        sendResponse({ item: newItem });
        // Auto-process if queue was empty
        processQueue();
        break;
        
      case 'REMOVE_FROM_QUEUE':
        await removeFromQueue(message.id);
        sendResponse({ success: true });
        break;
        
      case 'CLEAR_QUEUE':
        await clearQueue();
        sendResponse({ success: true });
        break;
        
      case 'REMOVE_FROM_HISTORY':
        await removeFromHistory(message.id);
        sendResponse({ success: true });
        break;
        
      case 'CLEAR_HISTORY':
        await clearHistory();
        sendResponse({ success: true });
        break;
        
      case 'UPDATE_SETTINGS':
        const settings = await updateSettings(message.settings);
        sendResponse({ settings });
        break;
        
      case 'RECORDING_COMPLETE':
        // Called from content script when recording finishes
        await handleRecordingComplete(message.queueItemId, message.audioBlob, message.metadata);
        sendResponse({ success: true });
        break;
        
      case 'RECORDING_STARTED':
        await updateQueueItem(message.queueItemId, { status: 'recording', startedAt: Date.now() });
        await updateBadge();
        sendResponse({ success: true });
        break;

      case 'RECORDING_PROGRESS':
        await updateQueueItem(message.queueItemId, { progress: message.progress });
        await updateBadge();
        sendResponse({ success: true });
        break;
        
      case 'RECORDING_ERROR':
        await handleDownloadError(
          { id: message.queueItemId },
          new Error(message.error)
        );
        sendResponse({ success: true });
        break;
        
      case 'OPEN_OFFSCREEN':
        // Open offscreen document for MP3 encoding (only if not already open)
        const existingContexts = await chrome.runtime.getContexts();
        const offscreenDoc = existingContexts.find(
          c => c.contextType === 'OFFSCREEN_DOCUMENT'
        );
        if (!offscreenDoc) {
          await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['AUDIO_PLAYBACK'],
            justification: 'MP3 encoding'
          });
        }
        sendResponse({ success: true });
        break;

      case 'OPEN_POPUP':
        // content scripts cannot open the popup; try action popup, fall back to a new tab
        try {
          await chrome.action.openPopup();
          sendResponse({ success: true, method: 'popup' });
        } catch (err) {
          const popupUrl = chrome.runtime.getURL('popup.html');
          chrome.tabs.create({ url: popupUrl }, () => {
            // Ignore lastError - tab creation is our fallback
            void chrome.runtime.lastError;
            sendResponse({ success: true, method: 'tab' });
          });
        }
        break;

      case 'OPEN_OPTIONS':
        // openOptionsPage fails when no options page is declared - fall back to popup in a tab
        try {
          await new Promise((resolve, reject) => {
            chrome.runtime.openOptionsPage(() => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(true);
            });
          });
          sendResponse({ success: true, method: 'options' });
        } catch (err) {
          const popupUrl = chrome.runtime.getURL('popup.html');
          await chrome.tabs.create({ url: popupUrl });
          sendResponse({ success: true, method: 'tab' });
        }
        break;

      default:
        sendResponse({ error: 'Unknown message type' });
    }
  })();
  
  return true; // Keep channel open for async response
});

// ============ RECORDING COMPLETE HANDLER ============
async function handleRecordingComplete(queueItemId, audioBlob, metadata) {
  const queue = await getQueue();
  const item = queue.find(i => i.id === queueItemId);
  if (!item) return;
  
  await updateQueueItem(queueItemId, { status: 'encoding', progress: 50 });
  
  const settings = await getSettings();
  let finalBlob = audioBlob;
  let format = 'webm';
  let fileName = `${sanitizeFileName(item.songName || 'suno-track')}.webm`;
  
  if (settings.autoConvertToMP3) {
    try {
      // Convert to MP3 using offscreen document
      finalBlob = await convertToMP3(audioBlob, settings.quality);
      format = 'mp3';
      fileName = `${sanitizeFileName(item.songName || 'suno-track')}.mp3`;
    } catch (error) {
      console.warn('MP3 conversion failed, keeping WebM:', error);
    }
  }
  
  // Download the file
  const url = URL.createObjectURL(finalBlob);
  await chrome.downloads.download({
    url,
    filename: `${settings.downloadFolder}/${fileName}`,
    saveAs: false
  });
  
  URL.revokeObjectURL(url);
  
  await handleDownloadComplete({
    ...item,
    fileName,
    fileSize: finalBlob.size,
    format
  });
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

// ============ MP3 CONVERSION (via offscreen) ============
async function convertToMP3(audioBlob, quality = 192) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    
    channel.port1.onmessage = (event) => {
      if (event.data.type === 'MP3_READY') {
        resolve(event.data.blob);
      } else if (event.data.type === 'MP3_ERROR') {
        reject(new Error(event.data.error));
      }
    };
    
    chrome.runtime.sendMessage(
      { type: 'CONVERT_TO_MP3', audioBlob, quality },
      [channel.port2]
    );
  });
}

// ============ TAB UPDATED - AUTO-DETECT SONGS ============
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.includes('suno.com')) {
    // Check if we should auto-start recording for queued items
    const queue = await getQueue();
    const pending = queue.find(item => item.status === 'pending');
    if (pending && tab.url.includes('suno.com')) {
      // Content script will handle auto-detection
    }
  }
});

// ============ INITIALIZE ============
chrome.runtime.onInstalled.addListener(async () => {
  await initStorage();
  await showNotification('Suno Advanced Downloader', 'Extension installed! Click the icon to configure settings.');
});

// Restore badge state when service worker wakes up
updateBadge();

console.log('Suno Advanced Downloader background service worker loaded');