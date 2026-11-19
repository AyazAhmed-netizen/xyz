// content.js - Advanced Auto-Recorder for Suno with History & Stats

let isRecording = false;
let mediaRecorder = null;
let chunks = [];
let streamRef = null;
let currentSongInfo = null;
let recordingStartTime = null;
let durationCheckInterval = null;
let expectedDuration = null;
let autoStopTimeout = null;

// UI Elements
let floatingPanel = null;
let recordBtn = null;
let statusDisplay = null;
let historyBtn = null;
let statsDisplay = null;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

async function init() {
  // Wait a bit for Suno's player to load
  await sleep(2000);
  createFloatingPanel();
  observePlayer();
  loadHistoryCount();
}

// Create the floating control panel
function createFloatingPanel() {
  if (document.getElementById('suno-downloader-panel')) return;
  
  floatingPanel = document.createElement('div');
  floatingPanel.id = 'suno-downloader-panel';
  floatingPanel.innerHTML = `
    <div class="suno-panel-header">
      <span class="suno-logo">🎵</span>
      <span class="suno-title">Suno Downloader</span>
      <button class="suno-minimize" id="suno-minimize">−</button>
    </div>
    <div class="suno-panel-body" id="suno-panel-body">
      <div class="suno-status" id="suno-status">
        <span class="status-dot" id="status-dot"></span>
        <span id="status-text">Ready - Play a song to auto-record</span>
      </div>
      <div class="suno-controls">
        <button class="suno-btn primary" id="suno-record-btn" disabled>
          <span class="btn-icon">🎙️</span>
          <span class="btn-text">Auto-Record</span>
        </button>
        <button class="suno-btn secondary" id="suno-manual-btn">
          <span class="btn-icon">⏺</span>
          <span class="btn-text">Manual Record</span>
        </button>
      </div>
      <div class="suno-song-info" id="suno-song-info" style="display: none;">
        <div class="info-row"><span class="info-label">Title:</span> <span id="song-title">-</span></div>
        <div class="info-row"><span class="info-label">Artist:</span> <span id="song-artist">-</span></div>
        <div class="info-row"><span class="info-label">Duration:</span> <span id="song-duration">-</span></div>
        <div class="info-row"><span class="info-label">Recorded:</span> <span id="recorded-time">0:00</span></div>
      </div>
      <div class="suno-progress" id="suno-progress" style="display: none;">
        <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
        <div class="progress-text" id="progress-text">0% complete</div>
      </div>
      <div class="suno-stats" id="suno-stats">
        <div class="stat-item"><span class="stat-value" id="stat-songs">0</span><span class="stat-label">Songs</span></div>
        <div class="stat-item"><span class="stat-value" id="stat-time">0m 0s</span><span class="stat-label">Downloaded</span></div>
      </div>
      <button class="suno-btn history-btn" id="suno-history-btn">
        <span class="btn-icon">📜</span>
        <span class="btn-text">History</span>
      </button>
    </div>
    <div class="suno-history-panel" id="suno-history-panel" style="display: none;">
      <div class="history-header">
        <span>Download History</span>
        <button class="suno-close-history" id="suno-close-history">×</button>
      </div>
      <div class="history-list" id="suno-history-list"></div>
      <button class="suno-btn danger" id="suno-clear-history">Clear History</button>
    </div>
  `;
  
  // Add styles
  const style = document.createElement('style');
  style.textContent = `
    #suno-downloader-panel {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 320px;
      background: #1a1a2e;
      border: 1px solid #ff4500;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #eee;
      overflow: hidden;
      transition: all 0.3s ease;
    }
    .suno-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: linear-gradient(90deg, #ff4500, #ff6b35);
      color: white;
      font-weight: 600;
      font-size: 14px;
      cursor: move;
    }
    .suno-logo { margin-right: 8px; }
    .suno-minimize {
      background: none;
      border: none;
      color: white;
      font-size: 20px;
      cursor: pointer;
      line-height: 1;
      padding: 0 4px;
    }
    .suno-panel-body {
      padding: 16px;
      max-height: 500px;
      overflow-y: auto;
    }
    .suno-status {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px;
      background: rgba(255,69,0,0.1);
      border-radius: 8px;
      margin-bottom: 12px;
      font-size: 12px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #444;
      transition: background 0.3s;
    }
    .status-dot.recording { background: #ff4500; animation: pulse 1s infinite; }
    .status-dot.ready { background: #4ade80; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
    .suno-controls {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    .suno-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 10px 16px;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .suno-btn.primary {
      background: linear-gradient(90deg, #ff4500, #ff6b35);
      color: white;
    }
    .suno-btn.primary:disabled {
      background: #444;
      color: #888;
      cursor: not-allowed;
    }
    .suno-btn.primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(255,69,0,0.4);
    }
    .suno-btn.secondary {
      background: rgba(255,255,255,0.1);
      color: #ddd;
      border: 1px solid #333;
    }
    .suno-btn.secondary:hover {
      background: rgba(255,255,255,0.2);
    }
    .suno-btn.history-btn {
      width: 100%;
      background: rgba(0,123,255,0.2);
      color: #64b5f6;
      border: 1px solid rgba(0,123,255,0.3);
      margin-top: 8px;
    }
    .suno-btn.history-btn:hover {
      background: rgba(0,123,255,0.3);
    }
    .suno-btn.danger {
      width: 100%;
      background: rgba(220,53,69,0.2);
      color: #f87171;
      border: 1px solid rgba(220,53,69,0.3);
      margin-top: 12px;
    }
    .suno-btn.danger:hover {
      background: rgba(220,53,69,0.3);
    }
    .suno-song-info {
      background: rgba(255,255,255,0.05);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
      font-size: 12px;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      margin: 4px 0;
    }
    .info-label { color: #888; }
    .suno-progress {
      margin-bottom: 12px;
    }
    .progress-bar {
      height: 6px;
      background: #333;
      border-radius: 3px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #ff4500, #ff6b35);
      border-radius: 3px;
      transition: width 0.5s ease;
      width: 0%;
    }
    .progress-text {
      text-align: center;
      font-size: 11px;
      color: #888;
      margin-top: 4px;
    }
    .suno-stats {
      display: flex;
      justify-content: space-around;
      padding: 12px;
      background: rgba(255,255,255,0.03);
      border-radius: 8px;
      border: 1px solid #333;
    }
    .stat-item {
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .stat-value {
      font-size: 18px;
      font-weight: 700;
      color: #ff4500;
    }
    .stat-label {
      font-size: 10px;
      color: #888;
      text-transform: uppercase;
    }
    .suno-history-panel {
      border-top: 1px solid #333;
      max-height: 300px;
      overflow-y: auto;
    }
    .history-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: rgba(255,69,0,0.1);
      font-weight: 600;
    }
    .suno-close-history {
      background: none;
      border: none;
      color: #888;
      font-size: 20px;
      cursor: pointer;
      line-height: 1;
    }
    .history-list {
      padding: 8px;
    }
    .history-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      margin: 4px 0;
      background: rgba(255,255,255,0.05);
      border-radius: 6px;
      font-size: 12px;
      border: 1px solid transparent;
      transition: border 0.2s;
    }
    .history-item:hover {
      border-color: #333;
    }
    .history-info {
      flex: 1;
      min-width: 0;
    }
    .history-title {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .history-meta {
      display: flex;
      gap: 12px;
      font-size: 10px;
      color: #888;
      margin-top: 2px;
    }
    .history-actions {
      display: flex;
      gap: 4px;
    }
    .history-actions button {
      background: rgba(255,255,255,0.1);
      border: none;
      color: #aaa;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 10px;
      cursor: pointer;
    }
    .history-actions button:hover {
      background: rgba(255,255,255,0.2);
      color: #fff;
    }
    .history-empty {
      text-align: center;
      color: #666;
      padding: 20px;
      font-size: 12px;
    }
    /* Minimized state */
    #suno-downloader-panel.minimized .suno-panel-body {
      display: none;
    }
    #suno-downloader-panel.minimized {
      width: auto;
      min-width: 180px;
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(floatingPanel);
  
  // Get references
  recordBtn = document.getElementById('suno-record-btn');
  statusDisplay = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');
  const manualBtn = document.getElementById('suno-manual-btn');
  const minimizeBtn = document.getElementById('suno-minimize');
  const historyBtn = document.getElementById('suno-history-btn');
  const closeHistoryBtn = document.getElementById('suno-close-history');
  const clearHistoryBtn = document.getElementById('suno-clear-history');
  const historyPanel = document.getElementById('suno-history-panel');
  
  // Event listeners
  recordBtn.addEventListener('click', toggleAutoRecord);
  manualBtn.addEventListener('click', toggleManualRecord);
  minimizeBtn.addEventListener('click', () => floatingPanel.classList.toggle('minimized'));
  historyBtn.addEventListener('click', () => {
    historyPanel.style.display = historyPanel.style.display === 'none' ? 'block' : 'none';
    if (historyPanel.style.display === 'block') loadHistory();
  });
  closeHistoryBtn.addEventListener('click', () => historyPanel.style.display = 'none');
  clearHistoryBtn.addEventListener('click', clearHistory);
  
  // Make panel draggable
  makeDraggable(floatingPanel, floatingPanel.querySelector('.suno-panel-header'));
}

function makeDraggable(element, handle) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  handle.onmousedown = dragMouseDown;
  
  function dragMouseDown(e) {
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }
  
  function elementDrag(e) {
    e.preventDefault();
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    element.style.top = (element.offsetTop - pos2) + "px";
    element.style.left = (element.offsetLeft - pos1) + "px";
    element.style.bottom = 'auto';
    element.style.right = 'auto';
  }
  
  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
  }
}

// Observe the Suno player for song changes
function observePlayer() {
  // Try multiple selectors for Suno's player
  const playerSelectors = [
    'audio',
    'video',
    '[data-testid="audio-player"]',
    '.player audio',
    'main audio',
    '[role="region"] audio'
  ];
  
  let player = null;
  for (const selector of playerSelectors) {
    player = document.querySelector(selector);
    if (player) break;
  }
  
  if (!player) {
    // Wait and retry
    setTimeout(observePlayer, 3000);
    return;
  }
  
  console.log('Found Suno player:', player);
  
  // Watch for play/pause
  player.addEventListener('play', onSongPlay);
  player.addEventListener('pause', onSongPause);
  player.addEventListener('ended', onSongEnded);
  player.addEventListener('timeupdate', onTimeUpdate);
  player.addEventListener('durationchange', onDurationChange);
  player.addEventListener('loadedmetadata', onLoadedMetadata);
  
  // Also check for song info in the DOM
  observeSongInfo();
}

function onLoadedMetadata(e) {
  const player = e.target;
  expectedDuration = player.duration;
  updateSongDurationDisplay(expectedDuration);
}

function onDurationChange(e) {
  const player = e.target;
  if (player.duration && player.duration !== expectedDuration) {
    expectedDuration = player.duration;
    updateSongDurationDisplay(expectedDuration);
  }
}

function onTimeUpdate(e) {
  const player = e.target;
  if (isRecording && expectedDuration) {
    const progress = (player.currentTime / expectedDuration) * 100;
    updateProgress(progress, player.currentTime, expectedDuration);
  }
}

function onSongPlay(e) {
  const player = e.target;
  console.log('Song started playing');
  
  // Get song info
  currentSongInfo = extractSongInfo();
  
  if (currentSongInfo) {
    updateSongInfoDisplay(currentSongInfo);
    showSongInfo(true);
  }
  
  // Check if we should auto-record
  if (!isRecording && recordBtn && !recordBtn.disabled) {
    // Small delay to ensure audio is flowing
    setTimeout(() => {
      if (!isRecording && player.paused === false) {
        startAutoRecording();
      }
    }, 1000);
  }
  
  updateStatus('Recording...', 'recording');
}

function onSongPause(e) {
  console.log('Song paused');
  updateStatus('Paused - Click play to resume recording', 'ready');
}

function onSongEnded(e) {
  console.log('Song ended');
  if (isRecording) {
    stopRecording();
  }
  updateStatus('Song ended - Ready for next song', 'ready');
  showSongInfo(false);
  showProgress(false);
}

// Extract song metadata from the page
function extractSongInfo() {
  // Try multiple ways to get song info
  const titleSelectors = [
    '[data-testid="song-title"]',
    '.song-title',
    'h1[class*="title"]',
    '[class*="SongTitle"]',
    'main h1',
    '[role="heading"]'
  ];
  
  const artistSelectors = [
    '[data-testid="song-artist"]',
    '.song-artist',
    '[class*="Artist"]',
    'main [class*="artist"]'
  ];
  
  let title = 'Unknown Song';
  let artist = 'Unknown Artist';
  
  for (const selector of titleSelectors) {
    const el = document.querySelector(selector);
    if (el && el.textContent.trim()) {
      title = el.textContent.trim();
      break;
    }
  }
  
  for (const selector of artistSelectors) {
    const el = document.querySelector(selector);
    if (el && el.textContent.trim()) {
      artist = el.textContent.trim();
      break;
    }
  }
  
  // Also check URL for song ID
  const urlMatch = window.location.href.match(/\/song\/([^\/]+)/);
  const songId = urlMatch ? urlMatch[1] : null;
  
  return { title, artist, songId, duration: expectedDuration };
}

function observeSongInfo() {
  // Use MutationObserver to detect song changes
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList' || mutation.type === 'characterData') {
        // Check if song info changed
        const newInfo = extractSongInfo();
        if (newInfo && newInfo.title !== currentSongInfo?.title) {
          currentSongInfo = newInfo;
          updateSongInfoDisplay(currentSongInfo);
        }
      }
    }
  });
  
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

// UI Update functions
function updateStatus(text, state) {
  if (!statusDisplay) return;
  statusDisplay.textContent = text;
  const dot = document.getElementById('status-dot');
  if (dot) {
    dot.className = 'status-dot ' + state;
  }
}

function updateSongInfoDisplay(info) {
  const titleEl = document.getElementById('song-title');
  const artistEl = document.getElementById('song-artist');
  const durationEl = document.getElementById('song-duration');
  
  if (titleEl) titleEl.textContent = info.title;
  if (artistEl) artistEl.textContent = info.artist;
  if (durationEl && info.duration) {
    durationEl.textContent = formatTime(info.duration);
  }
}

function showSongInfo(show) {
  const el = document.getElementById('suno-song-info');
  if (el) el.style.display = show ? 'block' : 'none';
}

function showProgress(show) {
  const el = document.getElementById('suno-progress');
  if (el) el.style.display = show ? 'block' : 'none';
}

function updateProgress(percent, current, total) {
  const fill = document.getElementById('progress-fill');
  const text = document.getElementById('progress-text');
  const recordedEl = document.getElementById('recorded-time');
  
  if (fill) fill.style.width = `${Math.min(100, percent)}%`;
  if (text) text.textContent = `${Math.round(percent)}% complete`;
  if (recordedEl) recordedEl.textContent = formatTime(current);
}

function updateSongDurationDisplay(duration) {
  const el = document.getElementById('song-duration');
  if (el && duration) {
    el.textContent = formatTime(duration);
  }
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Recording functions
async function startAutoRecording() {
  if (isRecording) return;
  
  try {
    updateStatus('Starting auto-record...', 'recording');
    recordBtn.disabled = true;
    recordBtn.querySelector('.btn-text').textContent = 'Recording...';
    
    // Get tab audio stream
    streamRef = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      preferCurrentTab: true
    });
    
    // Stop video track, keep only audio
    streamRef.getVideoTracks().forEach(track => track.stop());
    const audioStream = new MediaStream(streamRef.getAudioTracks());
    
    if (audioStream.getAudioTracks().length === 0) {
      throw new Error('No audio track. Enable "Share tab audio" in the permission dialog.');
    }
    
    mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });
    chunks = [];
    recordingStartTime = Date.now();
    
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    
    mediaRecorder.onstop = () => {
      saveRecording();
      cleanupStream();
    };
    
    // Handle user stopping sharing via browser UI
    audioStream.getAudioTracks()[0].onended = () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    };
    
    mediaRecorder.start(100); // Collect data every 100ms
    isRecording = true;
    
    // Set auto-stop timeout based on expected duration
    if (expectedDuration) {
      const timeoutMs = (expectedDuration + 5) * 1000; // Add 5s buffer
      autoStopTimeout = setTimeout(() => {
        if (isRecording) stopRecording();
      }, timeoutMs);
    }
    
    showProgress(true);
    updateStatus(`Auto-recording: ${currentSongInfo?.title || 'Song'}`, 'recording');
    
  } catch (err) {
    console.error('Auto-record failed:', err);
    alert('Failed to start recording. Make sure you selected "This Tab" and checked "Share tab audio".');
    resetRecordButton();
    updateStatus('Ready - Play a song to auto-record', 'ready');
  }
}

async function toggleAutoRecord() {
  if (isRecording) {
    stopRecording();
  } else {
    await startAutoRecording();
  }
}

async function toggleManualRecord() {
  if (isRecording) {
    stopRecording();
  } else {
    // Manual record doesn't wait for song to play
    await startManualRecording();
  }
}

async function startManualRecording() {
  try {
    updateStatus('Starting manual record...', 'recording');
    manualBtn.disabled = true;
    manualBtn.querySelector('.btn-text').textContent = 'Recording...';
    
    streamRef = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      preferCurrentTab: true
    });
    
    streamRef.getVideoTracks().forEach(track => track.stop());
    const audioStream = new MediaStream(streamRef.getAudioTracks());
    
    if (audioStream.getAudioTracks().length === 0) {
      throw new Error('No audio track. Enable "Share tab audio".');
    }
    
    mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });
    chunks = [];
    recordingStartTime = Date.now();
    
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    
    mediaRecorder.onstop = () => {
      saveRecording();
      cleanupStream();
    };
    
    audioStream.getAudioTracks()[0].onended = () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    };
    
    mediaRecorder.start(100);
    isRecording = true;
    showProgress(true);
    updateStatus('Manual recording... Click to stop', 'recording');
    
  } catch (err) {
    console.error('Manual record failed:', err);
    alert('Failed to start recording. Check "Share tab audio".');
    resetManualButton();
    updateStatus('Ready', 'ready');
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  isRecording = false;
  resetRecordButton();
  resetManualButton();
  showProgress(false);
  
  if (autoStopTimeout) {
    clearTimeout(autoStopTimeout);
    autoStopTimeout = null;
  }
}

function resetRecordButton() {
  if (recordBtn) {
    recordBtn.disabled = false;
    recordBtn.querySelector('.btn-text').textContent = 'Auto-Record';
    recordBtn.querySelector('.btn-icon').textContent = '🎙️';
  }
}

function resetManualButton() {
  if (manualBtn) {
    manualBtn.disabled = false;
    manualBtn.querySelector('.btn-text').textContent = 'Manual Record';
    manualBtn.querySelector('.btn-icon').textContent = '⏺';
  }
}

function cleanupStream() {
  if (streamRef) {
    streamRef.getTracks().forEach(track => track.stop());
    streamRef = null;
  }
}

// Save recording via background script
function saveRecording() {
  if (chunks.length === 0) {
    alert('No audio recorded.');
    updateStatus('Ready', 'ready');
    return;
  }
  
  const blob = new Blob(chunks, { type: 'audio/webm' });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeTitle = (currentSongInfo?.title || 'suno-track').replace(/[^a-z0-9]/gi, '_').slice(0, 50);
  const filename = `${safeTitle}-${timestamp}.webm`;
  
  const metadata = {
    title: currentSongInfo?.title || 'Unknown',
    artist: currentSongInfo?.artist || 'Unknown',
    duration: expectedDuration || Math.floor((Date.now() - recordingStartTime) / 1000),
    filename: filename
  };
  
  // Send to background for download and history
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_AUDIO',
    blob: blob,
    filename: filename,
    metadata: metadata
  }, (response) => {
    if (response?.success) {
      updateStatus(`Downloaded: ${metadata.title}`, 'ready');
      loadHistoryCount(); // Refresh stats
    } else {
      console.error('Download failed:', response?.error);
      updateStatus('Download failed', 'ready');
    }
  });
  
  chunks = [];
}

// History functions
async function loadHistoryCount() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
  if (response?.stats) {
    const songsEl = document.getElementById('stat-songs');
    const timeEl = document.getElementById('stat-time');
    if (songsEl) songsEl.textContent = response.stats.totalSongs;
    if (timeEl) timeEl.textContent = response.stats.formattedDuration;
  }
}

async function loadHistory() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  const list = document.getElementById('suno-history-list');
  
  if (!response?.history || response.history.length === 0) {
    list.innerHTML = '<div class="history-empty">No downloads yet. Play a song to start recording!</div>';
    return;
  }
  
  list.innerHTML = response.history.map(item => `
    <div class="history-item" data-id="${item.id}">
      <div class="history-info">
        <div class="history-title">${escapeHtml(item.title)}</div>
        <div class="history-meta">
          <span>${escapeHtml(item.artist)}</span>
          <span>${formatTime(item.duration)}</span>
          <span>${new Date(item.timestamp).toLocaleDateString()}</span>
        </div>
      </div>
      <div class="history-actions">
        <button onclick="reDownload('${item.filename}', '${escapeHtml(item.title)}')">Re-download</button>
      </div>
    </div>
  `).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function clearHistory() {
  if (confirm('Clear all download history?')) {
    await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
    loadHistory();
    loadHistoryCount();
  }
}

// Make reDownload available globally
window.reDownload = function(filename, title) {
  // Re-download would need the blob, so we'd need to store it or re-record
  alert('Re-download requires re-recording. Play the song again and record.');
};

// Utility
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Handle page navigation (SPA)
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    console.log('Page navigated, re-initializing...');
    setTimeout(() => {
      observePlayer();
      currentSongInfo = null;
      showSongInfo(false);
    }, 1000);
  }
}).observe(document, { subtree: true, childList: true });