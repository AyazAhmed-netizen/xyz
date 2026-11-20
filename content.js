// content.js - Advanced Suno Auto-Recorder with Metadata Extraction & Queue Support

// ============ STATE MANAGEMENT ============
let isRecording = false;
let mediaRecorder = null;
let chunks = [];
let streamRef = null;
let currentQueueItemId = null;
let currentSongMetadata = null;
let recordingStartTime = null;
let recordingTimer = null;
let observer = null;
let audioElement = null;
let isAutoRecording = false;
let lastPlayState = false;

// ============ UTILITY FUNCTIONS ============
function log(...args) {
  console.log('[Suno Advanced Downloader]', ...args);
}

// ============ EXTENSION CONTEXT GUARD ============
// When the extension is reloaded/updated, this content script becomes orphaned
// and every chrome.runtime.* call throws "Extension context invalidated".
let extensionContextDead = false;

function extensionCtxValid() {
  if (extensionContextDead) return false;
  try {
    return !!chrome.runtime && !!chrome.runtime.id;
  } catch (e) {
    extensionContextDead = true;
    onExtensionContextDead();
    return false;
  }
}

function onExtensionContextDead() {
  log('Extension context invalidated - please reload this page');
  updateDeadBanner();
}

// Promise-based sendMessage that never throws into the console
function safeSend(message) {
  if (!extensionCtxValid()) return Promise.resolve(null);
  return chrome.runtime.sendMessage(message).catch(err => {
    if (err?.message?.includes('Extension context invalidated') ||
        err?.message?.includes('message port closed')) {
      extensionContextDead = true;
      onExtensionContextDead();
    }
    return null;
  });
}

function updateDeadBanner() {
  const statusText = document.getElementById('suno-status-text');
  const statusDot = document.getElementById('suno-status-dot');
  const mainBtn = document.getElementById('suno-main-btn');
  if (statusText) statusText.textContent = 'Extension reloaded - refresh this page (F5)';
  if (statusDot) statusDot.style.background = '#f44336';
  if (mainBtn) {
    mainBtn.style.background = '#666';
    mainBtn.title = 'Reload the page to reconnect the extension';
    mainBtn.onclick = () => window.location.reload();
  }
}

// ============ IN-PAGE TOASTS ============
let toastStylesAdded = false;

