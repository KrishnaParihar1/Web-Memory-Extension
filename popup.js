import {
  getClips, setClips, getSettings, setSettings,
  saveClip, captureSelection, updateClip, deleteClip,
  search, tokenize, variants, paintHighlights,
} from './lib.js';

const $ = (s) => document.querySelector(s);
const state = {
  clips: [], query: '', tag: '', shortcut: '', tab: null, painted: false,
  expanded: new Set(), editing: new Set(),
};
const LIMIT = 100;

/* ---------- helpers ---------- */

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

function highlighted(text, tokens) {
  const terms = [...new Set(tokens.flatMap(variants))];
  if (!terms.length) return [text];
  const re = new RegExp('(' + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  return text.split(re).map((part, i) => (i % 2 ? h('mark', {}, part) : part));
}

function snippet(text, tokens, max = 320) {
  if (text.length <= max) return text;
  const low = text.toLowerCase();
  const first = tokens.flatMap(variants).map((t) => low.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const start = Math.max(0, (first ?? 0) - 80);
  return (start ? '…' : '') + text.slice(start, start + max) + (start + max < text.length ? '…' : '');
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

function fmtWhen(ms) {
  if (ms >= startOfToday()) return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameYear = new Date(ms).getFullYear() === new Date().getFullYear();
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function groupByAge(clips) {
  const today = startOfToday();
  const week = today - 6 * 864e5;
  const groups = { Today: [], 'This week': [], Earlier: [] };
  for (const c of clips) groups[c.savedAt >= today ? 'Today' : c.savedAt >= week ? 'This week' : 'Earlier'].push(c);
  return Object.entries(groups).filter(([, list]) => list.length);
}

const parseTags = (s) => [...new Set(s.split(',').map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];
const pageKey = (u) => (u || '').split('#')[0];
const isHere = (c) => !!state.tab && pageKey(c.url) === pageKey(state.tab.url);
const byId = (id) => state.clips.find((c) => c.id === id);

let statusTimer;
function flash(msg) {
  $('#status').textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($('#status').textContent = ''), 2400);
}

/* ---------- highlight on the live page ---------- */

async function paint(list, clear = false) {
  if (!state.tab) return flash('Can’t highlight on this page');
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: state.tab.id },
      func: paintHighlights,
      args: [list.map((c) => c.text), clear],
    });
    const { found, total } = res.result;
    if (clear) {
      state.painted = false;
      flash('Highlights cleared');
    } else if (!found) {
      flash('Couldn’t find it on the page. The text may have changed.');
    } else {
      state.painted = true;
      flash(found === total ? `Highlighted ${found} on this page` : `Found ${found} of ${total} on this page`);
    }
  } catch {
    flash('Can’t highlight on this page');
  }
  render();
}

/* ---------- rendering ---------- */

function refreshEntry(id) {
  const old = document.querySelector(`[data-id="${id}"]`);
  const clip = byId(id);
  if (old && clip) old.replaceWith(renderEntry(clip, tokenize(state.query)));
}

function renderEntry(clip, tokens) {
  const long = clip.text.length > 320;
  const open = state.expanded.has(clip.id);
  const shown = open || !long ? clip.text : snippet(clip.text, tokens);

  const quote = h('blockquote', {
    class: long ? 'long' : '',
    title: long ? (open ? 'Click to collapse' : 'Click to expand') : null,
    onclick: long ? () => { open ? state.expanded.delete(clip.id) : state.expanded.add(clip.id); refreshEntry(clip.id); } : null,
  }, ...highlighted(shown, tokens));

  const meta = h('div', { class: 'meta' },
    h('a', { href: clip.openUrl, target: '_blank', rel: 'noopener', title: clip.url }, ...highlighted(clip.title, tokens)),
    h('span', { class: 'domain' }, clip.domain),
    h('time', { datetime: new Date(clip.savedAt).toISOString() }, fmtWhen(clip.savedAt)),
  );

  const entry = h('article', { class: 'entry' + (isHere(clip) ? ' here' : ''), 'data-id': clip.id }, quote, meta);

  if (state.editing.has(clip.id)) {
    const note = h('textarea', { placeholder: 'Why did you save this?', value: clip.note || '' });
    const tags = h('input', { type: 'text', placeholder: 'Tags, separated by commas', value: clip.tags.join(', ') });
    entry.append(h('div', { class: 'editor' }, note, tags, h('div', { class: 'row' },
      h('button', { onclick: () => { state.editing.delete(clip.id); refreshEntry(clip.id); } }, 'Cancel'),
      h('button', {
        class: 'primary',
        onclick: async () => {
          await updateClip(clip.id, { note: note.value.trim(), tags: parseTags(tags.value) });
          state.editing.delete(clip.id);
          await load();
        },
      }, 'Save changes'),
    )));
    setTimeout(() => note.focus());
    return entry;
  }

  if (clip.note) entry.append(h('p', { class: 'note' }, ...highlighted(clip.note, tokens)));
  if (clip.tags.length) {
    entry.append(h('div', { class: 'tagrow' }, clip.tags.map((t) =>
      h('button', { class: 'tag', title: `Show only #${t}`, onclick: () => { state.tag = t; render(); } }, '#' + t))));
  }

  let armed = false;
  const del = h('button', {
    class: 'danger',
    onclick: async () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Delete this clip?';
        setTimeout(() => { armed = false; del.textContent = 'Delete'; }, 3000);
        return;
      }
      await deleteClip(clip.id);
      await load();
    },
  }, 'Delete');

  entry.append(h('div', { class: 'actions' },
    isHere(clip) && h('button', { onclick: () => paint([clip]) }, 'Show on page'),
    h('button', { onclick: () => { state.editing.add(clip.id); refreshEntry(clip.id); } }, clip.note || clip.tags.length ? 'Edit note and tags' : 'Add note or tags'),
    h('button', { onclick: async () => { await navigator.clipboard.writeText(clip.text); flash('Copied'); } }, 'Copy'),
    del,
  ));
  return entry;
}

