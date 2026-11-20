// Shared constants and types for Suno Downloader

export const STORAGE_KEYS = {
  QUEUE: 'suno_download_queue',
  HISTORY: 'suno_download_history',
  SETTINGS: 'suno_settings'
};

export const DEFAULT_SETTINGS = {
  autoRecord: true,
  autoConvertToMP3: true,
  quality: 192,
  downloadFolder: 'Suno Downloads',
  showNotifications: true,
  keepHistory: true,
  maxHistoryItems: 100
};

export const QUEUE_STATUSES = {
  PENDING: 'pending',
  RECORDING: 'recording',
  ENCODING: 'encoding',
  DOWNLOADING: 'downloading',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

export const ACTIVE_STATUSES = [
  QUEUE_STATUSES.RECORDING,
  QUEUE_STATUSES.ENCODING,
  QUEUE_STATUSES.DOWNLOADING
];

export const MESSAGE_TYPES = {
  // Queue operations
  GET_QUEUE: 'GET_QUEUE',
  ADD_TO_QUEUE: 'ADD_TO_QUEUE',
  REMOVE_FROM_QUEUE: 'REMOVE_FROM_QUEUE',
  CLEAR_QUEUE: 'CLEAR_QUEUE',
  RETRY_QUEUE_ITEM: 'RETRY_QUEUE_ITEM',
  QUEUE_CHANGED: 'QUEUE_CHANGED',
  
  // History
  GET_HISTORY: 'GET_HISTORY',
  REMOVE_FROM_HISTORY: 'REMOVE_FROM_HISTORY',
  CLEAR_HISTORY: 'CLEAR_HISTORY',
  HISTORY_CHANGED: 'HISTORY_CHANGED',
  
  // Settings
  GET_SETTINGS: 'GET_SETTINGS',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  
  // Recording
  START_RECORDING: 'START_RECORDING',
  STOP_RECORDING: 'STOP_RECORDING',
  DIRECT_DOWNLOAD: 'DIRECT_DOWNLOAD',
  RECORDING_STARTED: 'RECORDING_STARTED',
  RECORDING_PROGRESS: 'RECORDING_PROGRESS',
  RECORDING_COMPLETE: 'RECORDING_COMPLETE',
  RECORDING_ERROR: 'RECORDING_ERROR',
  
  // Encoding/Download
  ENCODING_PROGRESS: 'ENCODING_PROGRESS',
  DOWNLOAD_PROGRESS: 'DOWNLOAD_PROGRESS',
  DOWNLOAD_COMPLETE: 'DOWNLOAD_COMPLETE',
  CONVERT_TO_MP3: 'CONVERT_TO_MP3',
  
  // Metadata
  GET_METADATA: 'GET_METADATA',
  GET_PLAY_STATE: 'GET_PLAY_STATE',
  GET_PLAYBACK_INFO: 'GET_PLAYBACK_INFO',
  GET_AUDIO_URL: 'GET_AUDIO_URL',
  
  // UI
  OPEN_POPUP: 'OPEN_POPUP',
  OPEN_OFFSCREEN: 'OPEN_OFFSCREEN',
  OPEN_OPTIONS: 'OPEN_OPTIONS',
  CONTENT_SCRIPT_READY: 'CONTENT_SCRIPT_READY',
  PING: 'PING',

  // Extension-wide lifecycle events (delivered to side panel + popup)
  DOWNLOAD_STARTED: 'DOWNLOAD_STARTED',
  FETCH_PROGRESS: 'FETCH_PROGRESS',
  PIPELINE_STAGE: 'PIPELINE_STAGE',
  ACTIVITY: 'ACTIVITY',
  
  // Offscreen
  MP3_PROGRESS: 'MP3_PROGRESS',
  MP3_READY: 'MP3_READY',
  MP3_ERROR: 'MP3_ERROR',
  CREATE_BLOB_URL: 'CREATE_BLOB_URL',
  REVOKE_BLOB_URL: 'REVOKE_BLOB_URL',
  FETCH_AUDIO: 'FETCH_AUDIO',
  FETCH_AUDIO_PROGRESS: 'FETCH_AUDIO_PROGRESS'
};

export const SUNO_URL_PATTERNS = [
  'https://suno.com/*',
  'https://*.suno.com/*'
];

export const PLAYBAR_SELECTORS = [
  '[data-playbar="true"]',
  '[data-testid="player-bar"]',
  '[data-testid="playback-bar"]',
  'div[class*="playbar"]',
  'div[class*="Playbar"]',
  'footer[class*="fixed"][class*="bottom"]',
  'footer[class*="player"]',
  'div[role="region"][aria-label*="player" i]',
  'div[class*="player-bar"]'
];

export const AUDIO_SELECTORS = [
  'audio#active-audio-play',
  'audio[data-testid="audio-player"]',
  'audio[id*="audio-play"]:not(#silent-audio)',
  'audio[class*="player"]',
  'audio[controls]',
  'audio:not(#silent-audio)',
  'video'
];

export const EXCLUDED_TEXTS = [
  'explore', 'library', 'create', 'suno', 'home', 'search', 
  'playlist', 'my library', 'liked songs', 'for you'
];

export const EXCLUDED_ARTIST_TEXTS = [
  'explore', 'library', 'create', 'suno', 'home', 'search', 'playlist'
];

export const RECORDING_CONFIG = {
  MIME_TYPES: ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'],
  CHUNK_INTERVAL_MS: 100,
  PROGRESS_INTERVAL_MS: 1000,
  MAX_DURATION_BUFFER_MS: 10000,
  DEFAULT_DURATION_MS: 180000
};

export const MP3_ENCODER_CONFIG = {
  SAMPLE_RATE: 44100,
  CHUNK_SIZE: 1152,
  PROGRESS_THROTTLE: 10
};

export function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} hours ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} days ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function sanitizeFileName(name) {
  const clean = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim()
    .replace(/^\.+/, '')
    .substring(0, 150)
    .replace(/[. ]+$/, '');
  return clean || 'suno-track';
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 11);
}

export function isSunoUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'suno.com' || host.endsWith('.suno.com');
  } catch (e) {
    return false;
  }
}

// ---- Binary <-> string helpers -------------------------------------------
// chrome.runtime.sendMessage serialises with JSON by default, so ArrayBuffers
// arrive as `{}`. Audio is therefore sent between extension contexts as base64.
export function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function blobToBase64(blob) {
  return bufferToBase64(await blob.arrayBuffer());
}

// Sub-folder for chrome.downloads: no "..", no drive letters, no invalid chars.
export function sanitizeFolder(folder) {
  const parts = String(folder || '')
    .split(/[\\/]+/)
    .map((p) => p.replace(/[<>:"|?*\x00-\x1F]/g, '_').replace(/^\.+|\.+$/g, '').trim())
    .filter(Boolean);
  return parts.join('/');
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// Only allow http(s) image URLs into <img src> (scraped from the page).
export function safeImageUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : '';
  } catch (e) {
    return '';
  }
}
