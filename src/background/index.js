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
  SUNO_URL_PATTERNS,
  base64ToBuffer,
  blobToBase64,
  sanitizeFolder
} from '../shared/constants.js';

import {
  getQueue, saveQueue,
  getHistory, saveHistory,
  getSettings, saveSettings
} from '../shared/storage.js';

// ============ STATE ============
let isProcessing = false;
let activeRecordingId = null;

// ============ OFFSCREEN DOCUMENT HELPERS ============
// The service worker has no DOM, so blob URLs and MP3 encoding are delegated
// to the offscreen document, which owns a real window and AudioContext.
async function ensureOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (contexts.length > 0) return;
  } catch (e) {
    // Older Chrome without getContexts - fall through and try to create
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
      justification: 'Encode recorded audio to MP3 and create blob URLs for downloads'
    });
  } catch (e) {
    if (!/already exists|only one offscreen/i.test(e.message || '')) throw e;
  }
}

// ============ OFFSCREEN REQUESTS ============
// chrome.runtime.sendMessage does NOT support transferable MessagePorts,
// so we use plain request/response with a __reqId correlation map instead.
// The offscreen document replies via chrome.runtime.sendMessage; background
// routes those replies to the right caller via offscreenCallbacks.
const offscreenCallbacks = new Map();
let offscreenReqId = 0;

function resolveOffscreenReq(id, data) {
  const cb = offscreenCallbacks.get(id);
  if (!cb) return;
  offscreenCallbacks.delete(id);
  if (data.error) cb.reject(new Error(data.error));
  else if (data.b64 !== undefined) cb.resolve(new Blob([base64ToBuffer(data.b64)], { type: data.mimeType || '' }));
  else if (data.url !== undefined) cb.resolve(data.url);
  else cb.resolve(data);
}

function rejectOffscreenReq(id, error) {
  const cb = offscreenCallbacks.get(id);
  if (!cb) return;
  offscreenCallbacks.delete(id);
  cb.reject(new Error(error));
}

function offscreenProgress(id, progress) {
  const cb = offscreenCallbacks.get(id);
  if (cb?.onProgress) cb.onProgress(progress);
}

// Ask the offscreen document to create an object URL for a Blob.
// Binary data crosses extension contexts as base64 (runtime messaging is
// JSON-serialised in Chrome, which turns ArrayBuffers into `{}`).
function createBlobUrl(blob) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const b64 = await blobToBase64(blob);
        const id = ++offscreenReqId;
        offscreenCallbacks.set(id, { resolve, reject });
        chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.CREATE_BLOB_URL,
          b64,
          mimeType: blob.type,
          __reqId: id
        }).catch(() => {}); // Response arrives via correlation map, not sendResponse
      } catch (error) {
        console.warn('createBlobUrl failed:', error);
        reject(error);
      }
    })();
  });
}

function revokeBlobUrl(url) {
  if (!url) return;
  try {
    chrome.runtime.sendMessage({ type: MESSAGE_TYPES.REVOKE_BLOB_URL, url }).catch(() => {});
  } catch (e) { /* best effort */ }
}

// Fetch a Suno audio URL inside the offscreen document (which has a real fetch
// with host permissions). Avoids captureStream() silence on cross-origin media.
function fetchAudio(url, onProgress) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const id = ++offscreenReqId;
        offscreenCallbacks.set(id, { resolve, reject, onProgress });
        chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.FETCH_AUDIO,
          url,
          __reqId: id
        }).catch(() => {}); // Response arrives via correlation map, not sendResponse
      } catch (e) {
        reject(e);
      }
    })();
  });
}

// Encode audio to MP3 inside the offscreen document.
function convertToMP3(audioBlob, quality = 192, onProgress) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const b64 = await blobToBase64(audioBlob);
        const id = ++offscreenReqId;
        offscreenCallbacks.set(id, { resolve, reject, onProgress });
        chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.CONVERT_TO_MP3,
          b64,
          quality,
          __reqId: id
        }).catch(() => {}); // Response arrives via correlation map, not sendResponse
      } catch (error) {
        console.warn('convertToMP3 failed:', error);
        reject(error); // never pretend a WebM is an MP3
      }
    })();
  });
}