function ensureToastStyles() {
  if (toastStylesAdded) return;
  toastStylesAdded = true;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes sunoToastIn { from { opacity: 0; transform: translateX(40px); } to { opacity: 1; transform: translateX(0); } }
    @keyframes sunoToastOut { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(40px); } }
    .suno-toast:hover { border-color: #555 !important; }
  `;
  document.head.appendChild(style);
}

function showInPageToast(title, message, type = 'info', duration = 6000) {
  ensureToastStyles();
  const colors = { info: '#3b82f6', success: '#22c55e', error: '#ef4444', record: '#ff4500' };
  const icons = { info: 'ℹ️', success: '✓', error: '⚠️', record: '⏺️' };

  const toast = document.createElement('div');
  toast.className = 'suno-toast';
  toast.style.cssText = `
    position: fixed; bottom: 90px; right: 20px; z-index: 2147483647;
    max-width: 340px; background: #1a1a1a; color: #fff;
    border: 1px solid #333; border-left: 4px solid ${colors[type] || colors.info};
    border-radius: 12px; padding: 12px 14px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px; line-height: 1.45;
    animation: sunoToastIn 0.3s ease;
    pointer-events: auto; cursor: default;
  `;
  toast.innerHTML = `
    <div style="display:flex; gap:10px; align-items:flex-start;">
      <span style="font-size:15px; flex-shrink:0;">${icons[type] || icons.info}</span>
      <div style="flex:1; min-width:0;">
        <div style="font-weight:600; margin-bottom:2px;">${title}</div>
        <div style="color:#aaa; font-size:12px;">${message}</div>
      </div>
      <button class="suno-toast-close" style="background:none;border:none;color:#666;cursor:pointer;padding:0 0 0 8px;font-size:14px;line-height:1;">✕</button>
    </div>
  `;
  toast.querySelector('.suno-toast-close').addEventListener('click', () => toast.remove());
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'sunoToastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 320);
  }, duration);
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().substring(0, 200);
}

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

// ============ METADATA EXTRACTION ============
function extractSongMetadata() {
  const metadata = {
    songName: null,
    artist: null,
    duration: null,
    coverUrl: null
  };

  // --- 1. Find the bottom player bar (playbar) ---
  const playerBar =
    document.querySelector('[data-playbar="true"]') ||
    document.querySelector('[data-[playbar]]:not([data-[playbar]=""])') ||
    document.querySelector('[data-testid="player-bar"]') ||
    document.querySelector('[data-testid="playback-bar"]') ||
    document.querySelector('div[class*="playbar"]') ||
    document.querySelector('div[class*="Playbar"]') ||
    document.querySelector('footer[class*="fixed"][class*="bottom"]') ||
    document.querySelector('footer[class*="player"]') ||
    document.querySelector('div[role="region"][aria-label*="player" i]') ||
    document.querySelector('div[class*="player-bar"]') ||
    null;

  const scopes = playerBar ? [playerBar] : [];

  if (playerBar) {
    console.log('[Suno Downloader] Found playbar:', playerBar);
  } else {
    console.warn('[Suno Downloader] Playbar NOT found, using page-level fallbacks');
  }

  // --- 2. Song title from player bar ---
  if (!metadata.songName) {
    for (const scope of scopes) {
      if (metadata.songName) break;
      const titleSelectors = [
        '[data-testid="song-title"]',
        '[data-testid="track-title"]',
        '[data-testid="playback-title"]',
        '[class*="SongTitle"]',
        '[class*="TrackTitle"]',
        '[class*="playback-title"]',
        '[class*="song-title"]',
        'h1', 'h2', 'h3', 'h4',
        'span[class*="title"]',
        'div[class*="title"]'
      ];
      for (const selector of titleSelectors) {
        const el = scope.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text && text.length > 1 &&
          !['explore', 'library', 'create', 'suno', 'home', 'search', 'playlist', 'my library', 'liked songs', 'for you'].includes(text.toLowerCase())) {
          metadata.songName = text;
          console.log('[Suno Downloader] Found song name:', text, 'via selector:', selector);
          break;
        }
      }
    }
  }

  // --- 3. Artist from player bar ---
  if (!metadata.artist) {
    for (const scope of scopes) {
      if (metadata.artist) break;
      const artistSelectors = [
        '[data-testid="song-artist"]',
        '[data-testid="track-artist"]',
        '[data-testid="playback-artist"]',
        '[class*="Artist"] a',
        '[class*="artist"] a',
        'a[href^="/@"]',
        '[class*="artist"]',
        '[class*="creator"]',
        '[class*="author"]'
      ];
      for (const selector of artistSelectors) {
        const el = scope.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text && text.length > 1 &&
          !['explore', 'library', 'create', 'suno', 'home', 'search', 'playlist'].includes(text.toLowerCase())) {
          metadata.artist = text;
          console.log('[Suno Downloader] Found artist:', text, 'via selector:', selector);
          break;
        }
      }
    }
  }

  // --- 4. Open Graph / meta tag fallbacks (works on /explore too) ---
  if (!metadata.songName) {
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content ||
                    document.querySelector('meta[name="og:title"]')?.content;
    if (ogTitle && ogTitle.length > 1 && !ogTitle.toLowerCase().includes('suno')) {
      metadata.songName = ogTitle.replace(/\s*\|\s*Suno\s*$/i, '').trim();
      console.log('[Suno Downloader] Found song name from og:title:', metadata.songName);
    }
  }
  if (!metadata.songName) {
    const twitterTitle = document.querySelector('meta[name="twitter:title"]')?.content;
    if (twitterTitle && twitterTitle.length > 1) {
      metadata.songName = twitterTitle.replace(/\s*\|\s*Suno\s*$/i, '').trim();
      console.log('[Suno Downloader] Found song name from twitter:title:', metadata.songName);
    }
  }
  if (!metadata.songName) {
    const t = document.title || '';
    const m = t.match(/^(.+?)\s*[|·]\s*Suno/i);
    if (m && m[1].trim() &&
      !['explore', 'library', 'create', 'suno', 'home', 'search', 'for you'].includes(m[1].trim().toLowerCase())) {
      metadata.songName = m[1].trim();
      console.log('[Suno Downloader] Found song name from document.title:', metadata.songName);
    }
  }

  if (!metadata.artist) {
    const ogArtist = document.querySelector('meta[property="music:creator"]')?.content ||
                     document.querySelector('meta[property="og:artist"]')?.content;
    if (ogArtist && ogArtist.length > 1) {
      metadata.artist = ogArtist.trim();
      console.log('[Suno Downloader] Found artist from meta:', metadata.artist);
    }
  }

  if (!metadata.coverUrl) {
    const ogImage = document.querySelector('meta[property="og:image"]')?.content ||
                    document.querySelector('meta[name="twitter:image"]')?.content;
    if (ogImage) {
      metadata.coverUrl = ogImage;
      console.log('[Suno Downloader] Found cover from og:image:', metadata.coverUrl);
    }
  }

  if (!metadata.duration) {
    const ogDuration = document.querySelector('meta[property="music:duration"]')?.content;
    if (ogDuration) {
      const secs = parseInt(ogDuration, 10);
      if (!isNaN(secs) && secs > 0) {
        metadata.duration = secs;
        console.log('[Suno Downloader] Found duration from music:duration:', metadata.duration);
      }
    }
  }

  // --- 5. Duration from audio element ---
  if (!metadata.duration) {
    const audioEl = findAudioElement();
    if (audioEl && audioEl.duration && !isNaN(audioEl.duration) && isFinite(audioEl.duration) && audioEl.duration > 0) {
      metadata.duration = Math.floor(audioEl.duration);
      console.log('[Suno Downloader] Found duration from audio element:', metadata.duration);
    }
  }

  // --- 6. Duration from UI (player bar or page-level) ---
  if (!metadata.duration) {
    const durationSelectors = [
      '[data-testid="duration"]',
      '[data-testid="playback-duration"]',
      '[data-testid="song-duration"]',
      '[data-testid="track-duration"]',
      '[class*="duration"]',
      '[class*="time"]:not([class*="date"])'
    ];
    for (const selector of durationSelectors) {
      const el = playerBar?.querySelector(selector) || document.querySelector(selector);
      if (el && el.textContent?.trim()) {
        const text = el.textContent.trim();
        const match = text.match(/(\d+):(\d+)/);
        if (match) {
          metadata.duration = parseInt(match[1]) * 60 + parseInt(match[2]);
          console.log('[Suno Downloader] Found duration from UI:', metadata.duration, 'via selector:', selector);
          break;
        }
      }
    }
  }

  // --- 7. Cover image from player bar or page ---
  if (!metadata.coverUrl) {
    const coverSelectors = [
      '[data-testid="song-cover"] img',
      '[data-testid="playback-cover"] img',
      '[data-testid="track-cover"] img',
      '[class*="cover"] img',
      '[class*="artwork"] img',
      '[class*="image"] img',
      'img[alt*="cover"]',
      'img[alt*="artwork"]',
      'img[class*="cover"]',
      'img[class*="artwork"]'
    ];
    for (const selector of coverSelectors) {
      const el = playerBar?.querySelector(selector) || document.querySelector(selector);
      if (el && el.src) {
        metadata.coverUrl = el.src;
        console.log('[Suno Downloader] Found cover:', metadata.coverUrl, 'via selector:', selector);
        break;
      }
    }
  }

  // --- 8. Final fallbacks ---
  if (!metadata.songName) {
    const urlMatch = window.location.href.match(/\/song\/([^/?]+)/);
    if (urlMatch) {
      metadata.songName = decodeURIComponent(urlMatch[1]).replace(/-/g, ' ');
      console.log('[Suno Downloader] Found song name from URL:', metadata.songName);
    } else {
      metadata.songName = 'Suno Song';
    }
  }

  if (!metadata.artist) {
    metadata.artist = 'Unknown Artist';
  }

  console.log('[Suno Downloader] Final metadata:', metadata);
  return metadata;
}

function findAudioElement() {
  // 1. First try to find audio within the playbar scope (currently playing song)
  const playerBar =
    document.querySelector('[data-playbar="true"]') ||
    document.querySelector('[data-[playbar]]:not([data-[playbar]=""])') ||
    document.querySelector('[data-testid="player-bar"]') ||
    document.querySelector('[data-testid="playback-bar"]') ||
    document.querySelector('div[class*="playbar"]') ||
    document.querySelector('div[class*="Playbar"]') ||
    document.querySelector('footer[class*="fixed"][class*="bottom"]') ||
    document.querySelector('footer[class*="player"]') ||
    null;

  if (playerBar) {
    const audioInPlaybar = playerBar.querySelector('audio') || playerBar.querySelector('video');
    if (audioInPlaybar && (audioInPlaybar.src || audioInPlaybar.currentSrc || audioInPlaybar.querySelector('source') || audioInPlaybar.duration)) {
      return audioInPlaybar;
    }
  }

  // 2. Find actively playing audio (not paused, currentTime > 0)
  const allMedia = document.querySelectorAll('audio, video');
  for (const el of allMedia) {
    if (!el.paused && el.currentTime > 0 && el.duration && !isNaN(el.duration) && isFinite(el.duration)) {
      return el;
    }
  }

  // 3. Fallback: any audio/video with valid duration > 0
  for (const el of allMedia) {
    if (el.duration && !isNaN(el.duration) && isFinite(el.duration) && el.duration > 0) {
      return el;
    }
  }

  return null;
}

// ============ PLAY STATE DETECTION ============
function getPlayState() {
  const audioEl = findAudioElement();
  if (audioEl) {
    return !audioEl.paused && !audioEl.ended && audioEl.currentTime > 0;
  }
  
  // Fallback: check play button state
  const playButtons = document.querySelectorAll('button[aria-label*="play" i], button[aria-label*="pause" i], [data-testid*="play"], [data-testid*="pause"]');
  for (const btn of playButtons) {
    const label = btn.getAttribute('aria-label') || '';
    if (label.toLowerCase().includes('pause')) return true;
    if (label.toLowerCase().includes('play') && !label.toLowerCase().includes('pause')) return false;
  }
  
  // Check for playing animation/state
  const playingIndicators = document.querySelectorAll('[class*="playing"], [data-state="playing"], [aria-live="polite"]');
  for (const el of playingIndicators) {
    if (el.textContent?.includes('playing') || el.classList.contains('playing')) return true;
  }
  
  return false;
}

function getCurrentTime() {
  const audioEl = findAudioElement();
  return audioEl ? audioEl.currentTime : 0;
}

function getPlaybackInfo() {
  const audioEl = findAudioElement();
  const duration = getDuration();
  const currentTime = audioEl ? audioEl.currentTime : 0;
  const remaining = duration > currentTime ? duration - currentTime : 0;
  
  return {
    currentTime: Math.floor(currentTime),
    duration: Math.floor(duration),
    remaining: Math.floor(remaining),
    progress: duration > 0 ? (currentTime / duration * 100) : 0,
    isPlaying: audioEl ? (!audioEl.paused && !audioEl.ended && audioEl.currentTime > 0) : false
  };
}

function getDuration() {
  const audioEl = findAudioElement();
  if (audioEl && audioEl.duration && !isNaN(audioEl.duration) && isFinite(audioEl.duration)) {
    return audioEl.duration;
  }
  
  // Fallback: try to parse from UI duration display
  const durationSelectors = [
    '[data-testid="duration"]',
    '[class*="duration"]',
    '[class*="time"]'
  ];
  
  for (const selector of durationSelectors) {
    const el = document.querySelector(selector);
    if (el && el.textContent?.trim()) {
      const text = el.textContent.trim();
      const match = text.match(/(\d+):(\d+)/);
      if (match) {
        return parseInt(match[1]) * 60 + parseInt(match[2]);
      }
    }
  }
  
  return 0;
}

// ============ RECORDING FUNCTIONS ============
async function requestTabAudioPermission() {
  try {
    // First check if we already have permission
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      preferCurrentTab: true,
      selfBrowserSurface: 'include'
    });
    return stream;
  } catch (error) {
    log('getDisplayMedia failed:', error);
    throw error;
  }
}

async function startRecording(queueItemId, metadata) {
  if (isRecording) {
    log('Already recording');
    return false;
  }
  
  currentQueueItemId = queueItemId;
  currentSongMetadata = metadata;
  
  try {
    log('Starting recording for:', metadata.songName);
    
    // Request tab audio
    streamRef = await requestTabAudioPermission();
    
    // Stop video tracks, keep only audio
    streamRef.getVideoTracks().forEach(track => track.stop());
    const audioStream = new MediaStream(streamRef.getAudioTracks());
    
    if (audioStream.getAudioTracks().length === 0) {
      throw new Error('No audio track captured. Please ensure "Share tab audio" is checked.');
    }
    
    // Create MediaRecorder with best available format
    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/webm';
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/mp4';
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = ''; // Let browser decide
    }
    
    const options = mimeType ? { mimeType } : {};
    mediaRecorder = new MediaRecorder(audioStream, options);
    chunks = [];
    
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    
    mediaRecorder.onstop = async () => {
      await onRecordingStop();
    };
    
    // Handle user clicking "Stop Sharing" in browser UI
    audioStream.getAudioTracks()[0].onended = () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        log('Audio track ended (user stopped sharing)');
        mediaRecorder.stop();
      }
    };
    
    // Start recording
    mediaRecorder.start(100); // Collect data every 100ms
    isRecording = true;
    recordingStartTime = Date.now();
    
    // Start progress timer with timeout check
    recordingTimer = setInterval(() => {
      const elapsed = Date.now() - recordingStartTime;
      safeSend({
        type: 'RECORDING_PROGRESS',
        queueItemId: currentQueueItemId,
        progress: Math.min(100, Math.floor((elapsed / (currentSongMetadata.duration * 1000 || 180000)) * 100)),
        elapsed
      });
      
      // Check for song end / timeout
      checkRecordingTimeout();
    }, 1000);
    
    // Notify background
    safeSend({
      type: 'RECORDING_STARTED',
      queueItemId: currentQueueItemId
    });
    
    log('Recording started');
    
    // UX: reassure the user they can keep browsing while recording runs
    showInPageToast(
      isAutoRecording ? 'Auto-recording started' : 'Recording started',
      `"${metadata.songName}" is being recorded in the background. You can browse other songs - check the extension icon (orange REC badge) for progress.`,
      'record',
      8000
    );
    
    return true;
    
  } catch (error) {
    log('Recording failed:', error);
    safeSend({
      type: 'RECORDING_ERROR',
      queueItemId: currentQueueItemId,
      error: error.message
    });
    resetRecordingState();
    return false;
  }
}

async function onRecordingStop() {
  if (recordingTimer) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }
  
  if (chunks.length === 0) {
    log('No audio data recorded');
    safeSend({
      type: 'RECORDING_ERROR',
      queueItemId: currentQueueItemId,
      error: 'No audio recorded. Did you check "Share tab audio"?'
    });
    resetRecordingState();
    return;
  }
  
  // Create blob
  const blob = new Blob(chunks, { type: 'audio/webm' });
  log('Recording complete, blob size:', blob.size);
  
  // UX: tell the user what's happening next
  const finishedSong = currentSongMetadata?.songName || 'Song';
  showInPageToast(
    'Recording finished',
    `"${finishedSong}" is being processed (MP3 conversion + download). Track progress via the extension icon badge.`,
    'info',
    7000
  );
  
  // Send to background for processing
  safeSend({
    type: 'RECORDING_COMPLETE',
    queueItemId: currentQueueItemId,
    audioBlob: blob,
    metadata: currentSongMetadata
  }).catch(() => {});
  
  resetRecordingState();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop(); // onstop → onRecordingStop → resetRecordingState (sends RECORDING_COMPLETE first)
  } else {
    resetRecordingState();
  }
}

function resetRecordingState() {
  isRecording = false;
  mediaRecorder = null;
  chunks = [];
  currentQueueItemId = null;
  currentSongMetadata = null;
  recordingStartTime = null;
  
  if (streamRef) {
    streamRef.getTracks().forEach(track => track.stop());
    streamRef = null;
  }
  
  if (recordingTimer) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }
}

// ============ AUTO-RECORDING LOGIC ============
function checkAndAutoRecord() {
  const playState = getPlayState();
  
  // Detect transition from paused -> playing
  if (playState && !lastPlayState) {
    log('Song started playing - checking queue');
    handleSongStart();
  }
  
  // Detect transition from playing -> paused/ended
  if (!playState && lastPlayState) {
    log('Song stopped/paused - checking if should stop recording');
    handleSongEnd();
  }
  
  lastPlayState = playState;
}

async function handleSongStart() {
  // Check if there's a pending queue item for this song
  try {
    const response = await safeSend({ type: 'GET_QUEUE' });
    const queue = response?.queue || [];
    const pendingItem = queue.find(item => item.status === 'pending');
    
    if (pendingItem) {
      // Check if this song matches the queued song (by name or URL)
      const metadata = extractSongMetadata();
      const isMatch = !pendingItem.songName || 
        pendingItem.songName.toLowerCase() === metadata.songName.toLowerCase() ||
        pendingItem.pageUrl === window.location.href;
      
      if (isMatch) {
        log('Auto-starting recording for queued song:', metadata.songName);
        isAutoRecording = true;
        await startRecording(pendingItem.id, metadata);
      } else {
        // UX: inform the user a different queued song is waiting
        showInPageToast(
          'Queued song waiting',
          `"${pendingItem.songName}" is in the download queue. Play it to start auto-recording, or manage the queue via the extension icon.`,
          'info',
          7000
        );
      }
    }
  } catch (error) {
    log('Error checking queue:', error);
  }
}

function handleSongEnd() {
  if (isAutoRecording && isRecording) {
    log('Song ended - stopping auto-recording');
    stopRecording();
    isAutoRecording = false;
  }
}

// Also check audio duration vs elapsed time to force-stop at song end
function checkRecordingTimeout() {
  if (!isRecording || !currentSongMetadata) return;
  
  const audioEl = findAudioElement();
  const expectedDuration = currentSongMetadata.duration * 1000 || 180000; // default 3 min
  const elapsed = Date.now() - recordingStartTime;
  
  // If we've recorded longer than expected duration + 10s buffer, force stop
  if (elapsed > expectedDuration + 10000) {
    log('Recording timeout - forcing stop (elapsed:', elapsed, 'expected:', expectedDuration, ')');
    stopRecording();
  }
  
  // Also check audio element ended state
  if (audioEl && audioEl.ended && !audioEl.paused) {
    log('Audio element ended - stopping recording');
    stopRecording();
  }
}

// ============ MESSAGE HANDLERS ============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'START_RECORDING':
        // Manual or queued recording start
        let metadata = message.metadata;
        if (!metadata) {
          metadata = extractSongMetadata();
          // Override with message fields from queue (more reliable than re-extraction)
          if (message.songName) metadata.songName = message.songName;
          if (message.artist) metadata.artist = message.artist;
          if (message.duration) metadata.duration = message.duration;
          if (message.pageUrl) metadata.pageUrl = message.pageUrl;
        }
        const success = await startRecording(message.queueItemId, metadata);
        sendResponse({ success });
        break;
        
      case 'STOP_RECORDING':
        stopRecording();
        sendResponse({ success: true });
        break;
        
      case 'GET_METADATA':
        sendResponse({ metadata: extractSongMetadata() });
        break;
        
      case 'GET_PLAY_STATE':
        sendResponse({ 
          isPlaying: getPlayState(),
          currentTime: getCurrentTime(),
          duration: getDuration()
        });
        break;
        
      case 'GET_PLAYBACK_INFO':
        sendResponse({ playbackInfo: getPlaybackInfo() });
        break;
        
      case 'PING':
        sendResponse({ pong: true, isRecording, isAutoRecording });
        break;
        
      case 'DOWNLOAD_COMPLETE':
        showInPageToast(
          'Download complete ✓',
          `"${message.songName}" saved as ${message.format?.toUpperCase() || 'audio'} (${formatFileSize(message.fileSize)}). Check your Downloads folder.`,
          'success',
          8000
        );
        sendResponse({ success: true });
        break;
        
      case 'ENCODING_PROGRESS':
        updatePanelEncodingProgress(message.progress);
        sendResponse({ success: true });
        break;
        
      case 'DOWNLOAD_PROGRESS':
        updatePanelDownloadProgress(message.progress);
        sendResponse({ success: true });
        break;
        
      default:
        sendResponse({ error: 'Unknown message' });
    }
  })();
  return true;
});

// ============ OBSERVER FOR DYNAMIC CONTENT ============
function setupObservers() {
  // Watch for audio element changes
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'AUDIO' || node.tagName === 'VIDEO' || node.querySelector('audio, video')) {
              log('Audio/video element detected');
              audioElement = findAudioElement();
              if (audioElement) {
                setupAudioEventListeners();
              }
            }
          }
        });
      }
    }
  });
  
  observer.observe(document.body, { childList: true, subtree: true });
  
  // Initial audio element
  audioElement = findAudioElement();
  if (audioElement) {
    setupAudioEventListeners();
  }
}

function setupAudioEventListeners() {
  if (!audioElement || audioElement._sunoListenersAdded) return;
  
  audioElement._sunoListenersAdded = true;
  
  audioElement.addEventListener('play', () => {
    log('Audio play event');
    lastPlayState = true;
    checkAndAutoRecord();
  });
  
  audioElement.addEventListener('pause', () => {
    log('Audio pause event');
    lastPlayState = false;
    checkAndAutoRecord();
  });
  
  audioElement.addEventListener('ended', () => {
    log('Audio ended event');
    lastPlayState = false;
    handleSongEnd();
  });
  
  audioElement.addEventListener('timeupdate', () => {
    // Could send progress updates here if needed
  });
}

// ============ PERMISSIONS ============
async function ensurePermissions() {
  try {
    // Check if we can access tabs permission
    const hasTabPermission = await chrome.permissions.contains({ permissions: ['tabs'] });
    if (!hasTabPermission) {
      await chrome.permissions.request({ permissions: ['tabs'] });
    }
    
    // Check downloads permission
    const hasDownloadPermission = await chrome.permissions.contains({ permissions: ['downloads'] });
    if (!hasDownloadPermission) {
      await chrome.permissions.request({ permissions: ['downloads'] });
    }
    
    log('Permissions checked');
  } catch (error) {
    log('Permission error:', error);
  }
}

// ============ FLOATING UI ============
function createFloatingUI() {
  // Remove existing
  const existing = document.getElementById('suno-advanced-ui');
  if (existing) existing.remove();
  
  const container = document.createElement('div');
  container.id = 'suno-advanced-ui';
  container.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    pointer-events: auto;
  `;
  
  container.innerHTML = `
    <div id="suno-main-btn" style="
      width: 56px;
      height: 56px;
      border-radius: 28px;
      background: linear-gradient(135deg, #ff4500, #ff6b35);
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(255, 69, 0, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
    ">
      <svg id="suno-btn-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5">
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="4" fill="white" />
      </svg>
    </div>
    <div id="suno-panel" style="
      position: absolute;
      bottom: 70px;
      right: 0;
      width: 320px;
      background: #1a1a1a;
      border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.5);
      padding: 16px;
      display: none;
      flex-direction: column;
      gap: 12px;
      border: 1px solid #333;
    ">
      <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px; border-bottom: 1px solid #333;">
        <strong style="color: #fff; font-size: 14px;">Suno Advanced Downloader</strong>
        <button id="suno-close-panel" style="background: none; border: none; color: #888; cursor: pointer; padding: 4px;">✕</button>
      </div>
      
      <div id="suno-status" style="color: #aaa; font-size: 12px;">Ready</div>
      
      <div id="suno-current-song" style="display: none;">
        <div style="font-size: 12px; color: #888;">Current Song</div>
        <div id="suno-song-title" style="color: #fff; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">-</div>
        <div id="suno-song-artist" style="color: #888; font-size: 11px;">-</div>
        <div id="suno-song-duration" style="color: #666; font-size: 11px;">-</div>
      </div>
      
      <div id="suno-recording-ui" style="display: none; flex-direction: column; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 8px; color: #ff4500;">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: #ff4500; animation: pulse 1s infinite;"></span>
          <span>Recording...</span>
          <span id="suno-rec-time" style="margin-left: auto; font-variant-numeric: tabular-nums;">0:00</span>
        </div>
        <div style="height: 4px; background: #333; border-radius: 2px; overflow: hidden;">
          <div id="suno-rec-progress" style="height: 100%; background: linear-gradient(90deg, #ff4500, #ff6b35); width: 0%; transition: width 0.3s;"></div>
        </div>
      </div>
      
      <!-- Encoding progress UI -->
      <div id="suno-encoding-ui" style="display: none; flex-direction: column; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 8px; color: #fbbf24;">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: #fbbf24; animation: pulse 1s infinite;"></span>
          <span>Converting to MP3...</span>
          <span id="suno-enc-time" style="margin-left: auto; font-variant-numeric: tabular-nums;">0%</span>
        </div>
        <div style="height: 4px; background: #333; border-radius: 2px; overflow: hidden;">
          <div id="suno-enc-progress" style="height: 100%; background: linear-gradient(90deg, #fbbf24, #fcd34d); width: 0%; transition: width 0.3s;"></div>
        </div>
      </div>
      
      <!-- Download progress UI -->
      <div id="suno-download-ui" style="display: none; flex-direction: column; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 8px; color: #4ade80;">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: #4ade80; animation: pulse 1s infinite;"></span>
          <span>Downloading...</span>
          <span id="suno-dl-time" style="margin-left: auto; font-variant-numeric: tabular-nums;">0%</span>
        </div>
        <div style="height: 4px; background: #333; border-radius: 2px; overflow: hidden;">
          <div id="suno-dl-progress" style="height: 100%; background: linear-gradient(90deg, #4ade80, #22c55e); width: 0%; transition: width 0.3s;"></div>
        </div>
      </div>
      
      <button id="suno-manual-record" style="
        padding: 12px;
        border-radius: 10px;
        border: none;
        background: linear-gradient(135deg, #ff4500, #ff6b35);
        color: white;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.1s;
      ">🎙️ Start Recording</button>
      
      <button id="suno-open-popup" style="
        padding: 10px;
        border-radius: 10px;
        border: 1px solid #333;
        background: transparent;
        color: #fff;
        cursor: pointer;
      ">Open Full Panel →</button>
      
      <div id="suno-queue-preview" style="display: none; max-height: 150px; overflow-y: auto;">
        <div style="font-size: 12px; color: #888; margin-bottom: 8px;">Queue (<span id="suno-queue-count">0</span>)</div>
        <div id="suno-queue-list"></div>
      </div>
    </div>
    <style>
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      #suno-main-btn:hover { transform: scale(1.05); box-shadow: 0 6px 28px rgba(255, 69, 0, 0.6); }
      #suno-main-btn:active { transform: scale(0.95); }
      #suno-manual-record:active { transform: scale(0.98); }
    </style>
  `;
  
  document.body.appendChild(container);
  
  // Event listeners
  const mainBtn = container.querySelector('#suno-main-btn');
  const panel = container.querySelector('#suno-panel');
  const closeBtn = container.querySelector('#suno-close-panel');
  const manualRecordBtn = container.querySelector('#suno-manual-record');
  const openPopupBtn = container.querySelector('#suno-open-popup');
  
  let panelOpen = false;
  
  mainBtn.addEventListener('click', () => {
    panelOpen = !panelOpen;
    panel.style.display = panelOpen ? 'flex' : 'none';
    updatePanelUI();
  });
  
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    panelOpen = false;
    panel.style.display = 'none';
  });
  
  manualRecordBtn.addEventListener('click', async () => {
    const metadata = extractSongMetadata();
    const response = await safeSend({ 
      type: 'ADD_TO_QUEUE', 
      item: { 
        songName: metadata.songName,
        artist: metadata.artist,
        duration: metadata.duration,
        pageUrl: window.location.href
      }
    });
    if (response?.item) {
      updatePanelUI();
      showInPageToast(
        'Added to queue',
        `"${metadata.songName}" queued for ${metadata.duration ? metadata.duration + 's ' : ''}recording & download. It will start automatically - you can keep browsing.`,
        'success',
        6000
      );
    } else {
      showInPageToast('Could not add to queue', 'Extension may have been reloaded - refresh the page (F5).', 'error', 6000);
    }
  });
  
  openPopupBtn.addEventListener('click', async () => {
    if (!extensionCtxValid()) { window.location.reload(); return; }
    const response = await safeSend({ type: 'OPEN_POPUP' });
    if (!response) {
      // Background unreachable - offer reload
      if (confirm('Extension was reloaded. Refresh page to reconnect?')) window.location.reload();
      return;
    }
    // When opened as a tab (fallback), close the floating panel
    if (response?.method === 'tab') {
      panelOpen = false;
      panel.style.display = 'none';
    }
  });
  
  // Close panel when clicking outside
  document.addEventListener('click', (e) => {
    if (panelOpen && !container.contains(e.target)) {
      panelOpen = false;
      panel.style.display = 'none';
    }
  });
  
  // Initial UI update
  updatePanelUI();
  
  // Periodic UI updates
  setInterval(updatePanelUI, 2000);
}

