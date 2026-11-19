// content.js - Robust Tab Audio Recorder for Suno (Fixed)

let isRecording = false;
let mediaRecorder = null;
let chunks = [];
let streamRef = null;

function createFloatingButton() {
  // Remove existing button if re-running
  const existingBtn = document.getElementById('suno-rec-btn');
  if (existingBtn) return;

  const btn = document.createElement('button');
  btn.id = 'suno-rec-btn';
  btn.textContent = '🎙️ Record Song';
  
  // Fixed positioning in the bottom right corner
  btn.style.position = 'fixed';
  btn.style.bottom = '100px'; 
  btn.style.right = '20px';
  btn.style.zIndex = '999999'; // Make sure it's on top of everything
  btn.style.padding = '10px 15px';
  btn.style.background = '#ff4500'; // Orange-red
  btn.style.color = 'white';
  btn.style.border = 'none';
  btn.style.borderRadius = '8px';
  btn.style.cursor = 'pointer';
  btn.style.fontSize = '14px';
  btn.style.fontWeight = 'bold';
  btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';

  btn.addEventListener('click', toggleRecording);
  document.body.appendChild(btn);
}

async function toggleRecording() {
  const btn = document.getElementById('suno-rec-btn');
  
  if (!isRecording) {
    // Start Recording
    try {
      btn.textContent = '⏹ Stop & Save';
      btn.style.background = '#dc3545'; // Red
      
      // Get the audio stream from the current tab
      streamRef = await navigator.mediaDevices.getDisplayMedia({
        video: true, // Chrome requires video to be requested to show the tab picker
        audio: true,
      });

      // Strip the video track immediately so we only record audio
      streamRef.getVideoTracks().forEach(track => track.stop());
      const audioStream = new MediaStream(streamRef.getAudioTracks());

      if (audioStream.getAudioTracks().length === 0) {
        alert("No audio track found! Please make sure you checked 'Share tab audio' in the popup when you clicked Record.");
        resetButton();
        return;
      }

      mediaRecorder = new MediaRecorder(audioStream);
      chunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        saveFile();
        // Clean up tracks
        if (streamRef) {
          streamRef.getTracks().forEach(track => track.stop());
        }
      };

      // Handle user clicking "Stop Sharing" in Chrome's top bar
      audioStream.getAudioTracks()[0].onended = () => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
        }
      };

      mediaRecorder.start();
      isRecording = true;

    } catch (err) {
      console.error('Recording failed:', err);
      alert('Could not start recording. Please ensure you selected "This Tab" and checked "Share tab audio".');
      resetButton();
    }
  } else {
    // Stop Recording
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
    isRecording = false;
    resetButton();
  }
}

function resetButton() {
  const btn = document.getElementById('suno-rec-btn');
  if (btn) {
    btn.textContent = '🎙️ Record Song';
    btn.style.background = '#ff4500';
  }
}

function saveFile() {
  if (chunks.length === 0) {
    alert('No audio recorded. Did you forget to check "Share tab audio"?');
    return;
  }

  // Save as WebM (Chrome's native recording format)
  const blob = new Blob(chunks, { type: 'audio/webm' }); 
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = `suno-track-${Date.now()}.webm`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }, 100);
  
  alert('Download started! (Saved as .webm)');
}

// Wait for body to exist, then add button
if (document.body) {
  createFloatingButton();
} else {
  window.addEventListener('DOMContentLoaded', createFloatingButton);
}