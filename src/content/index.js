// Content Script - Suno Advanced Downloader
// Smart song detection, recording state machine, playback tracking

import {
  MESSAGE_TYPES,
  PLAYBAR_SELECTORS,
  AUDIO_SELECTORS,
  EXCLUDED_TEXTS,
  EXCLUDED_ARTIST_TEXTS,
  RECORDING_CONFIG,
  formatTime,
  generateId,
  isSunoUrl
} from '../shared/constants.js';

// ============ STATE ============
let mediaRecorder = null;
let recordedChunks = [];
let currentQueueItemId = null;
let recordingStartTime = 0;
let progressInterval = null;
let currentAudioElement = null;
let panel = null;
let isRecording = false;

// ============ UTILITY FUNCTIONS ============
function log(...args) {
  console.log('[Suno Advanced]', ...args);
}

function findPlaybar() {
  for (const selector of PLAYBAR_SELECTORS) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function findAudioElement() {
  // 1. Audio within playbar (currently playing song)
  const playbar = findPlaybar();
  if (playbar) {
    const audioInPlaybar = playbar.querySelector('audio') || playbar.querySelector('video');
    if (audioInPlaybar && (audioInPlaybar.src || audioInPlaybar.currentSrc || audioInPlaybar.querySelector('source') || audioInPlaybar.duration)) {
      log('Found audio in playbar');
      return audioInPlaybar;
    }
  }

  // 2. Actively playing audio (not paused, currentTime > 0)
  const allMedia = document.querySelectorAll('audio, video');
  for (const el of allMedia) {
    if (!el.paused && el.currentTime > 0 && el.duration && !isNaN(el.duration) && isFinite(el.duration)) {
      log('Found actively playing audio');
      return el;
    }
  }

  // 3. Any audio/video with valid duration > 0
  for (const el of allMedia) {
    if (el.duration && !isNaN(el.duration) && isFinite(el.duration) && el.duration > 0) {
      log('Found audio with duration');
      return el;
    }
  }

  return null;
}

function isValidText(text, excludedList) {
  if (!text || text.length < 2) return false;
  const lower = text.toLowerCase().trim();
  return !excludedList.includes(lower);
}

// ============ METADATA EXTRACTION ============
function extractSongMetadata() {
  const metadata = {
    songName: null,
    artist: null,
    duration: null,
    coverUrl: null,
    pageUrl: window.location.href
  };

  const playbar = findPlaybar();
  const scopes = playbar ? [playbar] : [];

  if (playbar) {
    log('Found playbar:', playbar);
  } else {
    log('Playbar NOT found, using page-level fallbacks');
  }

  // --- 1. Song title from playbar ---
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
        if (isValidText(text, EXCLUDED_TEXTS)) {
          metadata.songName = text;
          log('Found song name:', text, 'via selector:', selector);
          break;
        }
      }
    }
  }

  // --- 2. Artist from playbar ---
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
        if (isValidText(text, EXCLUDED_ARTIST_TEXTS)) {
          metadata.artist = text;
          log('Found artist:', text, 'via selector:', selector);
          break;
        }
      }
    }
  }

  // --- 3. Open Graph / meta tag fallbacks (works on /explore too) ---
  if (!metadata.songName) {
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content ||
                    document.querySelector('meta[name="og:title"]')?.content;
    if (ogTitle && isValidText(ogTitle, EXCLUDED_TEXTS)) {
      metadata.songName = ogTitle.replace(/\s*\|\s*Suno\s*$/i, '').trim();
      log('Found song name from og:title:', metadata.songName);
    }
  }
  if (!metadata.songName) {
    const twitterTitle = document.querySelector('meta[name="twitter:title"]')?.content;
    if (twitterTitle && isValidText(twitterTitle, EXCLUDED_TEXTS)) {
      metadata.songName = twitterTitle.replace(/\s*\|\s*Suno\s*$/i, '').trim();
      log('Found song name from twitter:title:', metadata.songName);
    }
  }
  if (!metadata.songName) {
    const t = document.title || '';
    const m = t.match(/^(.+?)\s*[|·]\s*Suno/i);
    if (m && isValidText(m[1].trim(), EXCLUDED_TEXTS)) {
      metadata.songName = m[1].trim();
      log('Found song name from document.title:', metadata.songName);
    }
  }

  if (!metadata.artist) {
    const ogArtist = document.querySelector('meta[property="music:creator"]')?.content ||
                     document.querySelector('meta[property="og:artist"]')?.content;
    if (ogArtist && ogArtist.length > 1) {
      metadata.artist = ogArtist.trim();
      log('Found artist from meta:', metadata.artist);
    }
  }

  if (!metadata.coverUrl) {
    const ogImage = document.querySelector('meta[property="og:image"]')?.content ||
                    document.querySelector('meta[name="twitter:image"]')?.content;
    if (ogImage) {
      metadata.coverUrl = ogImage;
      log('Found cover from og:image:', metadata.coverUrl);
    }
  }

  if (!metadata.duration) {
    const ogDuration = document.querySelector('meta[property="music:duration"]')?.content;
    if (ogDuration) {
      const secs = parseInt(ogDuration, 10);
      if (!isNaN(secs) && secs > 0) {
        metadata.duration = secs * 1000;
        log('Found duration from music:duration:', metadata.duration);
      }
    }
  }

  // --- 4. Duration from audio element ---
  if (!metadata.duration) {
    const audioEl = findAudioElement();
    if (audioEl && audioEl.duration && !isNaN(audioEl.duration) && isFinite(audioEl.duration) && audioEl.duration > 0) {
      metadata.duration = Math.floor(audioEl.duration * 1000);
      log('Found duration from audio element:', metadata.duration);
    }
  }

  // --- 5. Duration from UI (player bar or page-level) ---
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
      const el = playbar?.querySelector(selector) || document.querySelector(selector);
      if (el && el.textContent?.trim()) {
        const text = el.textContent.trim();
        const match = text.match(/(\d+):(\d+)/);
        if (match) {
          metadata.duration = (parseInt(match[1]) * 60 + parseInt(match[2])) * 1000;
          log('Found duration from UI:', metadata.duration, 'via selector:', selector);
          break;
        }
      }
    }
  }

  // --- 6. Cover image from player bar or page ---
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
      const el = playbar?.querySelector(selector) || document.querySelector(selector);
      if (el && el.src) {
        metadata.coverUrl = el.src;
        log('Found cover:', metadata.coverUrl, 'via selector:', selector);
        break;
      }
    }
  }

  // --- 7. Final fallbacks ---
  if (!metadata.songName) {
    const urlMatch = window.location.href.match(/\/song\/([^/?]+)/);
    if (urlMatch) {
      metadata.songName = decodeURIComponent(urlMatch[1]).replace(/-/g, ' ');
      log('Found song name from URL:', metadata.songName);
    } else {
      metadata.songName = 'Suno Song';
    }
  }

  if (!metadata.artist) {
    metadata.artist = 'Unknown Artist';
  }

  log('Final metadata:', metadata);
  return metadata;
}

