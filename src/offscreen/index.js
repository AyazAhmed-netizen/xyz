// Offscreen Document - MP3 Encoding with lamejs
// Runs in isolated context for audio processing

import { MESSAGE_TYPES, MP3_ENCODER_CONFIG } from '../shared/constants.js';

let lamejs = null;

// ============ LAMEJS LOADER ============
async function loadLamejs() {
  if (lamejs) return lamejs;
  
  try {
    // Try to load from CDN
    const response = await fetch('https://cdn.jsdelivr.net/npm/lamejs@1.2.0/lame.min.js');
    const code = await response.text();
    eval(code);
    lamejs = window.lamejs;
    return lamejs;
  } catch (error) {
    console.error('Failed to load lamejs:', error);
    throw new Error('MP3 encoder not available');
  }
}

// ============ AUDIO DECODING ============
async function decodeAudioBlob(audioBlob) {
  const audioContext = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: MP3_ENCODER_CONFIG.SAMPLE_RATE
  });
  
  const arrayBuffer = await audioBlob.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  
  return {
    audioBuffer,
    sampleRate: audioBuffer.sampleRate,
    numberOfChannels: audioBuffer.numberOfChannels,
    length: audioBuffer.length
  };
}

// ============ MP3 ENCODING ============
async function encodeToMP3(audioBlob, quality = 192, onProgress) {
  const lame = await loadLamejs();
  const { audioBuffer, sampleRate, numberOfChannels, length } = await decodeAudioBlob(audioBlob);
  
  const mp3encoder = new lame.Mp3Encoder(numberOfChannels, sampleRate, quality);
  const samples = new Int16Array(MP3_ENCODER_CONFIG.CHUNK_SIZE);
  let mp3Data = [];
  let totalSamples = 0;
  const totalChunks = Math.ceil(length / MP3_ENCODER_CONFIG.CHUNK_SIZE);
  
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    // Normalize to 16-bit
    for (let i = 0; i < length; i++) {
      samples[i] = Math.max(-32768, Math.min(32767, Math.round(channelData[i] * 32767)));
    }
  }
  
  // Process in chunks
  for (let i = 0; i < length; i += MP3_ENCODER_CONFIG.CHUNK_SIZE) {
    const remaining = Math.min(MP3_ENCODER_CONFIG.CHUNK_SIZE, length - i);
    
    // Interleave channels if stereo
    if (numberOfChannels === 2) {
      const left = audioBuffer.getChannelData(0).subarray(i, i + remaining);
      const right = audioBuffer.getChannelData(1).subarray(i, i + remaining);
      for (let j = 0; j < remaining; j++) {
        samples[j * 2] = Math.max(-32768, Math.min(32767, Math.round(left[j] * 32767)));
        samples[j * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(right[j] * 32767)));
      }
      const mp3buf = mp3encoder.encodeBuffer(samples.subarray(0, remaining * 2));
      if (mp3buf.length > 0) mp3Data.push(mp3buf);
    } else {
      const mono = audioBuffer.getChannelData(0).subarray(i, i + remaining);
      for (let j = 0; j < remaining; j++) {
        samples[j] = Math.max(-32768, Math.min(32767, Math.round(mono[j] * 32767)));
      }
      const mp3buf = mp3encoder.encodeBuffer(samples.subarray(0, remaining));
      if (mp3buf.length > 0) mp3Data.push(mp3buf);
    }
    
    totalSamples += remaining;
    
    // Report progress
    if (onProgress && i % (MP3_ENCODER_CONFIG.CHUNK_SIZE * MP3_ENCODER_CONFIG.PROGRESS_THROTTLE) === 0) {
      const progress = Math.round((totalSamples / length) * 100);
      onProgress(progress);
    }
    
    // Yield to main thread
    if (i % (MP3_ENCODER_CONFIG.CHUNK_SIZE * 10) === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  
  // Flush encoder
  const flushBuf = mp3encoder.flush();
  if (flushBuf.length > 0) mp3Data.push(flushBuf);
  
  if (onProgress) onProgress(100);
  
  const mp3Blob = new Blob(mp3Data, { type: 'audio/mp3' });
  return mp3Blob;
}

// ============ MESSAGE HANDLER ============
self.onmessage = async (event) => {
  const { data } = event;
  
  if (data.type === MESSAGE_TYPES.CONVERT_TO_MP3) {
    const { audioBlob, quality, ports } = data;
    
    try {
      const mp3Blob = await encodeToMP3(audioBlob, quality, (progress) => {
        // Send progress back via MessageChannel
        ports?.[0]?.postMessage({
          type: MESSAGE_TYPES.MP3_PROGRESS,
          progress
        });
      });
      
      // Send result back
      ports?.[0]?.postMessage({
        type: MESSAGE_TYPES.MP3_READY,
        blob: mp3Blob
      });
    } catch (error) {
      console.error('MP3 encoding failed:', error);
      ports?.[0]?.postMessage({
        type: MESSAGE_TYPES.MP3_ERROR,
        error: error.message
      });
    }
  }
};

console.log('Suno Advanced Downloader offscreen document loaded');