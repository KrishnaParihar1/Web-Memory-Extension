import { saveClip, captureSelection, getClips, setClips, getSettings } from './lib.js';

const isWeb = (u) => /^(https?|file):/.test(u || '');

/* ---------- setup ---------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'save-selection',
    title: 'Save to Web Memory',
    contexts: ['selection'],
  });
  syncAlarm();
});
chrome.runtime.onStartup.addListener(syncAlarm);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) syncAlarm();
});

/* ---------- saving ---------- */

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'save-selection') return;
  tab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const text = tab && isWeb(tab.url) ? await captureSelection(tab) : '';
  await saveAndReport(tab, text);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'save-selection') saveAndReport(tab, info.selectionText);
});

async function saveAndReport(tab, text) {
  if (!tab || !isWeb(tab.url)) return toast(tab, 'Web Memory can’t save from this page', true);
  if (!text || !text.trim()) return toast(tab, 'Select some text first', true);
  const { status } = await saveClip({ text, url: tab.url, title: tab.title });
  toast(tab, status === 'duplicate' ? 'Already saved' : 'Saved to Web Memory', false);
}

async function toast(tab, message, warn) {
  if (!tab || tab.id == null) return;
  chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: warn ? '#b4443b' : '#5a6e45' });
  chrome.action.setBadgeText({ tabId: tab.id, text: warn ? '!' : '✓' });
  setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 2000);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showToast, args: [message, warn] });
  } catch {
    /* restricted page: the badge is the feedback */
  }
}

// Runs inside the page, so it must be self-contained.
function showToast(message, warn) {
  const id = '__web_memory_toast__';
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  el.textContent = message;
  Object.assign(el.style, {
    position: 'fixed', right: '20px', bottom: '20px', zIndex: 2147483647,
    padding: '10px 14px', borderRadius: '8px', font: '500 13px system-ui, sans-serif',
    color: '#fff', background: '#3b3328', borderLeft: '4px solid ' + (warn ? '#f0a39b' : '#fbd96a'),
    boxShadow: '0 6px 20px rgba(0,0,0,.25)', opacity: '0', transition: 'opacity .15s',
  });
  document.documentElement.appendChild(el);
  requestAnimationFrame(() => (el.style.opacity = '1'));
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  }, 1800);
}

/* ---------- resurfacing (opt-in, once a day) ---------- */

async function syncAlarm() {
  const { resurface } = await getSettings();
  if (!resurface) return chrome.alarms.clear('resurface');
  const existing = await chrome.alarms.get('resurface');
  if (!existing) chrome.alarms.create('resurface', { delayInMinutes: 60, periodInMinutes: 1440 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'resurface') return;
  const clips = await getClips();
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const pool = clips.filter((c) => c.savedAt < cutoff).sort((a, b) => a.lastShown - b.lastShown);
  if (!pool.length) return;
  const least = pool.filter((c) => c.lastShown === pool[0].lastShown);
  const pick = least[Math.floor(Math.random() * least.length)];
  pick.lastShown = Date.now();
  await setClips(clips);
  chrome.notifications.create('wm:' + pick.id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: pick.title.slice(0, 70),
    message: pick.text.slice(0, 200),
    contextMessage: 'Saved ' + new Date(pick.savedAt).toLocaleDateString(),
  });
});

chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith('wm:')) return;
  const clip = (await getClips()).find((c) => c.id === id.slice(3));
  if (clip) chrome.tabs.create({ url: clip.openUrl });
  chrome.notifications.clear(id);
});