function getPlayState() {
  const audioEl = findAudioElement();
  return {
    isPlaying: audioEl ? !audioEl.paused : false,
    currentTime: audioEl ? audioEl.currentTime * 1000 : 0,
    duration: audioEl ? audioEl.duration * 1000 : 0,
    hasAudio: !!audioEl
  };
}

// ============ RECORDING STATE MACHINE ============
async function startRecording(queueItemId, metadata) {
  log('Starting recording for:', queueItemId);
  
  try {
    // Get the currently playing audio
    const audioEl = findAudioElement();
    if (!audioEl) {
      throw new Error('No audio element found. Please play a song on Suno first.');
    }
    
    currentAudioElement = audioEl;
    currentQueueItemId = queueItemId;
    isRecording = true;
    recordingStartTime = Date.now();
    recordedChunks = [];

    // Create MediaRecorder from audio element
    const stream = audioEl.captureStream ? audioEl.captureStream() : audioEl.srcObject;
    if (!stream) {
      throw new Error('Could not capture audio stream. Browser may not support captureStream.');
    }

    // Find supported MIME type
    let mimeType = RECORDING_CONFIG.MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      throw new Error('No supported audio format found');
    }
    log('Using mime type:', mimeType);

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      log('MediaRecorder stopped');
      const audioBlob = new Blob(recordedChunks, { type: mimeType });
      log('Recording complete, blob size:', audioBlob.size);
      
      // Send completion to background
      chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.RECORDING_COMPLETE,
        queueItemId: currentQueueItemId,
        audioBlob,
        metadata
      });
      
      // Reset state AFTER sending completion
      resetRecordingState();
    };

    mediaRecorder.onerror = (event) => {
      log('MediaRecorder error:', event.error);
      chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.RECORDING_ERROR,
        queueItemId: currentQueueItemId,
        error: event.error?.message || 'Recording failed'
      });
      resetRecordingState();
    };

    mediaRecorder.start(RECORDING_CONFIG.CHUNK_INTERVAL_MS);
    log('MediaRecorder started');

    // Start progress tracking
    startProgressTracking(metadata.duration);
    
    // Notify background
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.RECORDING_STARTED,
      queueItemId
    });

    // Notify UI
    notifyContentScript({
      type: MESSAGE_TYPES.RECORDING_STARTED,
      queueItemId
    });

    // Auto-stop when song ends
    monitorSongEnd(metadata.duration);

    return true;
  } catch (error) {
    log('Recording failed:', error);
    resetRecordingState();
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.RECORDING_ERROR,
      queueItemId,
      error: error.message
    });
    return false;
  }
}