function updatePanelUI() {
  const container = document.getElementById('suno-advanced-ui');
  if (!container) return;
  
  const statusEl = container.querySelector('#suno-status');
  const currentSongEl = container.querySelector('#suno-current-song');
  const songTitleEl = container.querySelector('#suno-song-title');
  const songArtistEl = container.querySelector('#suno-song-artist');
  const songDurationEl = container.querySelector('#suno-song-duration');
  const recordingUiEl = container.querySelector('#suno-recording-ui');
  const encodingUiEl = container.querySelector('#suno-encoding-ui');
  const downloadUiEl = container.querySelector('#suno-download-ui');
  const recTimeEl = container.querySelector('#suno-rec-time');
  const recProgressEl = container.querySelector('#suno-rec-progress');
  const manualRecordBtn = container.querySelector('#suno-manual-record');
  const queuePreviewEl = container.querySelector('#suno-queue-preview');
  const queueCountEl = container.querySelector('#suno-queue-count');
  const queueListEl = container.querySelector('#suno-queue-list');
  const mainBtnIcon = container.querySelector('#suno-btn-icon');
  
  // Update play state using enhanced playback info
  const playbackInfo = getPlaybackInfo();
  const metadata = extractSongMetadata();
  
  if (playbackInfo.isPlaying) {
    statusEl.textContent = `▶ Playing (${formatTime(playbackInfo.currentTime * 1000)} / ${formatTime(playbackInfo.duration * 1000)})`;
    statusEl.style.color = '#4ade80';
    currentSongEl.style.display = 'block';
    songTitleEl.textContent = metadata.songName;
    songArtistEl.textContent = metadata.artist;
    songDurationEl.textContent = playbackInfo.duration > 0 ? formatTime(playbackInfo.duration * 1000) : 'Unknown';
  } else {
    statusEl.textContent = '⏸ Paused / Stopped';
    statusEl.style.color = '#fbbf24';
  }
  
  // Update recording/encoding/download state from queue
  safeSend({ type: 'GET_QUEUE' }).then(response => {
    const queue = response?.queue || [];
    const activeItem = queue.find(item => 
      item.status === 'recording' || item.status === 'encoding' || item.status === 'downloading'
    );
    
    if (activeItem) {
      if (activeItem.status === 'recording') {
        if (recordingUiEl) recordingUiEl.style.display = 'flex';
        if (encodingUiEl) encodingUiEl.style.display = 'none';
        if (downloadUiEl) downloadUiEl.style.display = 'none';
        manualRecordBtn.style.display = 'none';
        
        const elapsed = activeItem.startedAt ? Date.now() - activeItem.startedAt : 0;
        if (recTimeEl) recTimeEl.textContent = formatTime(elapsed);
        
        const expectedDuration = activeItem.duration * 1000 || 180000;
        const progress = Math.min(100, (elapsed / expectedDuration) * 100);
        if (recProgressEl) recProgressEl.style.width = `${progress}%`;
        
        mainBtnIcon.innerHTML = `
          <rect x="6" y="4" width="12" height="16" rx="2" fill="white"/>
        `;
        container.querySelector('#suno-main-btn').style.background = 'linear-gradient(135deg, #dc3545, #ff4500)';
      } else if (activeItem.status === 'encoding') {
        if (recordingUiEl) recordingUiEl.style.display = 'none';
        if (encodingUiEl) encodingUiEl.style.display = 'flex';
        if (downloadUiEl) downloadUiEl.style.display = 'none';
        manualRecordBtn.style.display = 'none';
        
        mainBtnIcon.innerHTML = `
          <rect x="6" y="4" width="12" height="16" rx="2" fill="white"/>
        `;
        container.querySelector('#suno-main-btn').style.background = 'linear-gradient(135deg, #fbbf24, #fcd34d)';
      } else if (activeItem.status === 'downloading') {
        if (recordingUiEl) recordingUiEl.style.display = 'none';
        if (encodingUiEl) encodingUiEl.style.display = 'none';
        if (downloadUiEl) downloadUiEl.style.display = 'flex';
        manualRecordBtn.style.display = 'none';
        
        mainBtnIcon.innerHTML = `
          <rect x="6" y="4" width="12" height="16" rx="2" fill="white"/>
        `;
        container.querySelector('#suno-main-btn').style.background = 'linear-gradient(135deg, #4ade80, #22c55e)';
      }
    } else if (!isRecording) {
      // No active queue item and not recording
      if (recordingUiEl) recordingUiEl.style.display = 'none';
      if (encodingUiEl) encodingUiEl.style.display = 'none';
      if (downloadUiEl) downloadUiEl.style.display = 'none';
      manualRecordBtn.style.display = 'block';
      
      // Reset main button
      mainBtnIcon.innerHTML = `
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="4" fill="white" />
      `;
      container.querySelector('#suno-main-btn').style.background = 'linear-gradient(135deg, #ff4500, #ff6b35)';
    }
    
    // Update queue preview
    const activeCount = queue.filter(item => item.status === 'pending' || item.status === 'recording' || item.status === 'encoding' || item.status === 'downloading').length;
    
    if (activeCount > 0) {
      queuePreviewEl.style.display = 'block';
      queueCountEl.textContent = activeCount;
      
      queueListEl.innerHTML = queue
        .filter(item => item.status !== 'completed' && item.status !== 'failed')
        .map(item => `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; background: #222; border-radius: 6px; margin-bottom: 4px; font-size: 11px;">
            <div style="flex: 1; min-width: 0;">
              <div style="color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.songName || 'Unknown'}</div>
              <div style="color: #888; font-size: 10px;">${item.artist || 'Unknown'} ${item.duration ? `• ${formatTime(item.duration * 1000)}` : ''}</div>
            </div>
            <span style="color: ${item.status === 'recording' ? '#ff4500' : item.status === 'encoding' ? '#fbbf24' : item.status === 'downloading' ? '#4ade80' : '#4ade80'}; font-size: 10px; text-transform: capitalize;">${item.status}</span>
          </div>
        `).join('');
    } else {
      queuePreviewEl.style.display = 'none';
    }
  }).catch(() => {});
  
  // Update queue preview
  safeSend({ type: 'GET_QUEUE' }).then(response => {
    const queue = response?.queue || [];
    const activeCount = queue.filter(item => item.status === 'pending' || item.status === 'recording' || item.status === 'encoding').length;
    
    if (activeCount > 0) {
      queuePreviewEl.style.display = 'block';
      queueCountEl.textContent = activeCount;
      
      queueListEl.innerHTML = queue
        .filter(item => item.status !== 'completed' && item.status !== 'failed')
        .map(item => `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; background: #222; border-radius: 6px; margin-bottom: 4px; font-size: 11px;">
            <div style="flex: 1; min-width: 0;">
              <div style="color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.songName || 'Unknown'}</div>
              <div style="color: #888; font-size: 10px;">${item.artist || 'Unknown'} ${item.duration ? `• ${formatTime(item.duration * 1000)}` : ''}</div>
            </div>
            <span style="color: ${item.status === 'recording' ? '#ff4500' : item.status === 'encoding' ? '#fbbf24' : '#4ade80'}; font-size: 10px; text-transform: capitalize;">${item.status}</span>
          </div>
        `).join('');
    } else {
      queuePreviewEl.style.display = 'none';
    }
  }).catch(() => {});
}

