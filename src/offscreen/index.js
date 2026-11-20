// Offscreen Document - MP3 Encoding + Blob URL host
// Runs in a real DOM context (the MV3 service worker has neither DOM nor
// URL.createObjectURL). lamejs is provided by the local <script> in the HTML.

import { MESSAGE_TYPES, MP3_ENCODER_CONFIG, base64ToBuffer, blobToBase64 } from '../shared/constants.js';

const lame = typeof lamejs !== 'undefined' ? lamejs : null;

// Keep object URLs alive until the background tells us the download finished.
const objectUrls = new Set();

// ============ BLOB URL HELPERS ============
function createBlobUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  return url;
}

function revokeBlobUrl(url) {
  if (!url || !objectUrls.has(url)) return;
  URL.revokeObjectURL(url);
  objectUrls.delete(url);
}

// ============ AUDIO DECODING ============
async function decodeAudioBlob(audioBlob) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextClass();
  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    return audioBuffer;
  } finally {
    if (audioContext.state !== 'closed') {
      await audioContext.close().catch(() => {});
    }
  }
}

// ============ MP3 ENCODING ============
async function encodeToMP3(audioBlob, quality = 192, onProgress) {
  if (!lame || !lame.Mp3Encoder) {
    throw new Error('MP3 encoder not available - reload the extension');
  }
  if (!audioBlob || audioBlob.size === 0) {
    throw new Error('Empty audio blob received');
  }

  const audioBuffer = await decodeAudioBlob(audioBlob);
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;

  const left = audioBuffer.getChannelData(0);
  const right = numChannels > 1 ? audioBuffer.getChannelData(1) : null;

  const toInt16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));

  // lamejs wants SEPARATE Int16 channel buffers: encodeBuffer(left[, right]).
  // (Passing one interleaved buffer throws for stereo input.)
  const encoder = new lame.Mp3Encoder(numChannels > 1 ? 2 : 1, sampleRate, quality);
  const chunkSize = MP3_ENCODER_CONFIG.CHUNK_SIZE; // 1152 samples per frame
  const mp3Chunks = [];
  const leftPcm = new Int16Array(chunkSize);
  const rightPcm = right ? new Int16Array(chunkSize) : null;
  let frameNo = 0;

  for (let i = 0; i < length; i += chunkSize) {
    const remaining = Math.min(chunkSize, length - i);
    const l = remaining === chunkSize ? leftPcm : new Int16Array(remaining);
    const r = right ? (remaining === chunkSize ? rightPcm : new Int16Array(remaining)) : null;

    for (let j = 0; j < remaining; j++) {
      l[j] = toInt16(left[i + j]);
      if (r) r[j] = toInt16(right[i + j]);
    }

    const encoded = r ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l);
    if (encoded && encoded.length > 0) mp3Chunks.push(new Int8Array(encoded));

    if (onProgress && (frameNo++ % MP3_ENCODER_CONFIG.PROGRESS_THROTTLE === 0)) {
      onProgress(Math.min(100, Math.round((i + remaining) / length * 100)));
      // Yield so progress messages can actually be delivered.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const flushed = encoder.flush();
  if (flushed && flushed.length > 0) mp3Chunks.push(new Int8Array(flushed));

  if (onProgress) onProgress(100);

  const mp3Blob = new Blob(mp3Chunks, { type: 'audio/mpeg' });
  if (mp3Blob.size === 0) throw new Error('MP3 encoding produced empty output');
  return mp3Blob;
}

// ============ MESSAGE HANDLER ============
// Replies are sent back via chrome.runtime.sendMessage (no MessagePort transfer,
// which chrome.runtime.sendMessage does not support). Each reply carries the
// original __reqId so background can correlate it to the right caller.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case MESSAGE_TYPES.CREATE_BLOB_URL: {
          try {
            const blob = new Blob([base64ToBuffer(message.b64)], { type: message.mimeType || '' });
            const url = createBlobUrl(blob);
            chrome.runtime.sendMessage({
              type: MESSAGE_TYPES.CREATE_BLOB_URL,
              url,
              __reqId: message.__reqId
            });
          } catch (error) {
            chrome.runtime.sendMessage({
              type: MESSAGE_TYPES.MP3_ERROR,
              error: error.message || String(error),
              __reqId: message.__reqId
            });
          }
          return true;
        }

        case MESSAGE_TYPES.REVOKE_BLOB_URL:
          revokeBlobUrl(message.url);
          return false;

        case MESSAGE_TYPES.FETCH_AUDIO: {
          try {
            const res = await fetch(message.url, { credentials: 'omit' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const total = Number(res.headers.get('content-length')) || 0;
            let blob;
            if (total && res.body) {
              const reader = res.body.getReader();
              const parts = [];
              let received = 0;
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                parts.push(value);
                received += value.length;
                chrome.runtime.sendMessage({
                  type: MESSAGE_TYPES.FETCH_AUDIO_PROGRESS,
                  progress: Math.round(received / total * 100),
                  __reqId: message.__reqId
                });
              }
              blob = new Blob(parts, { type: res.headers.get('content-type') || 'audio/mpeg' });
            } else {
              blob = await res.blob();
            }
            chrome.runtime.sendMessage({
              type: MESSAGE_TYPES.MP3_READY,
              b64: await blobToBase64(blob),
              mimeType: res.headers.get('content-type') || 'audio/mpeg',
              __reqId: message.__reqId
            });
          } catch (e) {
            chrome.runtime.sendMessage({
              type: MESSAGE_TYPES.MP3_ERROR,
              error: e.message || String(e),
              __reqId: message.__reqId
            });
          }
          return true;
        }

        case MESSAGE_TYPES.CONVERT_TO_MP3: {
          try {
            const audioBlob = new Blob([base64ToBuffer(message.b64)]);
            const mp3Blob = await encodeToMP3(
              audioBlob,
              message.quality,
              (progress) => {
                chrome.runtime.sendMessage({
                  type: MESSAGE_TYPES.MP3_PROGRESS,
                  progress,
                  __reqId: message.__reqId
                });
              }
            );
            chrome.runtime.sendMessage({
              type: MESSAGE_TYPES.MP3_READY,
              b64: await blobToBase64(mp3Blob),
              mimeType: 'audio/mpeg',
              __reqId: message.__reqId
            });
          } catch (error) {
            chrome.runtime.sendMessage({
              type: MESSAGE_TYPES.MP3_ERROR,
              error: error.message || String(error),
              __reqId: message.__reqId
            });
          }
          return true;
        }

        default:
          return false;
      }
    } catch (e) {
      chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.MP3_ERROR,
        error: e.message || String(e),
        __reqId: message.__reqId
      }).catch(() => {});
    }
  })();
  return true;
});

console.log('Suno Advanced Downloader offscreen document loaded');
