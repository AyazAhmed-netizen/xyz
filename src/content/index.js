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
  isSunoUrl,
  bufferToBase64
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
// sendMessage rejects when nothing is listening (e.g. side panel closed).
function safeSend(message, callback) {
  try {
    const p = chrome.runtime.sendMessage(message, callback);
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* extension reloaded / context invalidated */ }
}

function log(...args) {
  console.log('[Suno Advanced]', ...args);
}

function findPlaybar() {
  for (const selector of PLAYBAR_SELECTORS) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch (e) {
      log('Invalid playbar selector:', selector, e.message);
    }
  }
  return null;
}

// Suno keeps a placeholder <audio> (forbidden.webm / silence) until a song is loaded.
function isPlaceholderAudio(el) {
  const src = el.currentSrc || el.src || '';
  return el.id === 'silent-audio' || /forbidden\.webm|sil-100|silent/i.test(src);
}

function findAudioElement() {
  // 1. Suno's real player element (skip the silent-audio decoy)
  for (const selector of AUDIO_SELECTORS) {
    try {
      const el = document.querySelector(selector);
      if (el && !isPlaceholderAudio(el) && (el.currentSrc || el.src || el.querySelector('source'))) {
        log('Found active audio via', selector);
        return el;
      }
    } catch (e) { /* invalid selector - skip */ }
  }

  // 2. Actively playing audio (not paused, currentTime > 0)
  const allMedia = document.querySelectorAll('audio, video');
  for (const el of allMedia) {
    if (isPlaceholderAudio(el)) continue;
    if (!el.paused && el.currentTime > 0 && el.duration && !isNaN(el.duration) && isFinite(el.duration)) {
      log('Found actively playing audio');
      return el;
    }
  }

  // 3. Any non-decoy audio/video with a valid duration > 0
  for (const el of allMedia) {
    if (isPlaceholderAudio(el)) continue;
    if (el.duration && !isNaN(el.duration) && isFinite(el.duration) && el.duration > 0) {
      log('Found audio with duration');
      return el;
    }
  }

  return null;
}

