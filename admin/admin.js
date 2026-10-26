(() => {
'use strict';

/* ---------------------------------------------------------------- helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16)).replace(/-/g, '').slice(0, 10);
const slug = s => (s || 'item').toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
const fmtDur = s => s ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') : '';
const fromB64 = b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, '')), c => c.charCodeAt(0)));
const toB64 = str => { const b = new TextEncoder().encode(str); let s = ''; b.forEach(x => (s += String.fromCharCode(x))); return btoa(s); };
const fileB64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
const audioDuration = src => new Promise(res => {
  const a = new Audio(); a.preload = 'metadata';
  a.onloadedmetadata = () => res(isFinite(a.duration) ? Math.round(a.duration) : 0);
  a.onerror = () => res(0);
  a.src = src;
});

/* ------------------------------------------------------------- GitHub API */
const API = 'https://api.github.com';
const cfg = JSON.parse(localStorage.getItem('tc-cfg') || '{}');
cfg.owner ||= 'dewexdewex'; cfg.repo ||= 'townsandcities'; cfg.branch ||= 'main';
cfg.token = sessionStorage.getItem('tc-token') || '';

async function gh(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + cfg.token, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) }
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const e = new Error(j.message || r.statusText); e.status = r.status; throw e;
  }
  return r.status === 204 ? null : r.json();
}
const cpath = p => `/repos/${cfg.owner}/${cfg.repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;

async function readManifest(path, key) {
  try {
    const j = await gh(`${cpath(path)}?ref=${encodeURIComponent(cfg.branch)}&t=${Date.now()}`);
    let text = j.content ? fromB64(j.content) : '';
    if (!text) { const b = await gh(`/repos/${cfg.owner}/${cfg.repo}/git/blobs/${j.sha}`); text = fromB64(b.content); }
    const data = JSON.parse(text);
    if (!Array.isArray(data[key])) data[key] = [];
    return { data, sha: j.sha };
  } catch (e) {
    if (e.status === 404) return { data: { [key]: [] }, sha: null };
    throw e;
  }
}

// Read-modify-write with retry on conflicts. fn receives and returns the list.
async function updateManifest(path, key, fn, message) {
  for (let i = 0; i < 3; i++) {
    const { data, sha } = await readManifest(path, key);
    data[key] = fn(data[key]);
    try {
      await gh(cpath(path), {
        method: 'PUT',
        body: JSON.stringify({ message, content: toB64(JSON.stringify(data, null, 2) + '\n'), branch: cfg.branch, ...(sha ? { sha } : {}) })
      });
      return data[key];
    } catch (e) { if ((e.status !== 409 && e.status !== 422) || i === 2) throw e; }
  }
}
async function putFile(path, file, message) {
  await gh(cpath(path), { method: 'PUT', body: JSON.stringify({ message, content: await fileB64(file), branch: cfg.branch }) });
}
async function deleteFile(path, message) {
  try {
    const j = await gh(`${cpath(path)}?ref=${encodeURIComponent(cfg.branch)}`);
    await gh(cpath(path), { method: 'DELETE', body: JSON.stringify({ message, sha: j.sha, branch: cfg.branch }) });
  } catch (e) { if (e.status !== 404) throw e; }
}

/* ------------------------------------------------------------------- auth */
const login = $('#login'), app = $('#app');
$('#cfgOwner').value = cfg.owner; $('#cfgRepo').value = cfg.repo; $('#cfgBranch').value = cfg.branch;

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  cfg.owner = $('#cfgOwner').value.trim(); cfg.repo = $('#cfgRepo').value.trim(); cfg.branch = $('#cfgBranch').value.trim();
  cfg.token = $('#cfgToken').value.trim();
  try { await enter(); } catch (err) { cfg.token = ''; $('#loginErr').textContent = err.message; }
});
async function enter() {
  const repo = await gh(`/repos/${cfg.owner}/${cfg.repo}`);
  if (!repo.permissions || !repo.permissions.push) throw new Error('This token cannot write to the repository. Give it Contents: Read and write.');
  const me = await gh('/user').catch(() => ({ login: '' }));
  sessionStorage.setItem('tc-token', cfg.token);
  localStorage.setItem('tc-cfg', JSON.stringify({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch }));
  $('#who').textContent = (me.login ? me.login + ' · ' : '') + cfg.owner + '/' + cfg.repo;
  login.hidden = true; app.hidden = false;
  $('#cfgToken').value = '';
  openTab('stories');
}
$('#signOut').onclick = () => { sessionStorage.removeItem('tc-token'); cfg.token = ''; location.reload(); };

/* ----------------------------------------------------------------- status */
let busy = 0;
function setBusy(msg) { busy++; $('#status').textContent = msg; }
function clearBusy() { if (--busy <= 0) { busy = 0; $('#status').textContent = ''; } }
async function work(msg, fn) { setBusy(msg); try { return await fn(); } finally { clearBusy(); } }
function toast(msg, undoFn, ms = 10000, onExpire) {
  const t = document.createElement('div'); t.className = 'toast';
  t.innerHTML = `<span>${esc(msg)}</span>`;
  let done = false;
  const finish = ran => { if (done) return; done = true; clearTimeout(timer); t.remove(); if (ran) onExpire && onExpire(); };
  if (undoFn) { const b = document.createElement('button'); b.textContent = 'Undo'; b.onclick = () => { undoFn(); finish(false); }; t.appendChild(b); }
  const timer = setTimeout(() => finish(true), ms);
  $('#toasts').appendChild(t);
}

/* --------------------------------------------------------------- entities */
const ENT = {
  stories: {
    file: 'data/stories.json', key: 'stories', dir: 'audio/stories', one: 'story', many: 'stories', hasFile: true,
    cols: [{ k: 'title', h: 'Title', sort: true }, { k: 'author', h: 'Author' }, { k: 'duration', h: 'Length', fmt: fmtDur }, { k: 'added', h: 'Date added', sort: true, fmt: fmtDate }],
    sortKey: 'title', search: ['title', 'author', 'transcript']
  },
  tracks: {
    file: 'data/tracks.json', key: 'tracks', dir: 'audio/music', one: 'track', many: 'tracks', hasFile: true,
    cols: [{ k: 'title', h: 'Title', sort: true }, { k: 'author', h: 'Author' }, { k: 'copyright', h: 'Copyright', fmt: fmtDate }, { k: 'added', h: 'Date added', sort: true, fmt: fmtDate }],
    sortKey: 'title', search: ['title', 'author']
  },
  videos: {
    file: 'data/videos.json', key: 'videos', one: 'UID', many: 'UIDs',
    cols: [{ k: 'id', h: 'UID', sort: true, cls: 'mono' }, { k: 'title', h: 'Video title' }, { k: 'channel', h: 'Channel' }, { k: 'added', h: 'Date added', sort: true, fmt: fmtDate }],
    sortKey: 'id', search: ['id', 'title', 'channel']
  }
};
for (const [name, E] of Object.entries(ENT)) Object.assign(E, { name, items: [], loaded: false, query: '', dir1: 1, selected: new Set(), pending: new Set() });

function buildPane(E) {
  const pane = $('#pane-' + E.name);
  pane.innerHTML = `
    <div class="toolbar">
      <input type="search" class="q" placeholder="Search ${E.many}…" aria-label="Search ${E.many}">
      <button class="do-search">Search</button><button class="do-clear">Clear</button>
      <span class="spacer"></span>
      ${E.hasFile ? '<button class="do-import" title="Register audio files already in the repository">Import existing files</button>' : ''}
      <button class="do-add primary">${E.name === 'videos' ? 'Add CSV of UIDs' : 'Add ' + E.one}</button>
      <button class="do-del danger" disabled>Delete selected</button>
    </div>
    <div class="tablewrap"><table></table></div>`;
  const q = $('.q', pane);
  const run = () => { E.query = q.value.trim().toLowerCase(); render(E); };
  $('.do-search', pane).onclick = run;
  q.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  $('.do-clear', pane).onclick = () => { q.value = ''; run(); };
  $('.do-add', pane).onclick = () => (E.name === 'videos' ? openCsv() : openItem(E));
  $('.do-del', pane).onclick = () => askDelete(E, [...E.selected]);
  const imp = $('.do-import', pane); if (imp) imp.onclick = () => importExisting(E);
  E.built = true;
}

function visible(E) {
  let list = E.items.filter(i => !E.pending.has(i.id));
  if (E.query) list = list.filter(i => E.search.some(f => String(i[f] ?? '').toLowerCase().includes(E.query)));
  const k = E.sortKey;
  return list.sort((a, b) => {
    const x = a[k] ?? '', y = b[k] ?? '';
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { sensitivity: 'base' })) * E.dir1;
  });
}

function render(E) {
  const pane = $('#pane-' + E.name), table = $('table', pane);
  const list = visible(E);
  for (const id of [...E.selected]) if (!list.some(i => i.id === id)) E.selected.delete(id);
  const allOn = list.length && list.every(i => E.selected.has(i.id));
  const arrow = k => (E.sortKey === k ? (E.dir1 > 0 ? ' ▲' : ' ▼') : '');
  table.innerHTML = `<thead><tr>
      <th class="cb"><input type="checkbox" class="all" aria-label="Select all" ${allOn ? 'checked' : ''}></th>
      ${E.cols.map(c => `<th ${c.sort ? `class="sort" data-k="${c.k}"` : ''}>${esc(c.h)}${c.sort ? arrow(c.k) : ''}</th>`).join('')}
      ${E.name === 'videos' ? '' : '<th></th>'}
    </tr></thead><tbody>${
      list.map(i => `<tr data-id="${esc(i.id)}">
        <td class="cb"><input type="checkbox" class="sel" ${E.selected.has(i.id) ? 'checked' : ''} aria-label="Select"></td>
        ${E.cols.map(c => `<td class="${c.cls || ''}">${esc(c.fmt ? c.fmt(i[c.k]) : i[c.k])}</td>`).join('')}
        ${E.name === 'videos' ? '' : '<td><button class="edit">Edit</button></td>'}
      </tr>`).join('') || `<tr><td colspan="9" class="empty">${E.loaded ? 'Nothing to show.' : 'Loading…'}</td></tr>`
    }</tbody>`;
  $('.do-del', pane).disabled = !E.selected.size;
  $('.do-del', pane).textContent = E.selected.size ? `Delete selected (${E.selected.size})` : 'Delete selected';
}

function wireTable(E) {
  const pane = $('#pane-' + E.name);
  pane.addEventListener('click', e => {
    const th = e.target.closest('th.sort');
    if (th) { const k = th.dataset.k; E.dir1 = E.sortKey === k ? -E.dir1 : 1; E.sortKey = k; return render(E); }
    if (e.target.classList.contains('all')) {
      const list = visible(E);
      if (e.target.checked) list.forEach(i => E.selected.add(i.id)); else E.selected.clear();
      return render(E);
    }
    if (e.target.classList.contains('sel')) {
      const id = e.target.closest('tr').dataset.id;
      e.target.checked ? E.selected.add(id) : E.selected.delete(id);
      return render(E);
    }
    if (e.target.classList.contains('edit')) {
      const item = E.items.find(i => i.id === e.target.closest('tr').dataset.id);
      if (item) openItem(E, item);
    }
  });
}

async function load(E) {
  if (!E.built) { buildPane(E); wireTable(E); }
  render(E);
  await work('Loading ' + E.many + '…', async () => {
    E.items = (await readManifest(E.file, E.key)).data[E.key];
    E.loaded = true;
  }).catch(err => alert('Could not load ' + E.many + ': ' + err.message));
  render(E);
}
function openTab(name) {
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.pane').forEach(p => (p.hidden = p.id !== 'pane-' + name));
  load(ENT[name]);
}
$$('#tabs button').forEach(b => (b.onclick = () => openTab(b.dataset.tab)));

/* --------------------------------------------------------- add / edit item */
const dlg = $('#dlgItem'), form = $('#itemForm');
let editing = null, editEnt = null;

function openItem(E, item) {
  editEnt = E; editing = item || null;
  form.reset();
  $('#itemTitle').textContent = (item ? 'Edit ' : 'Add ') + E.one;
  $$('[data-only]', form).forEach(el => {
    const o = el.dataset.only;
    el.hidden = (o === 'stories' && E.name !== 'stories') || (o === 'add' && !!item);
  });
  $('[name=file]', form).required = !item;
  if (item) {
    const el = form.elements;
    el.title.value = item.title || ''; el.author.value = item.author || '';
    el.copyright.value = item.copyright || ''; if (E.name === 'stories') el.transcript.value = item.transcript || '';
  }
  $('#itemErr').textContent = '';
  dlg.showModal();
}
$('#itemCancel').onclick = () => dlg.close();

form.addEventListener('submit', async e => {
  e.preventDefault();
  const E = editEnt, f = form.elements;
  const vals = { title: f.title.value.trim(), author: f.author.value.trim(), copyright: f.copyright.value };
  if (E.name === 'stories') vals.transcript = f.transcript.value.trim();
  const file = f.file.files[0];
  const err = $('#itemErr'); err.textContent = '';
  try {
    if (!editing && !file) throw new Error('Choose an audio file.');
    if (file && file.size > 95 * 1024 * 1024) throw new Error('File is over GitHub’s 100 MB limit.');
    await work('Saving…', async () => {
      if (editing) {
        const id = editing.id;
        E.items = await updateManifest(E.file, E.key, list => list.map(i => (i.id === id ? { ...i, ...vals } : i)), `Edit ${E.one}: ${vals.title}`);
      } else {
        const id = uid();
        const ext = (file.name.match(/\.[A-Za-z0-9]+$/) || ['.mp3'])[0].toLowerCase();
        const path = `${E.dir}/${slug(vals.title)}-${id}${ext}`;
        const rec = { id, ...vals, file: path, added: new Date().toISOString() };
        if (E.name === 'stories') { const u = URL.createObjectURL(file); rec.duration = await audioDuration(u); URL.revokeObjectURL(u); }
        await putFile(path, file, `Add ${E.one} audio: ${vals.title}`);
        try { E.items = await updateManifest(E.file, E.key, list => [...list, rec], `Add ${E.one}: ${vals.title}`); }
        catch (me) { await deleteFile(path, 'Roll back orphaned upload').catch(() => {}); throw me; }
      }
    });
    dlg.close(); render(E);
  } catch (ex) { err.textContent = ex.message; }
});

/* --------------------------------------------------------- import existing */
async function importExisting(E) {
  const folder = prompt(`Folder in the repository to scan for audio files:`, E.dir);
  if (!folder) return;
  try {
    await work('Scanning…', async () => {
      const listing = await gh(`${cpath(folder.replace(/\/+$/, ''))}?ref=${encodeURIComponent(cfg.branch)}`);
      const known = new Set(E.items.map(i => i.file));
      const files = (Array.isArray(listing) ? listing : []).filter(x => x.type === 'file' && /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(x.name) && !known.has(x.path));
      if (!files.length) { alert('No new audio files found in ' + folder); return; }
      const now = new Date().toISOString(), recs = [];
      for (const x of files) {
        const rec = { id: uid(), title: x.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim(), author: '', copyright: '', file: x.path, added: now };
        if (E.name === 'stories') { rec.transcript = ''; rec.duration = await audioDuration('../' + x.path); }
        recs.push(rec);
      }
      E.items = await updateManifest(E.file, E.key, list => [...list, ...recs], `Import ${recs.length} existing ${E.many}`);
      alert(`Imported ${recs.length} file(s). Use Edit to add author, copyright date${E.name === 'stories' ? ' and transcript' : ''}.`);
    });
  } catch (e) { alert('Import failed: ' + e.message); }
  render(E);
}

/* ------------------------------------------------------------------ delete */
const dlgC = $('#dlgConfirm');
function askDelete(E, ids) {
  if (!ids.length) return;
  $('#confirmMsg').textContent = `Delete ${ids.length} ${ids.length === 1 ? E.one : E.many}?` + (E.hasFile ? ' The audio file is removed too.' : '');
  dlgC.returnValue = '';
  dlgC.onclose = () => { if (dlgC.returnValue === 'ok') doDelete(E, ids); };
  dlgC.showModal();
}
function doDelete(E, ids) {
  const items = E.items.filter(i => ids.includes(i.id));
  ids.forEach(id => { E.pending.add(id); E.selected.delete(id); });
  render(E);
  toast(`Deleted ${items.length} ${items.length === 1 ? E.one : E.many}.`,
    () => { ids.forEach(id => E.pending.delete(id)); render(E); },
    10000,
    async () => {
      try {
        await work('Committing delete…', async () => {
          E.items = await updateManifest(E.file, E.key, list => list.filter(i => !ids.includes(i.id)), `Delete ${items.length} ${E.many}`);
          if (E.hasFile) for (const i of items) if (i.file) await deleteFile(i.file, `Delete audio: ${i.title}`);
        });
      } catch (e) { alert('Delete failed, items restored: ' + e.message); }
      ids.forEach(id => E.pending.delete(id));
      render(E);
    });
}

/* --------------------------------------------------------------- CSV of UIDs */
const dlgCsv = $('#dlgCsv');
function openCsv() { $('#csvForm').reset(); $('#csvErr').textContent = ''; dlgCsv.showModal(); }
$('#csvCancel').onclick = () => dlgCsv.close();

function extractIds(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/g)) out.add(m[1]);
  for (const tok of text.split(/[\s,;"'|]+/)) if (/^[A-Za-z0-9_-]{11}$/.test(tok) && !tok.includes('/')) out.add(tok);
  return [...out];
}
async function lookup(id) { // oEmbed is CORS-enabled; 401/404 = not embeddable / not found
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`);
    if (r.status === 401 || r.status === 404 || r.status === 403) return { bad: true };
    if (!r.ok) return {};
    const j = await r.json();
    return { title: j.title || '', channel: j.author_name || '' };
  } catch { return {}; }
}
$('#csvForm').addEventListener('submit', async e => {
  e.preventDefault();
  const E = ENT.videos, err = $('#csvErr'); err.textContent = '';
  try {
    let text = $('#csvText').value;
    const f = $('#csvFile').files[0];
    if (f) text += '\n' + (await f.text());
    const have = new Set(E.items.map(i => i.id));
    const ids = extractIds(text).filter(id => !have.has(id));
    if (!ids.length) throw new Error('No new 11-character video IDs found.');
    const doLookup = $('#csvLookup').checked;
    let skippedBad = 0, recs = [];
    await work(`Adding ${ids.length} UID(s)…`, async () => {
      const now = new Date().toISOString();
      const res = new Map();
      if (doLookup) {
        let n = 0, done = 0;
        const worker = async () => { while (n < ids.length) { const id = ids[n++]; res.set(id, await lookup(id)); $('#status').textContent = `Checking videos… ${++done}/${ids.length}`; } };
        await Promise.all(Array.from({ length: 6 }, worker));
      }
      for (const id of ids) {
        const r = res.get(id) || {};
        if (r.bad) { skippedBad++; continue; }
        recs.push({ id, title: r.title || '', channel: r.channel || '', added: now });
      }
      if (!recs.length) return;
      E.items = await updateManifest(E.file, E.key, list => {
        const s = new Set(list.map(i => i.id));
        return [...list, ...recs.filter(r => !s.has(r.id))];
      }, `Add ${recs.length} video UIDs`);
    });
    dlgCsv.close(); render(E);
    toast(`Added ${recs.length} UID(s)` + (skippedBad ? `; skipped ${skippedBad} not found or not embeddable.` : '.'), null, 6000);
  } catch (ex) { err.textContent = ex.message; }
});

/* ------------------------------------------------------------------- start */
if (cfg.token) enter().catch(() => { sessionStorage.removeItem('tc-token'); cfg.token = ''; });
})();
