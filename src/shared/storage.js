// Shared storage utilities

import { STORAGE_KEYS, DEFAULT_SETTINGS } from './constants.js';

export async function getFromStorage(key, defaultValue = null) {
  try {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? defaultValue;
  } catch (error) {
    console.error(`Storage get failed for ${key}:`, error);
    return defaultValue;
  }
}

export async function setInStorage(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
    return true;
  } catch (error) {
    console.error(`Storage set failed for ${key}:`, error);
    return false;
  }
}

export async function getQueue() {
  return getFromStorage(STORAGE_KEYS.QUEUE, []);
}

export async function saveQueue(queue) {
  return setInStorage(STORAGE_KEYS.QUEUE, queue);
}

export async function getHistory() {
  return getFromStorage(STORAGE_KEYS.HISTORY, []);
}

export async function saveHistory(history) {
  const settings = await getSettings();
  const maxItems = settings.maxHistoryItems || 100;
  const trimmed = history.slice(0, maxItems); // newest first
  return setInStorage(STORAGE_KEYS.HISTORY, trimmed);
}

export async function getSettings() {
  const saved = await getFromStorage(STORAGE_KEYS.SETTINGS, {});
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(settings) {
  return setInStorage(STORAGE_KEYS.SETTINGS, settings);
}