function renderTagBar() {
  const counts = new Map();
  state.clips.forEach((c) => c.tags.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
  if (state.tag && !counts.has(state.tag)) state.tag = '';
  const chips = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  $('#tags').replaceChildren(...chips.map(([t, n]) =>
    h('button', {
      class: 'chip',
      'aria-pressed': String(state.tag === t),
      onclick: () => { state.tag = state.tag === t ? '' : t; render(); },
    }, `#${t} ${n}`)));
}

function render() {
  const list = $('#list');
  const y = list.scrollTop;
  const tokens = tokenize(state.query);
  const searching = tokens.length > 0 || !!state.tag;
  renderTagBar();

  const nodes = [];
  let budget = LIMIT;
  let total = state.clips.length;

  if (!state.clips.length) {
    nodes.push(h('div', { class: 'empty' },
      'Nothing saved yet.', h('br'),
      'Select text on any page, then right-click and choose Save to Web Memory',
      state.shortcut ? [' or press ', h('kbd', {}, state.shortcut)] : '', '.'));
  } else if (searching) {
    const results = search(state.clips, state.query, state.tag);
    total = results.length;
    if (!results.length) {
      nodes.push(h('div', { class: 'empty' }, 'Nothing matches. Try fewer or different words.'));
    } else {
      nodes.push(h('h2', { class: 'group' }, `${results.length} ${results.length === 1 ? 'match' : 'matches'}`));
      results.slice(0, budget).forEach((r) => nodes.push(renderEntry(r.clip, tokens)));
    }
  } else {
    const here = state.clips.filter(isHere);
    if (here.length) {
      nodes.push(h('section', { class: 'here-box' },
        h('div', { class: 'here-head' },
          h('h2', { class: 'group' }, 'On this page', h('span', { class: 'badge' }, String(here.length))),
          h('button', { class: 'link', onclick: () => (state.painted ? paint(here, true) : paint(here)) },
            state.painted ? 'Clear highlights' : 'Highlight on page')),
        ...here.map((c) => renderEntry(c, []))));
    }
    for (const [name, items] of groupByAge(state.clips.filter((c) => !isHere(c)))) {
      if (budget <= 0) break;
      nodes.push(h('h2', { class: 'group' }, name));
      items.slice(0, budget).forEach((c) => nodes.push(renderEntry(c, [])));
      budget -= items.length;
    }
  }

  list.replaceChildren(...nodes);
  list.scrollTop = y;
  $('#count').textContent = searching ? `${total} of ${state.clips.length}` : `${state.clips.length} saved`;
}

async function load() {
  state.clips = await getClips();
  render();
}

/* ---------- actions ---------- */

$('#q').addEventListener('input', (e) => { state.query = e.target.value; render(); });

$('#save').addEventListener('click', async () => {
  if (!state.tab) return flash('Can’t save from this page');
  const text = await captureSelection(state.tab);
  if (!text.trim()) return flash('Select some text on the page first');
  const { status } = await saveClip({ text, url: state.tab.url, title: state.tab.title });
  flash(status === 'duplicate' ? 'Already saved' : 'Saved');
  await load();
});

$('#export').addEventListener('click', async () => {
  const blob = new Blob([JSON.stringify(await getClips(), null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `web-memory-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#import').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    if (!Array.isArray(incoming)) throw new Error('not a list');
    const clips = await getClips();
    const seen = new Set(clips.map((c) => c.id));
    let added = 0;
    for (const c of incoming) {
      if (!c || typeof c.text !== 'string' || typeof c.url !== 'string' || !c.id || seen.has(c.id)) continue;
      clips.push({ note: '', tags: [], lastShown: 0, title: c.url, domain: '', openUrl: c.url, savedAt: Date.now(), ...c });
      added++;
    }
    clips.sort((a, b) => b.savedAt - a.savedAt);
    await setClips(clips);
    flash(`Imported ${added} clip${added === 1 ? '' : 's'}`);
    await load();
  } catch {
    flash('That file isn’t a Web Memory export');
  }
});

$('#resurface').addEventListener('change', async (e) => {
  await setSettings({ ...(await getSettings()), resurface: e.target.checked });
  flash(e.target.checked ? 'You’ll get one old clip a day' : 'Resurfacing is off');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.clips && !state.editing.size) load();
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab && /^(https?|file):/.test(tab.url || '') ? tab : null;
  $('#resurface').checked = (await getSettings()).resurface;
  const cmds = await chrome.commands.getAll();
  state.shortcut = (cmds.find((c) => c.name === 'save-selection') || {}).shortcut || '';
  await load();
})();