function stopRecording() {
  log('Stopping recording');
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop(); // onstop → onRecordingStop → resetRecordingState
  } else {
    resetRecordingState();
  }
}

function resetRecordingState() {
  log('Resetting recording state');
  
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
  
  mediaRecorder = null;
  recordedChunks = [];
  currentQueueItemId = null;
  recordingStartTime = 0;
  currentAudioElement = null;
  isRecording = false;
  
  notifyContentScript({ type: MESSAGE_TYPES.RECORDING_COMPLETE });
}

function startProgressTracking(totalDuration) {
  progressInterval = setInterval(() => {
    if (!currentQueueItemId) {
      clearInterval(progressInterval);
      progressInterval = null;
      return;
    }
    
    const elapsed = Date.now() - recordingStartTime;
    let progress;
    
    if (totalDuration && totalDuration > 0) {
      progress = Math.min(100, Math.round((elapsed / totalDuration) * 100));
    } else {
      // No duration known - just show elapsed time
      progress = Math.min(95, Math.round((elapsed / RECORDING_CONFIG.DEFAULT_DURATION_MS) * 100));
    }
    
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.RECORDING_PROGRESS,
      queueItemId: currentQueueItemId,
      progress
    });
    
    notifyContentScript({
      type: MESSAGE_TYPES.RECORDING_PROGRESS,
      queueItemId: currentQueueItemId,
      progress,
      elapsed,
      totalDuration
    });
  }, RECORDING_CONFIG.PROGRESS_INTERVAL_MS);
}

function monitorSongEnd(totalDuration) {
  const checkInterval = setInterval(() => {
    if (!currentQueueItemId || !currentAudioElement) {
      clearInterval(checkInterval);
      return;
    }
    
    const audio = currentAudioElement;
    const elapsed = Date.now() - recordingStartTime;
    
    // Stop if audio ended
    if (audio.ended) {
      log('Audio ended naturally, stopping recording');
      clearInterval(checkInterval);
      stopRecording();
      return;
    }
    
    // Stop if duration exceeded with buffer
    if (totalDuration && totalDuration > 0 && elapsed > totalDuration + RECORDING_CONFIG.MAX_DURATION_BUFFER_MS) {
      log('Duration exceeded buffer, stopping recording');
      clearInterval(checkInterval);
      stopRecording();
      return;
    }
    
    // Safety: stop if audio paused for too long (user might have navigated away)
    if (audio.paused && elapsed > 5000) {
      log('Audio paused, stopping recording');
      clearInterval(checkInterval);
      stopRecording();
      return;
    }
  }, 1000);
}

function notifyContentScript(message) {
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.OPEN_POPUP, // Just to keep channel alive
    ...message
  }).catch(() => {});
}

