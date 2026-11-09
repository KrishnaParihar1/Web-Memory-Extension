// Shared by the service worker and the popup. All data stays in chrome.storage.local.

export const CLIPS_KEY = 'clips';
export const SETTINGS_KEY = 'settings';

/* ---------- storage ---------- */

export async function getClips() {
  const r = await chrome.storage.local.get(CLIPS_KEY);
  return r[CLIPS_KEY] || [];
}
export const setClips = (clips) => chrome.storage.local.set({ [CLIPS_KEY]: clips });

export async function getSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return { resurface: false, ...(r[SETTINGS_KEY] || {}) };
}
export const setSettings = (s) => chrome.storage.local.set({ [SETTINGS_KEY]: s });

/* ---------- clips ---------- */

export function normalize(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Builds a link that scrolls to and highlights the saved passage when opened (Chrome text fragments).
export function withTextFragment(url, text) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const enc = (s) => encodeURIComponent(s).replace(/-/g, '%2D');
  const frag =
    words.length <= 12
      ? enc(words.join(' '))
      : enc(words.slice(0, 5).join(' ')) + ',' + enc(words.slice(-5).join(' '));
  const base = url.includes(':~:') ? url.split(':~:')[0] : url;
  return base + (base.includes('#') ? '' : '#') + ':~:text=' + frag;
}

export async function saveClip({ text, url, title }) {
  text = normalize(text);
  if (!text) return { status: 'empty' };
  const clips = await getClips();
  const dup = clips.find((c) => c.text === text && c.url === url);
  if (dup) return { status: 'duplicate', clip: dup };
  const host = new URL(url).hostname;
  const clip = {
    id: crypto.randomUUID(),
    text,
    url,
    openUrl: withTextFragment(url, text),
    title: title || host,
    domain: host.replace(/^www\./, ''),
    savedAt: Date.now(),
    note: '',
    tags: [],
    lastShown: 0,
  };
  clips.unshift(clip);
  await setClips(clips);
  return { status: 'saved', clip };
}

export async function updateClip(id, patch) {
  const clips = await getClips();
  const i = clips.findIndex((c) => c.id === id);
  if (i < 0) return;
  clips[i] = { ...clips[i], ...patch };
  await setClips(clips);
}

export async function deleteClip(id) {
  await setClips((await getClips()).filter((c) => c.id !== id));
}

// Reads the current selection from a tab (all frames if permitted, else top frame only).
export async function captureSelection(tab) {
  const run = (allFrames) =>
    chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames },
      func: () => String(window.getSelection()),
    });
  let res;
  try {
    res = await run(true);
  } catch {
    try {
      res = await run(false);
    } catch {
      return '';
    }
  }
  return res.map((r) => r.result).find((t) => t && t.trim()) || '';
}

/* ---------- search (plain keyword matching, no AI) ---------- */

export const tokenize = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);

// "pods" also matches "pod", "running" matches "run" — a cheap stand-in for stemming.
export function variants(t) {
  const stem = t.length > 4 ? t.replace(/(ing|ed|es|s)$/, '') : t;
  return stem.length >= 3 && stem !== t ? [t, stem] : [t];
}

const WEIGHTS = { tags: 4, note: 3, title: 3, text: 2, url: 1 };

export function search(clips, query, tag = '') {
  const list = tag ? clips.filter((c) => c.tags.includes(tag)) : clips;
  const tokens = tokenize(query);
  if (!tokens.length) return list.map((clip) => ({ clip, score: 0 }));

  const out = [];
  for (const clip of list) {
    const fields = {
      tags: clip.tags.join(' ').toLowerCase(),
      note: (clip.note || '').toLowerCase(),
      title: clip.title.toLowerCase(),
      text: clip.text.toLowerCase(),
      url: clip.url.toLowerCase(),
    };
    let score = 0;
    let matchedAll = true;
    for (const t of tokens) {
      const vs = variants(t);
      let s = 0;
      for (const [name, weight] of Object.entries(WEIGHTS)) {
        if (vs.some((v) => fields[name].includes(v))) s += weight;
      }
      if (!s) {
        matchedAll = false;
        break;
      }
      score += s;
    }
    if (matchedAll) out.push({ clip, score });
  }
  out.sort((a, b) => b.score - a.score || b.clip.savedAt - a.clip.savedAt);
  return out;
}

/* ---------- highlight saved passages on the live page ---------- */

// Injected into the page with chrome.scripting.executeScript, so it must stay self-contained.
// Matches ignoring all whitespace, so line breaks and inline tags don't matter.
export function paintHighlights(passages, clear) {
  const NAME = 'web-memory';
  if (clear) {
    if (window.CSS && CSS.highlights) CSS.highlights.delete(NAME);
    return { found: 0, total: 0 };
  }
  const isSpace = (c) => c <= 32 || c === 160 || (c >= 0x2000 && c <= 0x200b) || c === 0x3000 || c === 0xfeff;
  const strip = (s) => {
    let out = '';
    for (let i = 0; i < s.length; i++) if (!isSpace(s.charCodeAt(i))) out += s[i];
    return out;
  };

  const nodes = [];
  const nodeOf = [];
  const offOf = [];
  const chars = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test((n.parentElement && n.parentElement.tagName) || '')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = n.nodeValue;
    const ni = nodes.push(n) - 1;
    for (let i = 0; i < v.length; i++) {
      if (isSpace(v.charCodeAt(i))) continue;
      chars.push(v[i]);
      nodeOf.push(ni);
      offOf.push(i);
    }
    if (chars.length > 3e6) break;
  }
  const flat = chars.join('');

  const ranges = [];
  for (const p of passages) {
    const needle = strip(p);
    if (!needle) continue;
    const s = flat.indexOf(needle);
    if (s < 0) continue;
    const e = s + needle.length - 1;
    const r = document.createRange();
    r.setStart(nodes[nodeOf[s]], offOf[s]);
    r.setEnd(nodes[nodeOf[e]], offOf[e] + 1);
    ranges.push(r);
  }

  if (ranges.length) {
    if (window.CSS && CSS.highlights && typeof Highlight !== 'undefined') {
      let st = document.getElementById('__web_memory_style__');
      if (!st) {
        st = document.createElement('style');
        st.id = '__web_memory_style__';
        st.textContent = '::highlight(' + NAME + '){background-color:#fbd96a;color:#3b3328;}';
        (document.head || document.documentElement).appendChild(st);
      }
      CSS.highlights.set(NAME, new Highlight(...ranges));
    } else {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(ranges[0]);
    }
    const el = ranges[0].startContainer.parentElement;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  return { found: ranges.length, total: passages.length };
}
