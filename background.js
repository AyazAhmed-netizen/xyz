// background.js - Service worker for handling downloads and storage

chrome.runtime.onInstalled.addListener(() => {
  console.log('Suno Downloader installed');
});

// Handle download requests from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DOWNLOAD_AUDIO') {
    const { blob, filename, metadata } = message;
    
    // Create object URL for the blob
    const url = URL.createObjectURL(blob);
    
    // Download the file
    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('Download failed:', chrome.runtime.lastError);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        // Save to history
        saveToHistory(metadata, downloadId);
        sendResponse({ success: true, downloadId });
      }
      // Clean up the object URL after a delay
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    
    return true; // Keep message channel open for async response
  }
  
  if (message.type === 'GET_HISTORY') {
    getHistory().then(history => sendResponse({ history }));
    return true;
  }
  
  if (message.type === 'CLEAR_HISTORY') {
    clearHistory().then(() => sendResponse({ success: true }));
    return true;
  }
  
  if (message.type === 'GET_STATS') {
    getStats().then(stats => sendResponse({ stats }));
    return true;
  }
});

async function saveToHistory(metadata, downloadId) {
  const { localStorage } = chrome.storage;
  const result = await localStorage.get('sunoHistory');
  const history = result.sunoHistory || [];
  
  const entry = {
    id: Date.now(),
    downloadId,
    title: metadata.title || 'Unknown',
    artist: metadata.artist || 'Unknown',
    duration: metadata.duration || 0,
    timestamp: new Date().toISOString(),
    filename: metadata.filename
  };
  
  history.unshift(entry);
  // Keep only last 100 entries
  if (history.length > 100) history.pop();
  
  await localStorage.set({ sunoHistory: history });
}

async function getHistory() {
  const { localStorage } = chrome.storage;
  const result = await localStorage.get('sunoHistory');
  return result.sunoHistory || [];
}

async function clearHistory() {
  const { localStorage } = chrome.storage;
  await localStorage.set({ sunoHistory: [] });
}

async function getStats() {
  const { localStorage } = chrome.storage;
  const result = await localStorage.get('sunoHistory');
  const history = result.sunoHistory || [];
  
  const totalSongs = history.length;
  const totalDuration = history.reduce((sum, song) => sum + (song.duration || 0), 0);
  const totalMinutes = Math.floor(totalDuration / 60);
  const totalSeconds = Math.floor(totalDuration % 60);
  
  return {
    totalSongs,
    totalDuration,
    totalMinutes,
    totalSeconds,
    formattedDuration: `${totalMinutes}m ${totalSeconds}s`
  };
}