// ============ MESSAGE HANDLER ============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case MESSAGE_TYPES.GET_METADATA:
          const metadata = extractSongMetadata();
          sendResponse({ metadata });
          break;
          
        case MESSAGE_TYPES.GET_PLAY_STATE:
          sendResponse({ playState: getPlayState() });
          break;
          
        case MESSAGE_TYPES.GET_PLAYBACK_INFO:
          const audioEl = findAudioElement();
          sendResponse({ 
            playbackInfo: audioEl ? {
              currentTime: audioEl.currentTime,
              duration: audioEl.duration,
              paused: audioEl.paused,
              src: audioEl.currentSrc || audioEl.src
            } : null
          });
          break;
          
        case MESSAGE_TYPES.START_RECORDING:
          log('Received START_RECORDING:', message.queueItemId);
          let startMetadata = message.metadata;
          if (!startMetadata) {
            startMetadata = extractSongMetadata();
            // Override with message fields from queue (more reliable)
            if (message.songName) startMetadata.songName = message.songName;
            if (message.artist) startMetadata.artist = message.artist;
            if (message.duration) startMetadata.duration = message.duration;
            if (message.pageUrl) startMetadata.pageUrl = message.pageUrl;
          }
          const success = await startRecording(message.queueItemId, startMetadata);
          sendResponse({ success });
          break;
          
        case MESSAGE_TYPES.STOP_RECORDING:
          stopRecording();
          sendResponse({ success: true });
          break;
          
        case MESSAGE_TYPES.PING:
          sendResponse({ pong: true, ready: true });
          break;
          
        default:
          sendResponse({ error: 'Unknown message type' });
      }
    } catch (error) {
      log('Message handler error:', error);
      sendResponse({ error: error.message });
    }
  })();
  
  return true;
});

// ============ FLOATING PANEL ============
function createPanel() {
  if (panel) return panel;
  
  panel = document.createElement('div');
  panel.id = 'suno-advanced-panel';
  panel.style.cssText = `
    position: fixed;
    bottom: 90px;
    right: 20px;
    width: 320px;
    background: #1a1a2e;
    border: 1px solid #333;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #fff;
    overflow: hidden;
  `;
  
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #333;background:linear-gradient(90deg,#6366f1,#8b5cf6);">
      <div style="display:flex;align-items:center;gap:8px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
        <span style="font-weight:600;font-size:14px;">Suno Advanced</span>
      </div>
      <button id="suno-panel-close" style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:4px;opacity:0.7;transition:opacity 0.2s;">×</button>
    </div>
    <div id="suno-panel-content" style="padding:16px;">
      <div id="suno-panel-idle" style="display:none;text-align:center;color:#888;">
        <p style="margin:0 0 12px;">Play a song on Suno to see details</p>
        <button id="suno-btn-add-current" style="background:#6366f1;color:#fff;border:none;padding:10px 16px;border-radius:8px;cursor:pointer;font-weight:500;">+ Add Current Song</button>
      </div>
      <div id="suno-panel-playing" style="display:none;">
        <div style="display:flex;gap:12px;margin-bottom:12px;">
          <img id="suno-cover" src="" alt="" style="width:56px;height:56px;border-radius:8px;object-fit:cover;background:#333;">
          <div style="flex:1;min-width:0;">
            <div id="suno-title" style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
            <div id="suno-artist" style="font-size:12px;color:#aaa;margin-top:2px;"></div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <span id="suno-current-time" style="font-size:12px;color:#888;font-variant-numeric:tabular-nums;">0:00</span>
          <div style="flex:1;height:4px;background:#333;border-radius:2px;overflow:hidden;">
            <div id="suno-progress-bar" style="width:0%;height:100%;background:linear-gradient(90deg,#6366f1,#8b5cf6);border-radius:2px;transition:width 0.5s;"></div>
          </div>
          <span id="suno-duration" style="font-size:12px;color:#888;font-variant-numeric:tabular-nums;">0:00</span>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="suno-btn-record" style="flex:1;background:#dc2626;color:#fff;border:none;padding:10px;border-radius:8px;cursor:pointer;font-weight:600;display:flex;align-items:center;justify-content:center;gap:6px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#dc2626"><circle cx="12" cy="12" r="8"/></svg>
            <span>Start Recording</span>
          </button>
          <button id="suno-btn-add-queue" style="flex:1;background:#374151;color:#fff;border:none;padding:10px;border-radius:8px;cursor:pointer;font-weight:500;">Add to Queue</button>
        </div>
      </div>
      <div id="suno-panel-recording" style="display:none;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:10px;background:rgba(220,38,38,0.15);border-radius:8px;border:1px solid #dc2626;">
          <div style="width:10px;height:10px;background:#dc2626;border-radius:50%;animation:pulse 1s infinite;"></div>
          <div style="flex:1;">
            <div style="font-weight:600;color:#dc2626;">RECORDING</div>
            <div style="font-size:12px;color:#aaa;">Capturing audio...</div>
          </div>
          <div id="suno-rec-time" style="font-size:14px;font-variant-numeric:tabular-nums;color:#dc2626;font-weight:600;">0:00</div>
        </div>
        <div style="height:6px;background:#333;border-radius:3px;overflow:hidden;margin-bottom:8px;">
          <div id="suno-rec-progress" style="width:0%;height:100%;background:linear-gradient(90deg,#dc2626,#ef4444);border-radius:3px;transition:width 0.5s;"></div>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="suno-btn-stop-rec" style="flex:1;background:#dc2626;color:#fff;border:none;padding:10px;border-radius:8px;cursor:pointer;font-weight:600;">Stop Recording</button>
        </div>
      </div>
      <div id="suno-panel-progress" style="display:none;">
        <div id="suno-progress-label" style="font-weight:500;margin-bottom:8px;"></div>
        <div style="height:8px;background:#333;border-radius:4px;overflow:hidden;margin-bottom:4px;">
          <div id="suno-progress-fill" style="width:0%;height:100%;border-radius:4px;transition:width 0.3s;"></div>
        </div>
        <div id="suno-progress-text" style="font-size:12px;color:#888;text-align:right;"></div>
      </div>
    </div>
  `;
  
  // Add pulse animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  `;
  document.head.appendChild(style);
  
  document.body.appendChild(panel);
  
  // Event listeners
  panel.querySelector('#suno-panel-close').addEventListener('click', () => {
    panel.style.display = 'none';
  });
  
  panel.querySelector('#suno-btn-add-current').addEventListener('click', () => {
    addCurrentSongToQueue();
  });
  
  panel.querySelector('#suno-btn-record').addEventListener('click', () => {
    addCurrentSongToQueue(true);
  });
  
  panel.querySelector('#suno-btn-add-queue').addEventListener('click', () => {
    addCurrentSongToQueue(false);
  });
  
  panel.querySelector('#suno-btn-stop-rec').addEventListener('click', () => {
    stopRecording();
  });
  
  return panel;
}