// Download a Blob by creating its object URL in the offscreen document.
// The URL is kept alive until Chrome reports the download finished.
async function downloadBlob(blob, filename) {
  const url = await createBlobUrl(blob);
  let downloadId;
  try {
    await new Promise((resolve, reject) => {
      const onChange = (delta) => {
        if (downloadId === undefined || delta.id !== downloadId) return;
        if (delta.error) done(new Error(delta.error.current || 'Download failed'));
        else if (delta.state && delta.state.current === 'complete') done();
        else if (delta.state && delta.state.current === 'interrupted') done(new Error('Download interrupted'));
      };
      const done = (err) => {
        chrome.downloads.onChanged.removeListener(onChange);
        if (err) reject(err); else resolve();
      };
      chrome.downloads.onChanged.addListener(onChange);
      chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' })
        .then((id) => { downloadId = id; })
        .catch(done);
    });
  } finally {
    revokeBlobUrl(url);
  }
  return downloadId;
}

// ============ INITIALIZATION ============
// Defaults only. The service worker wakes up many times per session, so this
// must NOT touch in-flight items (see resumeQueue, called on startup/install).
async function initStorage() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.QUEUE,
    STORAGE_KEYS.HISTORY
  ]);
  const defaults = {};
  if (!result[STORAGE_KEYS.SETTINGS]) defaults[STORAGE_KEYS.SETTINGS] = DEFAULT_SETTINGS;
  if (!result[STORAGE_KEYS.QUEUE]) defaults[STORAGE_KEYS.QUEUE] = [];
  if (!result[STORAGE_KEYS.HISTORY]) defaults[STORAGE_KEYS.HISTORY] = [];
  if (Object.keys(defaults).length) await chrome.storage.local.set(defaults);
}

// Called once per browser start / extension install: anything still marked
// "in progress" was killed with the previous session, so mark it retryable.
async function resumeQueue() {
  try {
    const queue = await getQueue();
    const interrupted = queue.filter((item) => ACTIVE_STATUSES.includes(item.status));
    for (const item of interrupted) {
      await updateQueueItem(item.id, {
        status: QUEUE_STATUSES.FAILED,
        error: 'Interrupted - click retry to restart',
        progress: 0
      });
    }
    await updateBadge();
  } catch (err) {
    console.error('resumeQueue failed:', err);
  }
}

initStorage().catch((err) => console.error('initStorage failed:', err));

// ============ STORAGE LOCK ============
// Queue/history updates are read-modify-write on chrome.storage. Without
// serialisation two quick updates (e.g. a progress tick racing a status change)
// overwrite each other and items get lost or revert to old states.
function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}
const withQueueLock = createLock();
const withHistoryLock = createLock();

// ============ QUEUE MANAGEMENT ============
async function addToQueue(item) {
  const newItem = await withQueueLock(async () => {
    const queue = await getQueue();
    const created = {
      id: generateId(),
      status: QUEUE_STATUSES.PENDING,
      ...item,
      progress: 0,
      addedAt: Date.now(),
      startedAt: null,
      completedAt: null
    };
    queue.push(created);
    await saveQueue(queue);
    return created;
  });
  notifyQueueChanged();
  await updateBadge();
  return newItem;
}

// `onlyIfStatuses` makes late/stale updates (e.g. a progress tick that arrives
// after the item already completed) harmless no-ops.
async function updateQueueItem(id, updates, onlyIfStatuses = null) {
  const updated = await withQueueLock(async () => {
    const queue = await getQueue();
    const index = queue.findIndex((item) => item.id === id);
    if (index === -1) return null;
    if (onlyIfStatuses && !onlyIfStatuses.includes(queue[index].status)) return null;
    queue[index] = { ...queue[index], ...updates };
    await saveQueue(queue);
    return queue[index];
  });
  if (updated) notifyQueueChanged();
  return updated;
}