// Fallback: scan performance entries for the audio file Suno fetched. This
// covers players that feed audio via MediaSource/blob instead of audio.src.
function findRecentAudioUrl() {
  try {
    const entries = performance.getEntriesByType('resource')
      .filter(e => /cdn(-o)?\.suno\.com|\.suno\.com\/.*\.(mp3|m4a|ogg|wav)/i.test(e.name))
      .filter(e => !/sil-100|silent/i.test(e.name))
      .sort((a, b) => b.responseEnd - a.responseEnd);
    if (entries.length) {
      log('Found recent audio URL:', entries[0].name);
      return entries[0].name;
    }
  } catch (e) { /* ignore */ }
  return '';
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
  const audioEl = findAudioElement();

  // Suno's playbar labels: "Playbar: Title for <song>", "Playbar: Artist for <song>"
  if (playbar) {
    const t = playbar.querySelector('[aria-label^="Playbar: Title for "]');
    const tText = t && (t.textContent.trim() || t.getAttribute('aria-label').replace(/^Playbar: Title for /, '').trim());
    if (tText) metadata.songName = tText;
    const a = playbar.querySelector('[aria-label^="Playbar: Artist for "]');
    if (a && a.textContent.trim()) metadata.artist = a.textContent.trim();
    const link = playbar.querySelector('a[href^="/song/"]');
    if (link) metadata.pageUrl = new URL(link.getAttribute('href'), location.origin).href;
    const img = playbar.querySelector('img[src^="http"]');
    if (img) metadata.coverUrl = img.src;
  }

  // Build search scopes. On explore page there is no playbar; the bottom player
  // audio element lives outside any song card. We must search within the audio
  // element's own ancestor chain first so we pick up the mini-player's song
  // title ("those eyes") instead of a random playlist title elsewhere on page.
  const scopes = [];
  if (playbar) scopes.push(playbar);

  if (audioEl) {
    // Collect the audio element's ancestor containers (player bar, footer, etc.)
    let ancestor = audioEl.parentElement;
    while (ancestor && ancestor !== document.body) {
      scopes.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    // Also try to find a song card marked as currently playing/active
    const activeCard = document.querySelector(
      '[class*="song"][class*="active" i], [class*="track"][class*="active" i], ' +
      '[class*="song"][class*="playing" i], [class*="track"][class*="playing" i], ' +
      '[data-testid*="song"][class*="active" i], [data-testid*="song"][class*="playing" i]'
    );
    if (activeCard && !scopes.includes(activeCard)) scopes.push(activeCard);
    log('Found audio element, searching', scopes.length, 'ancestor scopes + active card');
  } else {
    log('No playbar or audio element found');
  }
  // document.body is LAST resort — never let a random page title override the player.
  scopes.push(document.body);

  // --- 1. Song title from playbar/audio-context or page ---
  if (!metadata.songName) {
    for (const scope of scopes) {
      if (metadata.songName) break;
      const titleSelectors = [
        '[data-testid="song-title"]',
        '[data-testid="track-title"]',
        '[data-testid="playback-title"]',
        '[data-testid*="current-song"]',
        '[data-testid*="now-playing"]',
        '[class*="SongTitle"]',
        '[class*="TrackTitle"]',
        '[class*="playback-title"]',
        '[class*="song-title"]',
        '[class*="track-name"]',
        '[class*="current-song"]',
        '[class*="now-playing"]',
        '[class*="mini-player"] [class*="title"]',
        'footer [class*="title"]',
        '[class*="player-bar"] [class*="title"]',
        '[class*="bottom-bar"] [class*="title"]'
      ];
      // Only use generic heading tags on non-body scopes (playbar / audio ancestors).
      // Using h1-h4 on document.body would pick up playlist titles like "Best Of".
      const isBodyScope = scope === document.body;
      if (!isBodyScope) {
        titleSelectors.push('h1', 'h2', 'h3', 'h4');
      }
      titleSelectors.push('span[class*="title"]', 'div[class*="title"]');

      for (const selector of titleSelectors) {
        const el = scope.querySelector(selector);
        const text = el?.textContent?.trim();
        if (isValidText(text, EXCLUDED_TEXTS)) {
          metadata.songName = text;
          log('Found song name:', text, 'via selector:', selector);
          break;
        }
      }

      // If still no title on an audio-ancestor scope, do a broader text scan
      // (any element with plausible song-title text near the player).
      if (!metadata.songName && scope !== document.body && audioEl) {
        const broader = findPlausibleSongTitle(scope, audioEl);
        if (broader) {
          metadata.songName = broader;
          log('Found song name (broader scan):', broader);
          break;
        }
      }
    }
  }

  // --- 2. Artist from playbar/audio-context or page ---
  if (!metadata.artist) {
    for (const scope of scopes) {
      if (metadata.artist) break;
      const artistSelectors = [
        '[data-testid="song-artist"]',
        '[data-testid="track-artist"]',
        '[data-testid="playback-artist"]',
        '[data-testid*="current-artist"]',
        '[data-testid*="now-playing-artist"]',
        '[class*="Artist"] a',
        '[class*="artist"] a',
        '[class*="current-artist"]',
        '[class*="now-playing-artist"]',
        'a[href^="/@"]',
        'footer a[href^="/@"]',
        '[class*="artist"]',
        '[class*="creator"]',
        '[class*="author"]',
        '[class*="username"]'
      ];
      const isBodyScope = scope === document.body;
      if (!isBodyScope) {
        artistSelectors.push('span[class*="artist"]', 'div[class*="artist"]');
      }
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

  // Broader scan: find any element near the audio element whose text looks like
// a song title (short, not excluded, not UI boilerplate).
function findPlausibleSongTitle(rootScope, audioEl) {
  const candidates = [];
  const walker = document.createTreeWalker(
    rootScope,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        const tag = node.tagName?.toLowerCase();
        // Only consider text-bearing elements
        if (!['span', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'a'].includes(tag)) {
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (!text || text.length < 2 || text.length > 120) continue;
    const lower = text.toLowerCase();
    // Skip excluded / UI texts
    if (EXCLUDED_TEXTS.includes(lower)) continue;
    if (lower.includes('explore') || lower.includes('library') || lower.includes('create') ||
        lower.includes('playlist') || lower.includes('for you') || lower.includes('best of') ||
        lower.includes('suno') || lower.includes('home') || lower.includes('search')) continue;
    // Prefer elements closer to the audio element
    const distance = node.contains(audioEl) || audioEl.contains(node) ? 0 : 1;
    candidates.push({ text, distance });
  }
  if (candidates.length === 0) return null;
  // Sort: closest to audio first, then shortest text (song titles are short)
  candidates.sort((a, b) => a.distance - b.distance || a.text.length - b.text.length);
  return candidates[0].text;
}

  // --- 3. Open Graph / document title fallbacks ---
  // Try these on any page where audio is playing. isValidText() filters out
  // generic page titles like "Explore | Suno" so they won't false-positive.
  const hasPlayingAudio = !!audioEl && !audioEl.paused && audioEl.currentTime > 0;

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

// ============ AUTO PLAYBACK ============
function sleepMs(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(fn, timeoutMs = 10000, stepMs = 200) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleepMs(stepMs);
  }
}

function isUsable(btn) {
  return btn && !btn.disabled && !btn.hasAttribute('data-trigger-disabled') && btn.offsetParent !== null;
}

// Click the song's own play button (song page), else the playbar's.
function clickPlayButton() {
  const pageButtons = [...document.querySelectorAll('button[aria-label]')].filter((b) => {
    const l = b.getAttribute('aria-label') || '';
    return /^play( song| this song| clip| track)?$/i.test(l.trim()) && isUsable(b);
  });
  const playbarBtn = document.querySelector('button[aria-label="Playbar: Play button"]');
  const target = pageButtons[0] || (isUsable(playbarBtn) ? playbarBtn : null);
  if (target) { target.click(); return true; }
  return false;
}

// Make sure a real song is loaded and playing; start it ourselves if not.
async function ensureAudioPlaying() {
  let audio = findAudioElement();

  if (!audio) {
    clickPlayButton();
    audio = await waitFor(() => findAudioElement(), 12000);
  }
  if (!audio) {
    throw new Error('Could not start the song automatically. Open the song page (or press play once on Suno) and try again.');
  }

  if (audio.paused) {
    try { await audio.play(); } catch (e) { clickPlayButton(); }
    await waitFor(() => !audio.paused, 4000);
  }
  // Wait for real media metadata so we know the true duration.
  await waitFor(() => Number.isFinite(audio.duration) && audio.duration > 0, 6000);
  return audio;
}

// ============ RECORDING STATE MACHINE ============
async function startRecording(queueItemId, metadata) {
  log('Starting recording for:', queueItemId);

  // Never reset/steal state from a recording that is already running.
  if (isRecording) {
    safeSend({
      type: MESSAGE_TYPES.RECORDING_ERROR,
      queueItemId,
      error: 'A recording is already in progress.'
    });
    return false;
  }
  
  try {
    // Get the currently playing audio
    const audioEl = await ensureAudioPlaying();
    
    currentAudioElement = audioEl;
    currentQueueItemId = queueItemId;
    isRecording = true;
    recordedChunks = [];

    // Recording captures live playback, so start from the top of the track;
    // otherwise clicking Download mid-song would save only the tail.
    if (audioEl.currentTime > 1) {
      audioEl.currentTime = 0;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        audioEl.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }

    if (audioEl.paused) {
      try { await audioEl.play(); } catch (e) {
        throw new Error('Audio is paused and could not be resumed automatically.');
      }
    }

    // Prefer the real media duration over scraped UI text.
    const realDuration = Number.isFinite(audioEl.duration) && audioEl.duration > 0
      ? Math.floor(audioEl.duration * 1000) : 0;
    const totalDuration = realDuration || metadata.duration || 0;
    recordingStartTime = Date.now();

    // Create MediaRecorder from audio element
    const stream = audioEl.captureStream ? audioEl.captureStream() : audioEl.srcObject;
    if (!stream) {
      throw new Error('Could not capture audio stream. Browser may not support captureStream.');
    }

    // Verify the stream has audio tracks
    const audioTracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
    if (audioTracks.length === 0) {
      throw new Error('No audio tracks available to record. Make sure the song is playing and not muted.');
    }

    // Find supported MIME type
    const mimeType = RECORDING_CONFIG.MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      throw new Error('No supported audio format found');
    }
    log('Using mime type:', mimeType);

    const recordingId = queueItemId;
    const recorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    recorder.onstop = async () => {
      log('MediaRecorder stopped');
      const audioBlob = new Blob(recordedChunks, { type: mimeType });
      log('Recording complete, blob size:', audioBlob.size);

      // Binary can't cross extension messaging (JSON) - send base64.
      const b64 = bufferToBase64(await audioBlob.arrayBuffer());
      safeSend({
        type: MESSAGE_TYPES.RECORDING_COMPLETE,
        queueItemId: recordingId,
        b64,
        mimeType
      });

      // Song is captured - stop Suno's player so it doesn't roll into the next track.
      try { audioEl.pause(); } catch (e) { /* ignore */ }

      // Reset state AFTER sending completion
      resetRecordingState();
    };

    recorder.onerror = (event) => {
      const errMsg = event.error?.message || String(event.error || 'Recording failed');
      log('MediaRecorder error:', errMsg);
      safeSend({
        type: MESSAGE_TYPES.RECORDING_ERROR,
        queueItemId: recordingId,
        error: errMsg
      });
      resetRecordingState();
    };

    recorder.start(RECORDING_CONFIG.CHUNK_INTERVAL_MS);
    log('MediaRecorder started');

    startProgressTracking(totalDuration);
    // Metadata is most reliable once the song is actually loaded in the playbar.
    const live = extractSongMetadata();
    const liveMeta = {};
    if (live.songName && live.songName !== 'Suno Song') liveMeta.songName = live.songName;
    if (live.artist && live.artist !== 'Unknown Artist') liveMeta.artist = live.artist;
    if (live.coverUrl) liveMeta.coverUrl = live.coverUrl;
    if (live.pageUrl) liveMeta.pageUrl = live.pageUrl;
    if (totalDuration) liveMeta.duration = totalDuration;
    safeSend({ type: MESSAGE_TYPES.RECORDING_STARTED, queueItemId, metadata: liveMeta });

    // Auto-stop when song ends
    monitorSongEnd(totalDuration);

    return true;
  } catch (error) {
    const errMsg = error?.message || String(error);
    log('Recording failed:', errMsg);
    resetRecordingState();
    safeSend({
      type: MESSAGE_TYPES.RECORDING_ERROR,
      queueItemId,
      error: errMsg
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
    
    safeSend({
      type: MESSAGE_TYPES.RECORDING_PROGRESS,
      queueItemId: currentQueueItemId,
      progress,
      elapsed,
      totalDuration,
      label: 'Recording…'
    });
  }, RECORDING_CONFIG.PROGRESS_INTERVAL_MS);
}

function monitorSongEnd(totalDuration) {
  const startSrc = currentAudioElement ? (currentAudioElement.currentSrc || currentAudioElement.src) : '';
  const checkInterval = setInterval(() => {
    if (!currentQueueItemId || !currentAudioElement) {
      clearInterval(checkInterval);
      return;
    }
    
    const audio = currentAudioElement;
    const elapsed = Date.now() - recordingStartTime;
    
    // Suno autoplays the next track on the same element: stop if the source changed
    const nowSrc = audio.currentSrc || audio.src;
    if (startSrc && nowSrc && nowSrc !== startSrc) {
      log('Track changed, stopping recording');
      clearInterval(checkInterval);
      stopRecording();
      return;
    }

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

        case MESSAGE_TYPES.GET_AUDIO_URL: {
          const el = findAudioElement();
          let src = el ? (el.currentSrc || el.src || '') : '';
          // Suno often sets the source via a blob: or MediaSource. If there is
          // no direct file URL, look for a recent cdn.suno.com audio request.
          if (!src || src.startsWith('blob:')) {
            src = findRecentAudioUrl();
          }
          sendResponse({ audioUrl: src, metadata: extractSongMetadata() });
          break;
        }
          
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

// ============ QUICK DOWNLOAD BUTTON (near player) ============
// A single compact icon that sits above the playbar. One click fetches the
// currently playing Suno audio and downloads it - no popup, no panel needed.
let quickBtn = null;
let quickBusy = false;

function createQuickDownloadButton() {
  if (quickBtn) return quickBtn;

  quickBtn = document.createElement('button');
  quickBtn.id = 'suno-quick-download';
  quickBtn.type = 'button';
  quickBtn.title = 'Download this song (Suno Advanced)';
  quickBtn.setAttribute('aria-label', 'Download this song');
  quickBtn.style.cssText = `
    position: fixed;
    right: 24px;
    bottom: 104px;
    width: 46px;
    height: 46px;
    border-radius: 50%;
    border: 1px solid #3a3b3f;
    background: #18191b;
    color: #e8b04b;
    cursor: pointer;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 12px rgba(0,0,0,0.5);
    transition: transform 0.15s, border-color 0.15s, background 0.15s;
  `;
  quickBtn.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3v12"></path>
      <path d="m7 10 5 5 5-5"></path>
      <path d="M5 21h14"></path>
    </svg>
  `;
  quickBtn.addEventListener('mouseenter', () => {
    quickBtn.style.transform = 'scale(1.08)';
    quickBtn.style.borderColor = '#e8b04b';
  });
  quickBtn.addEventListener('mouseleave', () => {
    quickBtn.style.transform = 'scale(1)';
    quickBtn.style.borderColor = '#3a3b3f';
  });
  quickBtn.addEventListener('click', () => quickDownload());

  (document.body || document.documentElement).appendChild(quickBtn);
  return quickBtn;
}

function setQuickState(state) {
  if (!quickBtn) return;
  const svg = quickBtn.querySelector('svg');
  if (state === 'busy') {
    quickBusy = true;
    quickBtn.style.color = '#e05252';
    quickBtn.style.opacity = '0.85';
    quickBtn.title = 'Downloading...';
    if (svg) svg.style.animation = 'suno-spin 1s linear infinite';
  } else if (state === 'done') {
    quickBusy = false;
    quickBtn.style.color = '#6fbf8f';
    quickBtn.style.opacity = '1';
    quickBtn.title = 'Download complete';
    if (svg) svg.style.animation = 'none';
    setTimeout(() => setQuickState('idle'), 2000);
  } else if (state === 'error') {
    quickBusy = false;
    quickBtn.style.color = '#e05252';
    quickBtn.style.opacity = '1';
    quickBtn.title = 'Download failed - click to retry';
    if (svg) svg.style.animation = 'none';
    setTimeout(() => setQuickState('idle'), 2500);
  } else {
    quickBusy = false;
    quickBtn.style.color = '#e8b04b';
    quickBtn.style.opacity = '1';
    quickBtn.title = 'Download this song (Suno Advanced)';
    if (svg) svg.style.animation = 'none';
  }
}

function quickDownload() {
  if (quickBusy) return;
  setQuickState('busy');
  safeSend({ type: MESSAGE_TYPES.DIRECT_DOWNLOAD }, (response) => {
    void chrome.runtime.lastError;
    if (!response || response.error) {
      log('Quick download error:', response.error);
      setQuickState('error');
    }
    // Success/progress is driven by the progress messages below.
  });
}

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
    background: #111213;
    border: 1px solid #2a2b2e;
    border-radius: 6px;
    box-shadow: 0 4px 18px rgba(0,0,0,0.5);
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #ededed;
    overflow: hidden;
  `;
  
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #2a2b2e;background:#18191b;">
      <div style="display:flex;align-items:center;gap:8px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#e8b04b" stroke-width="2">
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
        <span style="font-weight:600;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;">Suno Advanced</span>
      </div>
      <button id="suno-panel-close" style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:4px;opacity:0.7;transition:opacity 0.2s;">×</button>
    </div>
    <div id="suno-panel-content" style="padding:16px;">
      <div id="suno-panel-idle" style="display:none;text-align:center;color:#888;">
        <p style="margin:0 0 12px;">Play a song on Suno to see details</p>
        <button id="suno-btn-add-current" style="background:#e8b04b;color:#141414;border:none;padding:10px 16px;border-radius:4px;cursor:pointer;font-weight:500;">+ Add Current Song</button>
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
            <div id="suno-progress-bar" style="width:0%;height:100%;background:#e8b04b;border-radius:2px;transition:width 0.5s;"></div>
          </div>
          <span id="suno-duration" style="font-size:12px;color:#888;font-variant-numeric:tabular-nums;">0:00</span>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="suno-btn-record" style="flex:1;background:#e05252;color:#fff;border:none;padding:10px;border-radius:4px;cursor:pointer;font-weight:600;display:flex;align-items:center;justify-content:center;gap:6px;">
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
          <div id="suno-rec-progress" style="width:0%;height:100%;background:#e05252;border-radius:3px;transition:width 0.5s;"></div>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="suno-btn-stop-rec" style="flex:1;background:#e05252;color:#fff;border:none;padding:10px;border-radius:4px;cursor:pointer;font-weight:600;">Stop Recording</button>
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
  
  safeSend({
    type: MESSAGE_TYPES.ADD_TO_QUEUE,
    item: queueItem
  }, (response) => {
    void chrome.runtime.lastError;
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
  safeSend({ type: MESSAGE_TYPES.CONTENT_SCRIPT_READY });
}

// ============ INITIALIZATION ============
function init() {
  log('Content script loaded');
  
  // Create the one-click download icon near the player
  createQuickDownloadButton();

  // Spin animation for the busy state
  const spinStyle = document.createElement('style');
  spinStyle.textContent = '@keyframes suno-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(spinStyle);

  // Announce ready
  announceReady();
  
  // Listen for progress messages from background (drives the quick icon)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === MESSAGE_TYPES.DOWNLOAD_COMPLETE) {
      setQuickState('done');
    } else if (message.type === MESSAGE_TYPES.RECORDING_ERROR) {
      setQuickState('error');
    }
  });
  
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