function updatePanelUI() {
  if (!panel) createPanel();
  
  const metadata = extractSongMetadata();
  const playState = getPlayState();
  
  const idle = panel.querySelector('#suno-panel-idle');
  const playing = panel.querySelector('#suno-panel-playing');
  const recording = panel.querySelector('#suno-panel-recording');
  const progress = panel.querySelector('#suno-panel-progress');
  
  // Determine state
  const isPlaying = playState.isPlaying;
  const hasMetadata = metadata.songName && metadata.songName !== 'Suno Song';
  
  idle.style.display = 'none';
  playing.style.display = 'none';
  recording.style.display = 'none';
  progress.style.display = 'none';
  
  if (isRecording) {
    recording.style.display = 'block';
    updateRecordingUI();
  } else if (isPlaying && hasMetadata) {
    playing.style.display = 'block';
    updatePlayingUI(metadata, playState);
  } else if (hasMetadata) {
    playing.style.display = 'block';
    updatePlayingUI(metadata, playState);
  } else {
    idle.style.display = 'block';
  }
}

function updatePlayingUI(metadata, playState) {
  const cover = panel.querySelector('#suno-cover');
  const title = panel.querySelector('#suno-title');
  const artist = panel.querySelector('#suno-artist');
  const currentTime = panel.querySelector('#suno-current-time');
  const duration = panel.querySelector('#suno-duration');
  const progressBar = panel.querySelector('#suno-progress-bar');
  const recordBtn = panel.querySelector('#suno-btn-record');
  
  if (metadata.coverUrl) {
    cover.src = metadata.coverUrl;
    cover.style.display = 'block';
  } else {
    cover.style.display = 'none';
  }
  
  title.textContent = metadata.songName || 'Unknown Title';
  artist.textContent = metadata.artist || 'Unknown Artist';
  
  const current = playState.currentTime;
  const total = playState.duration;
  
  currentTime.textContent = formatTime(current);
  duration.textContent = formatTime(total);
  
  if (total > 0) {
    progressBar.style.width = `${Math.min(100, (current / total) * 100)}%`;
  }
  
  recordBtn.innerHTML = isRecording 
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="#dc2626"><circle cx="12" cy="12" r="8"/></svg><span>Recording...</span>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="#dc2626"><circle cx="12" cy="12" r="8"/></svg><span>Start Recording</span>';
}

