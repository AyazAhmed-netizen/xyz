(() => {
  // src/shared/constants.js
  var QUEUE_STATUSES = {
    PENDING: "pending",
    RECORDING: "recording",
    ENCODING: "encoding",
    DOWNLOADING: "downloading",
    COMPLETED: "completed",
    FAILED: "failed"
  };
  var ACTIVE_STATUSES = [
    QUEUE_STATUSES.RECORDING,
    QUEUE_STATUSES.ENCODING,
    QUEUE_STATUSES.DOWNLOADING
  ];
  var MESSAGE_TYPES = {
    // Queue operations
    GET_QUEUE: "GET_QUEUE",
    ADD_TO_QUEUE: "ADD_TO_QUEUE",
    REMOVE_FROM_QUEUE: "REMOVE_FROM_QUEUE",
    CLEAR_QUEUE: "CLEAR_QUEUE",
    RETRY_QUEUE_ITEM: "RETRY_QUEUE_ITEM",
    QUEUE_CHANGED: "QUEUE_CHANGED",
    // History
    GET_HISTORY: "GET_HISTORY",
    REMOVE_FROM_HISTORY: "REMOVE_FROM_HISTORY",
    CLEAR_HISTORY: "CLEAR_HISTORY",
    HISTORY_CHANGED: "HISTORY_CHANGED",
    // Settings
    GET_SETTINGS: "GET_SETTINGS",
    UPDATE_SETTINGS: "UPDATE_SETTINGS",
    // Recording
    START_RECORDING: "START_RECORDING",
    STOP_RECORDING: "STOP_RECORDING",
    DIRECT_DOWNLOAD: "DIRECT_DOWNLOAD",
    RECORDING_STARTED: "RECORDING_STARTED",
    RECORDING_PROGRESS: "RECORDING_PROGRESS",
    RECORDING_COMPLETE: "RECORDING_COMPLETE",
    RECORDING_ERROR: "RECORDING_ERROR",
    // Encoding/Download
    ENCODING_PROGRESS: "ENCODING_PROGRESS",
    DOWNLOAD_PROGRESS: "DOWNLOAD_PROGRESS",
    DOWNLOAD_COMPLETE: "DOWNLOAD_COMPLETE",
    CONVERT_TO_MP3: "CONVERT_TO_MP3",
    // Metadata
    GET_METADATA: "GET_METADATA",
    GET_PLAY_STATE: "GET_PLAY_STATE",
    GET_PLAYBACK_INFO: "GET_PLAYBACK_INFO",
    GET_AUDIO_URL: "GET_AUDIO_URL",
    // UI
    OPEN_POPUP: "OPEN_POPUP",
    OPEN_OFFSCREEN: "OPEN_OFFSCREEN",
    OPEN_OPTIONS: "OPEN_OPTIONS",
    CONTENT_SCRIPT_READY: "CONTENT_SCRIPT_READY",
    PING: "PING",
    // Extension-wide lifecycle events (delivered to side panel + popup)
    DOWNLOAD_STARTED: "DOWNLOAD_STARTED",
    FETCH_PROGRESS: "FETCH_PROGRESS",
    PIPELINE_STAGE: "PIPELINE_STAGE",
    ACTIVITY: "ACTIVITY",
    // Offscreen
    MP3_PROGRESS: "MP3_PROGRESS",
    MP3_READY: "MP3_READY",
    MP3_ERROR: "MP3_ERROR",
    CREATE_BLOB_URL: "CREATE_BLOB_URL",
    REVOKE_BLOB_URL: "REVOKE_BLOB_URL",
    FETCH_AUDIO: "FETCH_AUDIO",
    FETCH_AUDIO_PROGRESS: "FETCH_AUDIO_PROGRESS"
  };
  var PLAYBAR_SELECTORS = [
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
  var AUDIO_SELECTORS = [
    "audio#active-audio-play",
    'audio[data-testid="audio-player"]',
    'audio[id*="audio-play"]:not(#silent-audio)',
    'audio[class*="player"]',
    "audio[controls]",
    "audio:not(#silent-audio)",
    "video"
  ];
  var EXCLUDED_TEXTS = [
    "explore",
    "library",
    "create",
    "suno",
    "home",
    "search",
    "playlist",
    "my library",
    "liked songs",
    "for you"
  ];
  var EXCLUDED_ARTIST_TEXTS = [
    "explore",
    "library",
    "create",
    "suno",
    "home",
    "search",
    "playlist"
  ];
  var RECORDING_CONFIG = {
    MIME_TYPES: ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"],
    CHUNK_INTERVAL_MS: 100,
    PROGRESS_INTERVAL_MS: 1e3,
    MAX_DURATION_BUFFER_MS: 1e4,
    DEFAULT_DURATION_MS: 18e4
  };
  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const CHUNK = 32768;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  // src/content/index.js
  var mediaRecorder = null;
  var recordedChunks = [];
  var currentQueueItemId = null;
  var recordingStartTime = 0;
  var progressInterval = null;
  var currentAudioElement = null;
  var panel = null;
  var isRecording = false;
  function safeSend(message, callback) {
    try {
      const p = chrome.runtime.sendMessage(message, callback);
      if (p && p.catch) p.catch(() => {
      });
    } catch (e) {
    }
  }
  function log(...args) {
    console.log("[Suno Advanced]", ...args);
  }
  function findPlaybar() {
    for (const selector of PLAYBAR_SELECTORS) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch (e) {
        log("Invalid playbar selector:", selector, e.message);
      }
    }
    return null;
  }
  function isPlaceholderAudio(el) {
    const src = el.currentSrc || el.src || "";
    return el.id === "silent-audio" || /forbidden\.webm|sil-100|silent/i.test(src);
  }
  function findAudioElement() {
    for (const selector of AUDIO_SELECTORS) {
      try {
        const el = document.querySelector(selector);
        if (el && !isPlaceholderAudio(el) && (el.currentSrc || el.src || el.querySelector("source"))) {
          log("Found active audio via", selector);
          return el;
        }
      } catch (e) {
      }
    }
    const allMedia = document.querySelectorAll("audio, video");
    for (const el of allMedia) {
      if (isPlaceholderAudio(el)) continue;
      if (!el.paused && el.currentTime > 0 && el.duration && !isNaN(el.duration) && isFinite(el.duration)) {
        log("Found actively playing audio");
        return el;
      }
    }
    for (const el of allMedia) {
      if (isPlaceholderAudio(el)) continue;
      if (el.duration && !isNaN(el.duration) && isFinite(el.duration) && el.duration > 0) {
        log("Found audio with duration");
        return el;
      }
    }
    return null;
  }
  function findRecentAudioUrl() {
    try {
      const entries = performance.getEntriesByType("resource").filter((e) => /cdn(-o)?\.suno\.com|\.suno\.com\/.*\.(mp3|m4a|ogg|wav)/i.test(e.name)).filter((e) => !/sil-100|silent/i.test(e.name)).sort((a, b) => b.responseEnd - a.responseEnd);
      if (entries.length) {
        log("Found recent audio URL:", entries[0].name);
        return entries[0].name;
      }
    } catch (e) {
    }
    return "";
  }
  function isValidText(text, excludedList) {
    if (!text || text.length < 2) return false;
    const lower = text.toLowerCase().trim();
    return !excludedList.includes(lower);
  }
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
    if (playbar) {
      const t = playbar.querySelector('[aria-label^="Playbar: Title for "]');
      const tText = t && (t.textContent.trim() || t.getAttribute("aria-label").replace(/^Playbar: Title for /, "").trim());
      if (tText) metadata.songName = tText;
      const a = playbar.querySelector('[aria-label^="Playbar: Artist for "]');
      if (a && a.textContent.trim()) metadata.artist = a.textContent.trim();
      const link = playbar.querySelector('a[href^="/song/"]');
      if (link) metadata.pageUrl = new URL(link.getAttribute("href"), location.origin).href;
      const img = playbar.querySelector('img[src^="http"]');
      if (img) metadata.coverUrl = img.src;
    }
    const scopes = [];
    if (playbar) scopes.push(playbar);
    if (audioEl) {
      let ancestor = audioEl.parentElement;
      while (ancestor && ancestor !== document.body) {
        scopes.push(ancestor);
        ancestor = ancestor.parentElement;
      }
      const activeCard = document.querySelector(
        '[class*="song"][class*="active" i], [class*="track"][class*="active" i], [class*="song"][class*="playing" i], [class*="track"][class*="playing" i], [data-testid*="song"][class*="active" i], [data-testid*="song"][class*="playing" i]'
      );
      if (activeCard && !scopes.includes(activeCard)) scopes.push(activeCard);
      log("Found audio element, searching", scopes.length, "ancestor scopes + active card");
    } else {
      log("No playbar or audio element found");
    }
    scopes.push(document.body);
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
        const isBodyScope = scope === document.body;
        if (!isBodyScope) {
          titleSelectors.push("h1", "h2", "h3", "h4");
        }
        titleSelectors.push('span[class*="title"]', 'div[class*="title"]');
        for (const selector of titleSelectors) {
          const el = scope.querySelector(selector);
          const text = el?.textContent?.trim();
          if (isValidText(text, EXCLUDED_TEXTS)) {
            metadata.songName = text;
            log("Found song name:", text, "via selector:", selector);
            break;
          }
        }
        if (!metadata.songName && scope !== document.body && audioEl) {
          const broader = findPlausibleSongTitle(scope, audioEl);
          if (broader) {
            metadata.songName = broader;
            log("Found song name (broader scan):", broader);
            break;
          }
        }
      }
    }
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
            log("Found artist:", text, "via selector:", selector);
            break;
          }
        }
      }
    }
    function findPlausibleSongTitle(rootScope, audioEl2) {
      const candidates = [];
      const walker = document.createTreeWalker(
        rootScope,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: (node2) => {
            const tag = node2.tagName?.toLowerCase();
            if (!["span", "div", "p", "h1", "h2", "h3", "h4", "a"].includes(tag)) {
              return NodeFilter.FILTER_SKIP;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      let node;
      while (node = walker.nextNode()) {
        const text = node.textContent?.trim();
        if (!text || text.length < 2 || text.length > 120) continue;
        const lower = text.toLowerCase();
        if (EXCLUDED_TEXTS.includes(lower)) continue;
        if (lower.includes("explore") || lower.includes("library") || lower.includes("create") || lower.includes("playlist") || lower.includes("for you") || lower.includes("best of") || lower.includes("suno") || lower.includes("home") || lower.includes("search")) continue;
        const distance = node.contains(audioEl2) || audioEl2.contains(node) ? 0 : 1;
        candidates.push({ text, distance });
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.distance - b.distance || a.text.length - b.text.length);
      return candidates[0].text;
    }
    const hasPlayingAudio = !!audioEl && !audioEl.paused && audioEl.currentTime > 0;
    if (!metadata.songName) {
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content || document.querySelector('meta[name="og:title"]')?.content;
      if (ogTitle && isValidText(ogTitle, EXCLUDED_TEXTS)) {
        metadata.songName = ogTitle.replace(/\s*\|\s*Suno\s*$/i, "").trim();
        log("Found song name from og:title:", metadata.songName);
      }
    }
    if (!metadata.songName) {
      const twitterTitle = document.querySelector('meta[name="twitter:title"]')?.content;
      if (twitterTitle && isValidText(twitterTitle, EXCLUDED_TEXTS)) {
        metadata.songName = twitterTitle.replace(/\s*\|\s*Suno\s*$/i, "").trim();
        log("Found song name from twitter:title:", metadata.songName);
      }
    }
    if (!metadata.songName) {
      const t = document.title || "";
      const m = t.match(/^(.+?)\s*[|·]\s*Suno/i);
      if (m && isValidText(m[1].trim(), EXCLUDED_TEXTS)) {
        metadata.songName = m[1].trim();
        log("Found song name from document.title:", metadata.songName);
      }
    }
    if (!metadata.artist) {
      const ogArtist = document.querySelector('meta[property="music:creator"]')?.content || document.querySelector('meta[property="og:artist"]')?.content;
      if (ogArtist && ogArtist.length > 1) {
        metadata.artist = ogArtist.trim();
        log("Found artist from meta:", metadata.artist);
      }
    }
    if (!metadata.coverUrl) {
      const ogImage = document.querySelector('meta[property="og:image"]')?.content || document.querySelector('meta[name="twitter:image"]')?.content;
      if (ogImage) {
        metadata.coverUrl = ogImage;
        log("Found cover from og:image:", metadata.coverUrl);
      }
    }
    if (!metadata.duration) {
      const ogDuration = document.querySelector('meta[property="music:duration"]')?.content;
      if (ogDuration) {
        const secs = parseInt(ogDuration, 10);
        if (!isNaN(secs) && secs > 0) {
          metadata.duration = secs * 1e3;
          log("Found duration from music:duration:", metadata.duration);
        }
      }
    }
    if (!metadata.duration) {
      const audioEl2 = findAudioElement();
      if (audioEl2 && audioEl2.duration && !isNaN(audioEl2.duration) && isFinite(audioEl2.duration) && audioEl2.duration > 0) {
        metadata.duration = Math.floor(audioEl2.duration * 1e3);
        log("Found duration from audio element:", metadata.duration);
      }
    }
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
            metadata.duration = (parseInt(match[1]) * 60 + parseInt(match[2])) * 1e3;
            log("Found duration from UI:", metadata.duration, "via selector:", selector);
            break;
          }
        }
      }
    }
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
          log("Found cover:", metadata.coverUrl, "via selector:", selector);
          break;
        }
      }
    }
    if (!metadata.songName) {
      const urlMatch = window.location.href.match(/\/song\/([^/?]+)/);
      if (urlMatch) {
        metadata.songName = decodeURIComponent(urlMatch[1]).replace(/-/g, " ");
        log("Found song name from URL:", metadata.songName);
      } else {
        metadata.songName = "Suno Song";
      }
    }
    if (!metadata.artist) {
      metadata.artist = "Unknown Artist";
    }
    log("Final metadata:", metadata);
    return metadata;
  }
  function getPlayState() {
    const audioEl = findAudioElement();
    return {
      isPlaying: audioEl ? !audioEl.paused : false,
      currentTime: audioEl ? audioEl.currentTime * 1e3 : 0,
      duration: audioEl ? audioEl.duration * 1e3 : 0,
      hasAudio: !!audioEl
    };
  }
  function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  async function waitFor(fn, timeoutMs = 1e4, stepMs = 200) {
    const end = Date.now() + timeoutMs;
    for (; ; ) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleepMs(stepMs);
    }
  }
  function isUsable(btn) {
    return btn && !btn.disabled && !btn.hasAttribute("data-trigger-disabled") && btn.offsetParent !== null;
  }
  function clickPlayButton() {
    const pageButtons = [...document.querySelectorAll("button[aria-label]")].filter((b) => {
      const l = b.getAttribute("aria-label") || "";
      return /^play( song| this song| clip| track)?$/i.test(l.trim()) && isUsable(b);
    });
    const playbarBtn = document.querySelector('button[aria-label="Playbar: Play button"]');
    const target = pageButtons[0] || (isUsable(playbarBtn) ? playbarBtn : null);
    if (target) {
      target.click();
      return true;
    }
    return false;
  }
  async function ensureAudioPlaying() {
    let audio = findAudioElement();
    if (!audio) {
      clickPlayButton();
      audio = await waitFor(() => findAudioElement(), 12e3);
    }
    if (!audio) {
      throw new Error("Could not start the song automatically. Open the song page (or press play once on Suno) and try again.");
    }
    if (audio.paused) {
      try {
        await audio.play();
      } catch (e) {
        clickPlayButton();
      }
      await waitFor(() => !audio.paused, 4e3);
    }
    await waitFor(() => Number.isFinite(audio.duration) && audio.duration > 0, 6e3);
    return audio;
  }
  async function startRecording(queueItemId, metadata) {
    log("Starting recording for:", queueItemId);
    if (isRecording) {
      safeSend({
        type: MESSAGE_TYPES.RECORDING_ERROR,
        queueItemId,
        error: "A recording is already in progress."
      });
      return false;
    }
    try {
      const audioEl = await ensureAudioPlaying();
      currentAudioElement = audioEl;
      currentQueueItemId = queueItemId;
      isRecording = true;
      recordedChunks = [];
      if (audioEl.currentTime > 1) {
        audioEl.currentTime = 0;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1500);
          audioEl.addEventListener("seeked", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
      if (audioEl.paused) {
        try {
          await audioEl.play();
        } catch (e) {
          throw new Error("Audio is paused and could not be resumed automatically.");
        }
      }
      const realDuration = Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? Math.floor(audioEl.duration * 1e3) : 0;
      const totalDuration = realDuration || metadata.duration || 0;
      recordingStartTime = Date.now();
      const stream = audioEl.captureStream ? audioEl.captureStream() : audioEl.srcObject;
      if (!stream) {
        throw new Error("Could not capture audio stream. Browser may not support captureStream.");
      }
      const audioTracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
      if (audioTracks.length === 0) {
        throw new Error("No audio tracks available to record. Make sure the song is playing and not muted.");
      }
      const mimeType = RECORDING_CONFIG.MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) {
        throw new Error("No supported audio format found");
      }
      log("Using mime type:", mimeType);
      const recordingId = queueItemId;
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorder = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      };
      recorder.onstop = async () => {
        log("MediaRecorder stopped");
        const audioBlob = new Blob(recordedChunks, { type: mimeType });
        log("Recording complete, blob size:", audioBlob.size);
        const b64 = bufferToBase64(await audioBlob.arrayBuffer());
        safeSend({
          type: MESSAGE_TYPES.RECORDING_COMPLETE,
          queueItemId: recordingId,
          b64,
          mimeType
        });
        try {
          audioEl.pause();
        } catch (e) {
        }
        resetRecordingState();
      };
      recorder.onerror = (event) => {
        const errMsg = event.error?.message || String(event.error || "Recording failed");
        log("MediaRecorder error:", errMsg);
        safeSend({
          type: MESSAGE_TYPES.RECORDING_ERROR,
          queueItemId: recordingId,
          error: errMsg
        });
        resetRecordingState();
      };
      recorder.start(RECORDING_CONFIG.CHUNK_INTERVAL_MS);
      log("MediaRecorder started");
      startProgressTracking(totalDuration);
      const live = extractSongMetadata();
      const liveMeta = {};
      if (live.songName && live.songName !== "Suno Song") liveMeta.songName = live.songName;
      if (live.artist && live.artist !== "Unknown Artist") liveMeta.artist = live.artist;
      if (live.coverUrl) liveMeta.coverUrl = live.coverUrl;
      if (live.pageUrl) liveMeta.pageUrl = live.pageUrl;
      if (totalDuration) liveMeta.duration = totalDuration;
      safeSend({ type: MESSAGE_TYPES.RECORDING_STARTED, queueItemId, metadata: liveMeta });
      monitorSongEnd(totalDuration);
      return true;
    } catch (error) {
      const errMsg = error?.message || String(error);
      log("Recording failed:", errMsg);
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
    log("Stopping recording");
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    } else {
      resetRecordingState();
    }
  }
  function resetRecordingState() {
    log("Resetting recording state");
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
        progress = Math.min(100, Math.round(elapsed / totalDuration * 100));
      } else {
        progress = Math.min(95, Math.round(elapsed / RECORDING_CONFIG.DEFAULT_DURATION_MS * 100));
      }
      safeSend({
        type: MESSAGE_TYPES.RECORDING_PROGRESS,
        queueItemId: currentQueueItemId,
        progress,
        elapsed,
        totalDuration,
        label: "Recording\u2026"
      });
    }, RECORDING_CONFIG.PROGRESS_INTERVAL_MS);
  }
  function monitorSongEnd(totalDuration) {
    const startSrc = currentAudioElement ? currentAudioElement.currentSrc || currentAudioElement.src : "";
    const checkInterval = setInterval(() => {
      if (!currentQueueItemId || !currentAudioElement) {
        clearInterval(checkInterval);
        return;
      }
      const audio = currentAudioElement;
      const elapsed = Date.now() - recordingStartTime;
      const nowSrc = audio.currentSrc || audio.src;
      if (startSrc && nowSrc && nowSrc !== startSrc) {
        log("Track changed, stopping recording");
        clearInterval(checkInterval);
        stopRecording();
        return;
      }
      if (audio.ended) {
        log("Audio ended naturally, stopping recording");
        clearInterval(checkInterval);
        stopRecording();
        return;
      }
      if (totalDuration && totalDuration > 0 && elapsed > totalDuration + RECORDING_CONFIG.MAX_DURATION_BUFFER_MS) {
        log("Duration exceeded buffer, stopping recording");
        clearInterval(checkInterval);
        stopRecording();
        return;
      }
      if (audio.paused && elapsed > 5e3) {
        log("Audio paused, stopping recording");
        clearInterval(checkInterval);
        stopRecording();
        return;
      }
    }, 1e3);
  }
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
            let src = el ? el.currentSrc || el.src || "" : "";
            if (!src || src.startsWith("blob:")) {
              src = findRecentAudioUrl();
            }
            sendResponse({ audioUrl: src, metadata: extractSongMetadata() });
            break;
          }
          case MESSAGE_TYPES.START_RECORDING:
            log("Received START_RECORDING:", message.queueItemId);
            let startMetadata = message.metadata;
            if (!startMetadata) {
              startMetadata = extractSongMetadata();
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
            sendResponse({ error: "Unknown message type" });
        }
      } catch (error) {
        log("Message handler error:", error);
        sendResponse({ error: error.message });
      }
    })();
    return true;
  });
  var quickBtn = null;
  var quickBusy = false;
  function createQuickDownloadButton() {
    if (quickBtn) return quickBtn;
    quickBtn = document.createElement("button");
    quickBtn.id = "suno-quick-download";
    quickBtn.type = "button";
    quickBtn.title = "Download this song (Suno Advanced)";
    quickBtn.setAttribute("aria-label", "Download this song");
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
    quickBtn.addEventListener("mouseenter", () => {
      quickBtn.style.transform = "scale(1.08)";
      quickBtn.style.borderColor = "#e8b04b";
    });
    quickBtn.addEventListener("mouseleave", () => {
      quickBtn.style.transform = "scale(1)";
      quickBtn.style.borderColor = "#3a3b3f";
    });
    quickBtn.addEventListener("click", () => quickDownload());
    (document.body || document.documentElement).appendChild(quickBtn);
    return quickBtn;
  }
  function setQuickState(state) {
    if (!quickBtn) return;
    const svg = quickBtn.querySelector("svg");
    if (state === "busy") {
      quickBusy = true;
      quickBtn.style.color = "#e05252";
      quickBtn.style.opacity = "0.85";
      quickBtn.title = "Downloading...";
      if (svg) svg.style.animation = "suno-spin 1s linear infinite";
    } else if (state === "done") {
      quickBusy = false;
      quickBtn.style.color = "#6fbf8f";
      quickBtn.style.opacity = "1";
      quickBtn.title = "Download complete";
      if (svg) svg.style.animation = "none";
      setTimeout(() => setQuickState("idle"), 2e3);
    } else if (state === "error") {
      quickBusy = false;
      quickBtn.style.color = "#e05252";
      quickBtn.style.opacity = "1";
      quickBtn.title = "Download failed - click to retry";
      if (svg) svg.style.animation = "none";
      setTimeout(() => setQuickState("idle"), 2500);
    } else {
      quickBusy = false;
      quickBtn.style.color = "#e8b04b";
      quickBtn.style.opacity = "1";
      quickBtn.title = "Download this song (Suno Advanced)";
      if (svg) svg.style.animation = "none";
    }
  }
  function quickDownload() {
    if (quickBusy) return;
    setQuickState("busy");
    safeSend({ type: MESSAGE_TYPES.DIRECT_DOWNLOAD }, (response) => {
      void chrome.runtime.lastError;
      if (!response || response.error) {
        log("Quick download error:", response.error);
        setQuickState("error");
      }
    });
  }
  function announceReady() {
    safeSend({ type: MESSAGE_TYPES.CONTENT_SCRIPT_READY });
  }
  function init() {
    log("Content script loaded");
    createQuickDownloadButton();
    const spinStyle = document.createElement("style");
    spinStyle.textContent = "@keyframes suno-spin { to { transform: rotate(360deg); } }";
    document.head.appendChild(spinStyle);
    announceReady();
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === MESSAGE_TYPES.DOWNLOAD_COMPLETE) {
        setQuickState("done");
      } else if (message.type === MESSAGE_TYPES.RECORDING_ERROR) {
        setQuickState("error");
      }
    });
    log("Initialization complete");
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  window.__SUNO_ADVANCED__ = {
    extractSongMetadata,
    getPlayState,
    findAudioElement,
    findPlaybar,
    startRecording,
    stopRecording,
    panel: () => panel
  };
})();
