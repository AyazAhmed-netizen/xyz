// Background Service Worker - Suno Advanced Downloader
// Clean architecture: queue management, recording orchestration, MP3 encoding, notifications

import { 
  STORAGE_KEYS, 
  DEFAULT_SETTINGS, 
  QUEUE_STATUSES, 
  ACTIVE_STATUSES,
  MESSAGE_TYPES,
  RECORDING_CONFIG,
  formatTime,
  formatRelativeTime,
  formatFileSize,
  sanitizeFileName,
  generateId,
  isSunoUrl
} from '../shared/constants.js';

import {
  getQueue, saveQueue,
  getHistory, saveHistory,
  getSettings, saveSettings
} from '../shared/storage.js';

// ============ STATE ============
let isProcessing = false;
let activeRecordingId = null;

// ============ INITIALIZATION ============
async function initStorage() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS, 
    STORAGE_KEYS.QUEUE, 
    STORAGE_KEYS.HISTORY
  ]);
  
  if (!result[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
  if (!result[STORAGE_KEYS.QUEUE]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: [] });
  }
  if (!result[STORAGE_KEYS.HISTORY]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: [] });
  }
  
  await resumeQueue();
}

async function resumeQueue() {
  try {
    const queue = await getQueue();
    const inProgress = queue.filter(item => 
      item.status === QUEUE_STATUSES.RECORDING || 
      item.status === QUEUE_STATUSES.ENCODING ||
      item.status === QUEUE_STATUSES.DOWNLOADING
    );
    
    // Reset stuck items to failed so they can be retried
    for (const item of inProgress) {
      await updateQueueItem(item.id, { 
        status: QUEUE_STATUSES.FAILED, 
        error: 'Interrupted - click retry to restart',
        progress: 0 
      });
    }
    
    await updateBadge();
    
    // Start processing if there are pending items
    const pending = queue.filter(item => item.status === QUEUE_STATUSES.PENDING);
    if (pending.length > 0 && !isProcessing) {
      await processQueue().catch(err => console.error('processQueue failed:', err));
    }
  } catch (err) {
    console.error('resumeQueue failed:', err);
  }
}

initStorage().catch(err => console.error('initStorage failed:', err));

// ============ QUEUE MANAGEMENT ============
async function addToQueue(item) {
  const queue = await getQueue();
  const newItem = {
    id: generateId(),
    ...item,
    status: QUEUE_STATUSES.PENDING,
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
async function addToHistory(item) {
  const history = await getHistory();
  const newItem = {
    id: generateId(),
    ...item,
    downloadedAt: Date.now()
  };
  history.unshift(newItem);
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

// ============ NOTIFICATIONS ============
function notifyQueueChanged() {
  chrome.runtime.sendMessage({ type: MESSAGE_TYPES.QUEUE_CHANGED }).catch(() => {});
  updateBadge();
}

function notifyHistoryChanged() {
  chrome.runtime.sendMessage({ type: MESSAGE_TYPES.HISTORY_CHANGED }).catch(() => {});
}

async function updateBadge() {
  try {
    const queue = await getQueue();
    const active = queue.filter(item => ACTIVE_STATUSES.includes(item.status));
    const pending = queue.filter(item => item.status === QUEUE_STATUSES.PENDING).length;

    if (active.length > 0) {
      const rec = active.find(item => item.status === QUEUE_STATUSES.RECORDING);
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

async function notifyContentScript(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: 'https://suno.com/*' });
    if (tab) {
      await chrome.tabs.sendMessage(tab.id, message);
    }
  } catch (error) {
    console.debug('notifyContentScript:', error.message);
  }
}

async function broadcastToSunoTabs(message) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://suno.com/*' });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  } catch (error) {
    console.debug('broadcastToSunoTabs:', error.message);
  }
}

// ============ DOWNLOAD HANDLING ============
async function handleDownloadComplete(item) {
  await updateQueueItem(item.id, { 
    status: QUEUE_STATUSES.COMPLETED, 
    progress: 100, 
    completedAt: Date.now() 
  });
  
  // Add to history
  await addToHistory({
    songName: item.songName,
    artist: item.artist,
    duration: item.duration,
    fileName: item.fileName,
    fileSize: item.fileSize,
    format: item.format,
    downloadUrl: item.downloadUrl,
    pageUrl: item.pageUrl,
    coverUrl: item.coverUrl
  });
  
  // Push completion info to all Suno tabs for in-page toast
  await broadcastToSunoTabs({
    type: MESSAGE_TYPES.DOWNLOAD_COMPLETE,
    songName: item.songName,
    fileName: item.fileName,
    format: item.format,
    fileSize: item.fileSize
  });
  
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
    status: QUEUE_STATUSES.FAILED, 
    error: error.message 
  });
  
  await showNotification(
    'Download Failed',
    `Failed to download "${item.songName}": ${error.message}`
  );
  
  await updateBadge();
  
  processQueue();
}