function updateRecordingUI() {
  const recTime = panel.querySelector('#suno-rec-time');
  const recProgress = panel.querySelector('#suno-rec-progress');
  
  const elapsed = Date.now() - recordingStartTime;
  recTime.textContent = formatTime(elapsed);
  
  // We don't know exact duration during recording, just show elapsed
}

function showProgressUI(label, progress, color = '#6366f1') {
  if (!panel) createPanel();
  
  const idle = panel.querySelector('#suno-panel-idle');
  const playing = panel.querySelector('#suno-panel-playing');
  const recording = panel.querySelector('#suno-panel-recording');
  const progressDiv = panel.querySelector('#suno-panel-progress');
  
  idle.style.display = 'none';
  playing.style.display = 'none';
  recording.style.display = 'none';
  progressDiv.style.display = 'block';
  
  const labelEl = panel.querySelector('#suno-progress-label');
  const fill = panel.querySelector('#suno-progress-fill');
  const text = panel.querySelector('#suno-progress-text');
  
  labelEl.textContent = label;
  fill.style.width = `${progress}%`;
  fill.style.background = color;
  text.textContent = `${progress}%`;
}

async function addCurrentSongToQueue(startRecordingNow = false) {
  const metadata = extractSongMetadata();
  const playState = getPlayState();
  
  if (metadata.songName === 'Suno Song') {
    alert('Could not detect song. Please play a song on Suno first.');
    return;
  }
  
  const queueItem = {
    songName: metadata.songName,
    artist: metadata.artist,
    duration: metadata.duration || playState.duration,
    pageUrl: metadata.pageUrl,
    coverUrl: metadata.coverUrl
  };
  
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.ADD_TO_QUEUE,
    item: queueItem
  }, (response) => {
    if (response?.item) {
      if (startRecordingNow) {
        // The background will handle starting recording
      }
      updatePanelUI();
    }
  });
}

// ============ CONTENT SCRIPT READY SIGNAL ============
function announceReady() {
  chrome.runtime.sendMessage({ type: MESSAGE_TYPES.CONTENT_SCRIPT_READY }).catch(() => {});
}

// ============ INITIALIZATION ============
function init() {
  log('Content script loaded');
  
  // Create panel
  createPanel();
  
  // Announce ready
  announceReady();
  
  // Update UI periodically
  setInterval(updatePanelUI, 2000);
  
  // Listen for progress messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === MESSAGE_TYPES.ENCODING_PROGRESS) {
      showProgressUI(`Converting to MP3...`, message.progress, '#f59e0b');
    } else if (message.type === MESSAGE_TYPES.DOWNLOAD_PROGRESS) {
      showProgressUI(`Downloading...`, message.progress, '#22c55e');
    } else if (message.type === MESSAGE_TYPES.DOWNLOAD_COMPLETE) {
      showProgressUI(`Download Complete!`, 100, '#22c55e');
      setTimeout(() => updatePanelUI(), 3000);
    } else if (message.type === MESSAGE_TYPES.RECORDING_STARTED) {
      isRecording = true;
      updatePanelUI();
    } else if (message.type === MESSAGE_TYPES.RECORDING_COMPLETE) {
      isRecording = false;
      // UI will be updated by progress messages
    }
  });
  
  // Initial UI update
  updatePanelUI();
  
  log('Initialization complete');
}

// Run when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Export for debugging
window.__SUNO_ADVANCED__ = {
  extractSongMetadata,
  getPlayState,
  findAudioElement,
  findPlaybar,
  startRecording,
  stopRecording,
  panel: () => panel
};