// Progress handler functions for panel
function updatePanelEncodingProgress(progress) {
  const container = document.getElementById('suno-advanced-ui');
  if (!container) return;
  
  const recordingUiEl = container.querySelector('#suno-recording-ui');
  const encodingUiEl = container.querySelector('#suno-encoding-ui');
  const downloadUiEl = container.querySelector('#suno-download-ui');
  const encProgressEl = container.querySelector('#suno-enc-progress');
  const encTimeEl = container.querySelector('#suno-enc-time');
  
  if (recordingUiEl) recordingUiEl.style.display = 'none';
  if (encodingUiEl) encodingUiEl.style.display = 'flex';
  if (downloadUiEl) downloadUiEl.style.display = 'none';
  
  if (encProgressEl) encProgressEl.style.width = `${progress}%`;
  if (encTimeEl) encTimeEl.textContent = `${progress}%`;
}

function updatePanelDownloadProgress(progress) {
  const container = document.getElementById('suno-advanced-ui');
  if (!container) return;
  
  const recordingUiEl = container.querySelector('#suno-recording-ui');
  const encodingUiEl = container.querySelector('#suno-encoding-ui');
  const downloadUiEl = container.querySelector('#suno-download-ui');
  const dlProgressEl = container.querySelector('#suno-dl-progress');
  const dlTimeEl = container.querySelector('#suno-dl-time');
  
  if (recordingUiEl) recordingUiEl.style.display = 'none';
  if (encodingUiEl) encodingUiEl.style.display = 'none';
  if (downloadUiEl) downloadUiEl.style.display = 'flex';
  
  if (dlProgressEl) dlProgressEl.style.width = `${progress}%`;
  if (dlTimeEl) dlTimeEl.textContent = `${progress}%`;
}

// ============ INITIALIZATION ============
let initDone = false;
async function init() {
  if (initDone) return; // SPA re-navigation reuses the same page instance
  initDone = true;
  log('Initializing Suno Advanced Downloader content script');
  
  // Ensure permissions
  await ensurePermissions();
  
  // Setup observers for dynamic content
  setupObservers();
  
  // Create floating UI
  createFloatingUI();
  
  // Start play state monitoring
  setInterval(() => {
    if (extensionCtxValid()) checkAndAutoRecord();
  }, 1000);
  
  // Notify background that content script is ready
  safeSend({ type: 'CONTENT_SCRIPT_READY', url: window.location.href });
  
  log('Content script initialized');
}

// Wait for DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Handle page navigation (SPA) - only reset state, never re-run init
let lastUrl = window.location.href;
new MutationObserver(() => {
  if (extensionContextDead) return;
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    log('URL changed, resetting state');
    resetRecordingState();
    isAutoRecording = false;
    lastPlayState = false;
  }
}).observe(document, { subtree: true, childList: true });

// Detect context death passively (e.g. after extension reload) and warn user
setInterval(() => {
  if (!extensionCtxValid()) updateDeadBanner();
}, 3000);