async function removeFromQueue(id) {
  await withQueueLock(async () => {
    const queue = await getQueue();
    await saveQueue(queue.filter((item) => item.id !== id));
  });
  notifyQueueChanged();
  await updateBadge();
}

async function clearQueue() {
  await withQueueLock(() => saveQueue([]));
  notifyQueueChanged();
  await updateBadge();
}

// ============ HISTORY MANAGEMENT ============
async function addToHistory(item) {
  const { keepHistory } = await getSettings();
  if (keepHistory === false) return null;
  const newItem = await withHistoryLock(async () => {
    const history = await getHistory();
    const created = { id: generateId(), ...item, downloadedAt: Date.now() };
    history.unshift(created);
    await saveHistory(history);
    return created;
  });
  notifyHistoryChanged();
  return newItem;
}

async function removeFromHistory(id) {
  await withHistoryLock(async () => {
    const history = await getHistory();
    await saveHistory(history.filter((item) => item.id !== id));
  });
  notifyHistoryChanged();
}

async function clearHistory() {
  await withHistoryLock(() => saveHistory([]));
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

// Push a message to every open Suno tab's content script (suno.com + subdomains).
async function notifyContentScript(message) {
  await broadcastToSunoTabs(message);
}

// Broadcast a lifecycle event to every extension surface (side panel + popup).
// Each stage of the pipeline emits one of these so the UI can show live
// per-step progress with no polling.
function emit(type, payload = {}) {
  try {
    chrome.runtime.sendMessage({ type, at: Date.now(), ...payload }).catch(() => {});
  } catch (e) { /* no receivers - fine */ }
}

function stage(name, progress, label, extra = {}) {
  emit(MESSAGE_TYPES.PIPELINE_STAGE, { stage: name, progress, label, ...extra });
}

async function broadcastToSunoTabs(message) {
  try {
    const tabs = await chrome.tabs.query({ url: SUNO_URL_PATTERNS });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  } catch (error) {
    console.debug('broadcastToSunoTabs:', error.message);
  }
}

// Forward a message to the active Suno tab's content script and relay its
// response. Used for GET_METADATA / GET_PLAY_STATE / STOP_RECORDING which the
// popup sends here but only the content script can answer.
async function forwardToContent(message) {
  const tabs = await chrome.tabs.query({ url: SUNO_URL_PATTERNS });
  // Prefer the tab that is actually making sound, then a focused one.
  const tab = tabs.find(t => t.audible) || tabs.find(t => t.active) || tabs[0];
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    console.debug('forwardToContent:', e.message);
    return null;
  }
}

// ============ DOWNLOAD HANDLING ============
async function handleDownloadComplete(item) {
  await updateQueueItem(item.id, {
    status: QUEUE_STATUSES.COMPLETED,
    progress: 100,
    completedAt: Date.now(),
    fileName: item.fileName,
    fileSize: item.fileSize,
    format: item.format,
    downloadId: item.downloadId
  });

  await addToHistory({
    songName: item.songName,
    artist: item.artist,
    duration: item.duration,
    fileName: item.fileName,
    fileSize: item.fileSize,
    format: item.format,
    downloadId: item.downloadId,
    pageUrl: item.pageUrl,
    coverUrl: item.coverUrl
  });

  stage('done', 100, 'Complete');
  emit(MESSAGE_TYPES.ACTIVITY, { level: 'ok', text: `Saved ${item.fileName} (${formatFileSize(item.fileSize)})` });

  // Push completion info to all Suno tabs for in-page state
  await broadcastToSunoTabs({
    type: MESSAGE_TYPES.DOWNLOAD_COMPLETE,
    songName: item.songName,
    fileName: item.fileName,
    format: item.format,
    fileSize: item.fileSize
  });
  emit(MESSAGE_TYPES.DOWNLOAD_COMPLETE, {
    songName: item.songName, fileName: item.fileName, format: item.format,
    fileSize: item.fileSize, downloadId: item.downloadId
  });

  await showNotification('Download Complete', `"${item.songName}" has been downloaded.`);
  await updateBadge();
  processQueue();
}