// ============ QUEUE PROCESSOR ============
async function processQueue() {
  if (isProcessing) return;
  
  const queue = await getQueue();
  const pendingItem = queue.find(item => item.status === QUEUE_STATUSES.PENDING);
  
  if (!pendingItem) {
    // No pending items - check if we should auto-retry failed items
    // (User must manually click retry - don't auto-retry)
    return;
  }
  
  isProcessing = true;
  await updateQueueItem(pendingItem.id, { status: QUEUE_STATUSES.RECORDING, startedAt: Date.now() });
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: 'https://suno.com/*' });
    if (tab) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: MESSAGE_TYPES.START_RECORDING,
          queueItemId: pendingItem.id,
          songName: pendingItem.songName,
          artist: pendingItem.artist,
          duration: pendingItem.duration,
          pageUrl: pendingItem.pageUrl
        });
      } catch (msgError) {
        throw new Error('Content script not ready - please refresh the Suno page');
      }
    } else {
      throw new Error('No active Suno tab found');
    }
  } catch (error) {
    await handleDownloadError(pendingItem, error);
  } finally {
    isProcessing = false;
  }
}

// ============ RECORDING COMPLETE HANDLER ============
async function handleRecordingComplete(queueItemId, audioBlob, metadata) {
  const queue = await getQueue();
  const item = queue.find(i => i.id === queueItemId);
  if (!item) return;
  
  await updateQueueItem(queueItemId, { status: QUEUE_STATUSES.ENCODING, progress: 0 });
  await notifyContentScript({ type: MESSAGE_TYPES.ENCODING_PROGRESS, queueItemId, progress: 0 });
  
  const settings = await getSettings();
  let finalBlob = audioBlob;
  let format = 'webm';
  let fileName = `${sanitizeFileName(item.songName || 'suno-track')}.webm`;
  
  if (settings.autoConvertToMP3) {
    try {
      finalBlob = await convertToMP3(audioBlob, settings.quality, (progress) => {
        updateQueueItem(queueItemId, { progress: 50 + Math.floor(progress * 0.5) });
        notifyContentScript({ type: MESSAGE_TYPES.ENCODING_PROGRESS, queueItemId, progress: 50 + Math.floor(progress * 0.5) });
      });
      format = 'mp3';
      fileName = `${sanitizeFileName(item.songName || 'suno-track')}.mp3`;
    } catch (error) {
      console.warn('MP3 conversion failed, keeping WebM:', error);
    }
  }
  
  await updateQueueItem(queueItemId, { status: QUEUE_STATUSES.DOWNLOADING, progress: 95 });
  await notifyContentScript({ type: MESSAGE_TYPES.DOWNLOAD_PROGRESS, queueItemId, progress: 95 });
  
  // Download the file
  let url;
  try {
    url = self.URL.createObjectURL(finalBlob);
  } catch (e) {
    console.warn('self.URL.createObjectURL failed, trying URL:', e);
    url = URL.createObjectURL(finalBlob);
  }
  await chrome.downloads.download({
    url,
    filename: `${settings.downloadFolder}/${fileName}`,
    saveAs: false
  });

  try {
    self.URL.revokeObjectURL(url);
  } catch (e) {
    URL.revokeObjectURL(url);
  }
  
  await handleDownloadComplete({
    ...item,
    fileName,
    fileSize: finalBlob.size,
    format
  });
  
  notifyContentScript({ type: MESSAGE_TYPES.DOWNLOAD_COMPLETE, queueItemId });
}

// ============ MP3 CONVERSION (via offscreen) ============
function convertToMP3(audioBlob, quality = 192, onProgress) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    
    channel.port1.onmessage = (event) => {
      if (event.data.type === MESSAGE_TYPES.MP3_READY) {
        resolve(event.data.blob);
      } else if (event.data.type === MESSAGE_TYPES.MP3_ERROR) {
        reject(new Error(event.data.error));
      } else if (event.data.type === MESSAGE_TYPES.MP3_PROGRESS && onProgress) {
        onProgress(event.data.progress);
      }
    };
    
    chrome.runtime.sendMessage(
      { type: MESSAGE_TYPES.CONVERT_TO_MP3, audioBlob, quality },
      [channel.port2]
    );
  });
}

