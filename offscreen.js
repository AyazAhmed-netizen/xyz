// offscreen.js - MP3 Encoder using lamejs (runs in offscreen document)
// lamejs is loaded globally from the script tag in offscreen.html

// Convert WebM/Opus audio blob to MP3
async function convertToMP3(audioBlob, quality = 192) {
  try {
    // Read audio data as array buffer
    const arrayBuffer = await audioBlob.arrayBuffer();
    
    // Create audio context to decode
    const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    // Get PCM data
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    
    // Interleave channels if stereo
    let pcmData;
    if (numChannels === 2) {
      const left = audioBuffer.getChannelData(0);
      const right = audioBuffer.getChannelData(1);
      pcmData = new Int16Array(length * 2);
      for (let i = 0; i < length; i++) {
        pcmData[i * 2] = Math.max(-32768, Math.min(32767, left[i] * 32767));
        pcmData[i * 2 + 1] = Math.max(-32768, Math.min(32767, right[i] * 32767));
      }
    } else {
      const mono = audioBuffer.getChannelData(0);
      pcmData = new Int16Array(length);
      for (let i = 0; i < length; i++) {
        pcmData[i] = Math.max(-32768, Math.min(32767, mono[i] * 32767));
      }
    }
    
    // Initialize MP3 encoder (lamejs is globally available)
    const mp3encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, quality);
    
    // Encode in chunks
    const chunkSize = 1152; // MP3 frame size
    const mp3Data = [];
    
    for (let i = 0; i < pcmData.length; i += chunkSize * numChannels) {
      const chunk = pcmData.subarray(i, i + chunkSize * numChannels);
      const mp3buf = mp3encoder.encodeBuffer(chunk);
      if (mp3buf.length > 0) {
        mp3Data.push(mp3buf);
      }
    }
    
    // Flush encoder
    const mp3buf = mp3encoder.flush();
    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }
    
    // Create final MP3 blob
    const mp3Blob = new Blob(mp3Data, { type: 'audio/mp3' });
    
    audioContext.close();
    return mp3Blob;
    
  } catch (error) {
    console.error('MP3 conversion error:', error);
    throw error;
  }
}

// Message handler
self.onmessage = async (event) => {
  const { type, audioBlob, quality, ports } = event.data;
  
  if (type === 'CONVERT_TO_MP3') {
    try {
      const mp3Blob = await convertToMP3(audioBlob, quality);
      
      // Send result back via MessageChannel
      if (ports && ports[0]) {
        ports[0].postMessage({ type: 'MP3_READY', blob: mp3Blob });
      } else {
        self.postMessage({ type: 'MP3_READY', blob: mp3Blob });
      }
    } catch (error) {
      if (ports && ports[0]) {
        ports[0].postMessage({ type: 'MP3_ERROR', error: error.message });
      } else {
        self.postMessage({ type: 'MP3_ERROR', error: error.message });
      }
    }
  }
};

// Also handle direct messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CONVERT_TO_MP3') {
    convertToMP3(message.audioBlob, message.quality)
      .then(blob => sendResponse({ type: 'MP3_READY', blob }))
      .catch(error => sendResponse({ type: 'MP3_ERROR', error: error.message }));
    return true;
  }
});

console.log('Offscreen MP3 encoder ready');