async function handleDownloadError(item, error) {
  const errMsg = error?.message || String(error);
  const queue = await getQueue();
  const stored = queue.find((q) => q.id === item.id);
  // Already reported (e.g. content script + background both saw the failure)
  if (stored && stored.status === QUEUE_STATUSES.FAILED && stored.error) return;

  const name = item.songName || stored?.songName || 'this song';
  await updateQueueItem(item.id, { status: QUEUE_STATUSES.FAILED, error: errMsg });

  stage('error', 0, 'Failed', { error: errMsg });
  emit(MESSAGE_TYPES.ACTIVITY, { level: 'error', text: `${name}: ${errMsg}` });
  await broadcastToSunoTabs({ type: MESSAGE_TYPES.RECORDING_ERROR, error: errMsg });
  await showNotification('Download Failed', `Failed to download "${name}": ${errMsg}`);
  await updateBadge();
  processQueue();
}

// ============ QUEUE PROCESSOR ============
// Only ONE item may be active at a time: the content script owns a single
// MediaRecorder, so overlapping START_RECORDING calls would corrupt each other.
async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    const queue = await getQueue();
    if (queue.some((item) => ACTIVE_STATUSES.includes(item.status))) return;
    const next = queue.find((item) => item.status === QUEUE_STATUSES.PENDING);
    if (!next) return;

    await updateQueueItem(next.id, { status: QUEUE_STATUSES.RECORDING, startedAt: Date.now(), progress: 0 });
    try {
      await ensureOffscreenDocument();
      const res = await forwardToContent({
        type: MESSAGE_TYPES.START_RECORDING,
        queueItemId: next.id,
        metadata: {
          songName: next.songName, artist: next.artist, duration: next.duration,
          pageUrl: next.pageUrl, coverUrl: next.coverUrl
        }
      });
      if (!res) throw new Error('No Suno tab found. Open suno.com and play the song, then retry.');
      // res.success === false means the content script already reported why.
    } catch (error) {
      await handleDownloadError(next, error);
    }
  } finally {
    isProcessing = false;
  }
}

// ============ RECORDING COMPLETE HANDLER ============
const MIN_VALID_AUDIO_BYTES = 2048;

async function handleRecordingComplete(queueItemId, audioBlob) {
  const queue = await getQueue();
  const item = queue.find((i) => i.id === queueItemId);
  if (!item) return;

  try {
    if (!audioBlob || audioBlob.size < MIN_VALID_AUDIO_BYTES) {
      throw new Error('Recording came out empty - the page may have blocked audio capture. Make sure the song is playing and not muted, then retry.');
    }

    await ensureOffscreenDocument();
    stage('record', 100, 'Captured');
    const settings = await getSettings();
    const current = (await getQueue()).find((i) => i.id === queueItemId) || item;
    const base = sanitizeFileName(current.songName || 'suno-track');
    let finalBlob = audioBlob;
    let format = 'webm';

    if (settings.autoConvertToMP3) {
      await updateQueueItem(queueItemId, { status: QUEUE_STATUSES.ENCODING, progress: 0 });
      stage('encode', 0, 'Encoding MP3');
      try {
        finalBlob = await convertToMP3(audioBlob, settings.quality, (progress) => {
          stage('encode', progress, 'Encoding MP3');
          updateQueueItem(queueItemId, { progress }, [QUEUE_STATUSES.ENCODING]);
        });
        format = 'mp3';
      } catch (error) {
        console.warn('MP3 conversion failed, keeping WebM:', error);
        finalBlob = audioBlob;
        emit(MESSAGE_TYPES.ACTIVITY, { level: 'warn', text: `MP3 encoding failed (${error.message}); saving as WebM instead` });
      }
    }

    const fileName = `${base}.${format}`;
    const folder = sanitizeFolder(settings.downloadFolder);
    await updateQueueItem(queueItemId, { status: QUEUE_STATUSES.DOWNLOADING, progress: 95 });
    stage('download', 50, 'Saving file');

    // URL.createObjectURL is unavailable in the MV3 service worker, so the
    // object URL is created inside the offscreen document.
    const downloadId = await downloadBlob(finalBlob, folder ? `${folder}/${fileName}` : fileName);

    // Re-read: RECORDING_STARTED may have refined the title/artist after auto-play.
    const fresh = (await getQueue()).find((i) => i.id === queueItemId) || item;
    await handleDownloadComplete({ ...fresh, fileName, fileSize: finalBlob.size, format, downloadId });
  } catch (error) {
    console.error('handleRecordingComplete failed:', error);
    await handleDownloadError(item, error);
  }
}