// ============ MESSAGE HANDLERS ============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case MESSAGE_TYPES.GET_QUEUE:
          sendResponse({ queue: await getQueue() });
          break;
          
        case MESSAGE_TYPES.GET_HISTORY:
          sendResponse({ history: await getHistory() });
          break;
          
        case MESSAGE_TYPES.GET_SETTINGS:
          sendResponse({ settings: await getSettings() });
          break;
          
        case MESSAGE_TYPES.ADD_TO_QUEUE:
          const newItem = await addToQueue(message.item);
          sendResponse({ item: newItem });
          processQueue();
          break;
          
        case MESSAGE_TYPES.REMOVE_FROM_QUEUE:
          await removeFromQueue(message.id);
          sendResponse({ success: true });
          break;
          
        case MESSAGE_TYPES.CLEAR_QUEUE:
          await clearQueue();
          sendResponse({ success: true });
          break;
          
        case MESSAGE_TYPES.RETRY_QUEUE_ITEM:
          await updateQueueItem(message.id, { status: QUEUE_STATUSES.PENDING, error: null, progress: 0 });
          sendResponse({ success: true });
          processQueue();
          break;
          
        case MESSAGE_TYPES.REMOVE_FROM_HISTORY:
          await removeFromHistory(message.id);
          sendResponse({ success: true });
          break;
          
        case MESSAGE_TYPES.CLEAR_HISTORY:
          await clearHistory();
          sendResponse({ success: true });
          break;
          
        case MESSAGE_TYPES.UPDATE_SETTINGS:
          const settings = await saveSettings(message.settings);
          sendResponse({ settings });
          break;
          
        case MESSAGE_TYPES.RECORDING_COMPLETE:
          await handleRecordingComplete(message.queueItemId, message.audioBlob, message.metadata);
          sendResponse({ success: true });
          break;
          
        case MESSAGE_TYPES.RECORDING_STARTED:
          await updateQueueItem(message.queueItemId, { status: QUEUE_STATUSES.RECORDING, startedAt: Date.now() });
          await updateBadge();
          sendResponse({ success: true });
          break;
          
        case MESSAGE_TYPES.RECORDING_PROGRESS:
          await updateQueueItem(message.queueItemId, { progress: message.progress });
          await updateBadge();
          sendResponse({ success: true });
          break;
          
        case MESSAGE_TYPES.RECORDING_ERROR:
          await handleDownloadError(
            { id: message.queueItemId },
            new Error(message.error)
          );
          sendResponse({ success: true });
          break;
          
        case MESSAGE_TYPES.OPEN_OFFSCREEN:
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
          
        case MESSAGE_TYPES.OPEN_POPUP:
          try {
            await chrome.action.openPopup();
            sendResponse({ success: true, method: 'popup' });
          } catch (err) {
            const popupUrl = chrome.runtime.getURL('popup.html');
            chrome.tabs.create({ url: popupUrl }, () => {
              void chrome.runtime.lastError;
              sendResponse({ success: true, method: 'tab' });
            });
          }
          break;
          
        case MESSAGE_TYPES.OPEN_OPTIONS:
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
    } catch (error) {
      console.error('Message handler error:', error);
      sendResponse({ error: error.message });
    }
  })();
  
  return true; // Keep channel open for async response
});

// ============ CONVERT_TO_MP3 HANDLER (for offscreen) ============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === MESSAGE_TYPES.CONVERT_TO_MP3) {
    const { audioBlob, quality, ports } = message;
    
    // This runs in service worker - forward to offscreen
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      if (event.data.type === MESSAGE_TYPES.MP3_READY) {
        sendResponse({ type: MESSAGE_TYPES.MP3_READY, blob: event.data.blob });
      } else if (event.data.type === MESSAGE_TYPES.MP3_ERROR) {
        sendResponse({ type: MESSAGE_TYPES.MP3_ERROR, error: event.data.error });
      } else if (event.data.type === MESSAGE_TYPES.MP3_PROGRESS) {
        // Forward progress
        broadcastToSunoTabs({
          type: MESSAGE_TYPES.ENCODING_PROGRESS,
          queueItemId: message.queueItemId,
          progress: 50 + Math.floor(event.data.progress * 0.5)
        });
      }
    };
    
    // Send to offscreen
    chrome.runtime.sendMessage(
      { type: MESSAGE_TYPES.CONVERT_TO_MP3, audioBlob, quality },
      [channel.port2]
    ).catch(() => {});
    
    return true;
  }
});

// ============ TAB UPDATED - AUTO-DETECT SONGS ============
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.includes('suno.com')) {
    const queue = await getQueue();
    const pending = queue.find(item => item.status === QUEUE_STATUSES.PENDING);
    // Content script will handle auto-detection
  }
});

// ============ INITIALIZE ============
chrome.runtime.onInstalled.addListener(async () => {
  await initStorage();
  await showNotification('Suno Advanced Downloader', 'Extension installed! Click the icon to configure settings.');
});

updateBadge();

console.log('Suno Advanced Downloader background service worker loaded');