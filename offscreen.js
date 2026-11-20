// offscreen.js - MP3 Encoder using lamejs (runs in offscreen document)
// lamejs is loaded globally from the script tag in offscreen.html

// Ensure lamejs is available
if (typeof lamejs === 'undefined') {
  console.error('lamejs not loaded!');
}

// Convert WebM/Opus audio blob to MP3
async function convertToMP3(audioBlob, quality = 192) {
  let audioContext = null;
  
  try {
    // Validate input
    if (!audioBlob || audioBlob.size === 0) {
      throw new Error('Empty audio blob received');
    }
    
    if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) {
      throw new Error('lamejs not available - reload extension');
    }
    
    // Read audio data as array buffer
    const arrayBuffer = await audioBlob.arrayBuffer();
    
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error('Empty audio data');
    }
    
    // Create audio context to decode
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ sampleRate: 44100 });
    
    // Decode audio data
    let audioBuffer;
    try {
      audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    } catch (decodeError) {
      throw new Error(`Audio decode failed: ${decodeError.message}`);
    }
    
    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error('Decoded audio buffer is empty');
    }
    
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
        pcmData[i * 2] = Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767)));
        pcmData[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767)));
      }
    } else {
      const mono = audioBuffer.getChannelData(0);
      pcmData = new Int16Array(length);
      for (let i = 0; i < length; i++) {
        pcmData[i] = Math.max(-32768, Math.min(32767, Math.round(mono[i] * 32767)));
      }
    }
    
    // Initialize MP3 encoder
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
    
    if (!mp3Blob || mp3Blob.size === 0) {
      throw new Error('MP3 encoding produced empty output');
    }
    
    return mp3Blob;
    
  } catch (error) {
    console.error('MP3 conversion error:', error);
    throw error;
  } finally {
    // Always close audio context to avoid leaks
    if (audioContext && audioContext.state !== 'closed') {
      try {
        await audioContext.close();
      } catch (e) {
        // Ignore close errors
      }
    }
  }
}

// Message handler for MessageChannel (from background)
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
      const errorMsg = error?.message || String(error);
      if (ports && ports[0]) {
        ports[0].postMessage({ type: 'MP3_ERROR', error: errorMsg });
      } else {
        self.postMessage({ type: 'MP3_ERROR', error: errorMsg });
      }
    }
  }
};

// Also handle direct messages from background (fallback)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CONVERT_TO_MP3') {
    convertToMP3(message.audioBlob, message.quality)
      .then(blob => sendResponse({ type: 'MP3_READY', blob }))
      .catch(error => sendResponse({ type: 'MP3_ERROR', error: error.message || String(error) }));
    return true; // Keep channel open for async response
  }
});

console.log('Offscreen MP3 encoder ready');