// ============ ONE-CLICK RECORDING DOWNLOAD ============
async function directDownload() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    const queue = await getQueue();
    if (queue.some((item) => ACTIVE_STATUSES.includes(item.status))) {
      throw new Error('Another download is already in progress.');
    }

    stage('detect', 2, 'Ready');
    await ensureOffscreenDocument();

    // Ask the Suno tab what it can see. The song does NOT have to be playing:
    // the content script starts playback itself before recording.
    stage('detect', 8, 'Detect');
    const info = await forwardToContent({ type: MESSAGE_TYPES.GET_METADATA });
    if (!info || !info.metadata) {
      throw new Error('No Suno tab found. Open the song on suno.com first.');
    }
    const meta = info.metadata;
    const songLabel = (meta.songName && meta.songName !== 'Suno Song')
      ? meta.songName : 'Suno Track';
    stage('detect', 100, `"${songLabel}" found`);
    stage('record', 0, 'Starting playback');

    // Created as RECORDING so processQueue() can never grab it as "pending".
    const queueItem = await addToQueue({
      songName: meta.songName || 'Suno Track',
      artist: meta.artist || 'Unknown',
      duration: meta.duration,
      pageUrl: meta.pageUrl || '',
      coverUrl: meta.coverUrl,
      status: QUEUE_STATUSES.RECORDING,
      startedAt: Date.now()
    });

    emit(MESSAGE_TYPES.DOWNLOAD_STARTED, { songName: songLabel, metadata: meta });
    const res = await forwardToContent({
      type: MESSAGE_TYPES.START_RECORDING,
      queueItemId: queueItem.id,
      metadata: meta
    });
    if (!res) {
      await handleDownloadError(queueItem, new Error('Could not reach the Suno tab. Reload the page and try again.'));
    }
    // res.success === false: content script already reported the reason.
  } catch (error) {
    const errMsg = error?.message || String(error);
    console.error('directDownload error:', errMsg);
    stage('error', 0, 'Failed', { error: errMsg });
    emit(MESSAGE_TYPES.ACTIVITY, { level: 'error', text: errMsg });
    await broadcastToSunoTabs({ type: MESSAGE_TYPES.RECORDING_ERROR, error: errMsg });
    await showNotification('Download Failed', errMsg);
  } finally {
    isProcessing = false;
  }
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

        // Popup asks the background, but only the content script can read the
        // page DOM / stop the recorder - forward and relay the response.
        case MESSAGE_TYPES.GET_METADATA:
        case MESSAGE_TYPES.GET_PLAY_STATE:
        case MESSAGE_TYPES.GET_PLAYBACK_INFO:
        case MESSAGE_TYPES.GET_AUDIO_URL:
        case MESSAGE_TYPES.STOP_RECORDING: {
          const res = await forwardToContent(message);
          sendResponse(res || {});
          break;
        }
          
        case MESSAGE_TYPES.ADD_TO_QUEUE: {
          const newItem = await addToQueue(message.item);
          sendResponse({ item: newItem });
          processQueue();
          break;
        }
          
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
          
        case MESSAGE_TYPES.UPDATE_SETTINGS: {
          const merged = { ...(await getSettings()), ...(message.settings || {}) };
          await saveSettings(merged);
          sendResponse({ settings: merged });
          break;
        }
          
        case MESSAGE_TYPES.DIRECT_DOWNLOAD: {
          // One-click download from the floating button: grab the playing
          // audio URL from the content script, fetch it offscreen and save.
          sendResponse({ started: true });
          directDownload().catch((e) => console.error('directDownload:', e));
          break;
        }

        case MESSAGE_TYPES.RECORDING_COMPLETE: {
          // Audio arrives base64-encoded (JSON messaging can't carry ArrayBuffers).
          // Ack immediately; encoding + saving can take a while.
          sendResponse({ success: true });
          if (message.queueItemId && message.b64) {
            const audioBlob = new Blob([base64ToBuffer(message.b64)], { type: message.mimeType || 'audio/webm' });
            handleRecordingComplete(message.queueItemId, audioBlob)
              .catch((e) => console.error('handleRecordingComplete:', e));
          }
          break;
        }
          
        case MESSAGE_TYPES.RECORDING_STARTED:
          await updateQueueItem(message.queueItemId, { status: QUEUE_STATUSES.RECORDING, startedAt: Date.now(), ...(message.metadata || {}) }, [QUEUE_STATUSES.PENDING, QUEUE_STATUSES.RECORDING]);
          if (message.metadata?.songName) emit(MESSAGE_TYPES.DOWNLOAD_STARTED, { songName: message.metadata.songName, metadata: message.metadata });
          await updateBadge();
          sendResponse({ success: true });
          break;
          
        case MESSAGE_TYPES.RECORDING_PROGRESS:
          await updateQueueItem(message.queueItemId, { progress: message.progress }, [QUEUE_STATUSES.RECORDING]);
          await updateBadge();
          sendResponse({ success: true });
          break;
          
        case MESSAGE_TYPES.RECORDING_ERROR:
          if (message.queueItemId) {
            await handleDownloadError({ id: message.queueItemId }, new Error(message.error));
          }
          sendResponse({ success: true });
          break;
          
        case MESSAGE_TYPES.OPEN_OFFSCREEN:
          await ensureOffscreenDocument();
          sendResponse({ success: true });
          break;
          
        case MESSAGE_TYPES.OPEN_POPUP:
          try {
            await chrome.action.openPopup();
            sendResponse({ success: true, method: 'popup' });
          } catch (err) {
            const popupUrl = chrome.runtime.getURL('src/popup/index.html');
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
            const popupUrl = chrome.runtime.getURL('src/popup/index.html');
            await chrome.tabs.create({ url: popupUrl });
            sendResponse({ success: true, method: 'tab' });
          }
          break;
          
        // Offscreen document replies (routed via __reqId correlation map).
        // Acknowledge receipt so the offscreen sendMessage channel closes cleanly.
        case MESSAGE_TYPES.CREATE_BLOB_URL:
        case MESSAGE_TYPES.MP3_READY:
        case MESSAGE_TYPES.MP3_ERROR:
        case MESSAGE_TYPES.FETCH_AUDIO_PROGRESS:
        case MESSAGE_TYPES.MP3_PROGRESS:
          if (message.__reqId) {
            if (message.type === MESSAGE_TYPES.MP3_ERROR) {
              rejectOffscreenReq(message.__reqId, message.error);
            } else if (
              message.type === MESSAGE_TYPES.FETCH_AUDIO_PROGRESS ||
              message.type === MESSAGE_TYPES.MP3_PROGRESS
            ) {
              offscreenProgress(message.__reqId, message.progress);
            } else {
              resolveOffscreenReq(message.__reqId, message);
            }
          }
          sendResponse({ ok: true });
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

// ============ SIDE PANEL ============
// Opening the side panel is only allowed inside a user gesture, so the toolbar
// click listener calls it directly (not via sendMessage).
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
    if (chrome.sidePanel?.open && tab?.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (e) {
    console.debug('sidePanel open:', e.message);
  }
});

// ============ INITIALIZE ============
chrome.runtime.onInstalled.addListener(async (details) => {
  await initStorage();
  await resumeQueue();
  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
  } catch (e) { /* older Chrome */ }
  if (details.reason === 'install') {
    await showNotification('Suno Advanced Downloader', 'Extension installed! Click the icon to open the panel.');
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await initStorage();
  await resumeQueue();
});

updateBadge();

console.log('Suno Advanced Downloader background service worker loaded');