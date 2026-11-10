const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RTL = new Set(['ar', 'he', 'fa', 'ur']);
const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}]+)*/gu;
const norm = (w) => w.toLowerCase().normalize('NFC').replace(/[֑-ׇ]/g, '');

// ---------- état ----------
let state = { songs: {}, library: [], target: 'fr', current: null };
try { Object.assign(state, JSON.parse(localStorage.getItem('ll_state') || '{}')); } catch {}
const save = () => { try { localStorage.setItem('ll_state', JSON.stringify(state)); } catch {} };
const song = () => state.songs[state.current];

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}
const setStatus = (m, err) => { const s = $('#status'); s.textContent = m; s.classList.toggle('err', !!err); };

// ---------- langues ----------
async function initLanguages() {
  const langs = await api('/api/languages');
  $('#target').innerHTML = Object.entries(langs).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  $('#target').value = state.target;
}

// ---------- import ----------
function lineKind(t) {
  if (!t.trim()) return 'gap';
  return /^\[.*\]$/.test(t.trim()) ? 'sec' : 'line';
}

async function addSong({ title, artist, url, lyrics }) {
  const lines = lyrics.split('\n').map((text) => ({ text: text.trimEnd() }));
  const id = (url || `${artist}-${title}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80) + '-' + Date.now().toString(36);
  state.songs[id] = { id, title, artist, url: url || '', lines, target: state.target, source: 'auto', goal: { size: 8, words: [] }, added: Date.now() };
  state.current = id;
  save();
  await translateSong();
}

async function translateSong() {
  const s = song(); if (!s) return;
  render();
  const idx = s.lines.map((l, i) => (lineKind(l.text) === 'line' ? i : -1)).filter((i) => i >= 0);
  setStatus('Traduction en cours…');
  try {
    const { results } = await api('/api/translate-lines', { lines: idx.map((i) => s.lines[i].text), target: state.target, source: s.source === 'auto' ? 'auto' : s.source });
    results.forEach((r, k) => { const l = s.lines[idx[k]]; l.tr = r.text; l.rm = r.translit; if (r.source && s.source === 'auto') s.source = r.source; });
    s.target = state.target;
    // retraduire les mots de l'objectif
    await translateGoal();
    setStatus(results.some((r) => r.error) ? 'Certaines lignes n’ont pas pu être traduites.' : '', results.some((r) => r.error));
  } catch (e) { setStatus(e.message, true); }
  save(); render();
}

async function translateGoal() {
  const s = song(); if (!s || !s.goal.words.length) return;
  const { results } = await api('/api/translate-lines', { lines: s.goal.words.map((w) => w.word), target: state.target, source: s.source });
  results.forEach((r, i) => { s.goal.words[i].tr = r.text; });
}

// ---------- rendu des paroles ----------
function wordsHtml(text, lineIdx) {
  const s = song();
  const goal = new Map(s.goal.words.map((g) => [norm(g.word), g]));
  const saved = new Set(state.library.map((e) => norm(e.text)));
  let out = '', last = 0;
  for (const m of text.matchAll(WORD_RE)) {
    out += esc(text.slice(last, m.index));
    const n = norm(m[0]), g = goal.get(n);
    const cls = ['w', g ? 'goal' : '', g?.done ? 'done' : '', saved.has(n) ? 'saved' : ''].filter(Boolean).join(' ');
    out += `<span class="${cls}" data-n="${esc(n)}" data-l="${lineIdx}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

function render() {
  renderSongList(); renderLibrary();
  const s = song();
  $('#empty').hidden = !!s; $('#songView').hidden = !s; $('#goalSide').hidden = !s;
  if (!s) return;
  $('#sTitle').textContent = s.title; $('#sArtist').textContent = s.artist;
  const dir = RTL.has(state.target) ? 'rtl' : 'ltr';
  $('#lyrics').className = 'lyrics' + ($('#showTr').checked ? '' : ' hide-tr');
  $('#lyrics').innerHTML = s.lines.map((l, i) => {
    const k = lineKind(l.text);
    if (k === 'gap') return '<div class="gap"></div>';
    if (k === 'sec') return `<div class="sec">${esc(l.text.replace(/^\[|\]$/g, ''))}</div>`;
    const tr = l.tr ? `<div class="tr" dir="${dir}">${esc(l.tr)}${l.rm ? ` <small>· ${esc(l.rm)}</small>` : ''}</div>` : '';
    return `<div class="ln"><div class="orig" dir="auto">${wordsHtml(l.text, i)}</div>${tr}</div>`;
  }).join('');
  renderGoal();
}

function renderGoal() {
  const s = song(); const ws = s.goal.words;
  $('#goalSize').value = s.goal.size;
  const done = ws.filter((w) => w.done).length;
  $('#bar').style.width = ws.length ? `${(done / ws.length) * 100}%` : '0';
  $('#progText').textContent = ws.length ? `${done} / ${ws.length} mots appris${done === ws.length ? ' 🎉' : ''}` : 'Aucun objectif : cliquez sur « Suggérer ».';
  $('#goalList').innerHTML = ws.map((w, i) => `<li class="${w.done ? 'done' : ''}">
    <input type="checkbox" data-i="${i}" ${w.done ? 'checked' : ''} aria-label="appris">
    <span class="g"><b dir="auto">${esc(w.word)}</b><span class="gt muted">${esc(w.tr || '…')}</span></span>
    <button data-rm="${i}" title="Retirer">✕</button></li>`).join('');
  $('#goalSide').classList.toggle('quiz', $('#quiz').checked);
}

function renderSongList() {
  const list = Object.values(state.songs).sort((a, b) => b.added - a.added);
  $('#songList').innerHTML = list.length ? list.map((s) => `<li data-id="${s.id}" class="${s.id === state.current ? 'on' : ''}">
    <span><b>${esc(s.title)}</b><small>${esc(s.artist)}</small></span><button data-del="${s.id}" title="Supprimer">✕</button></li>`).join('')
    : '<li class="muted">Aucune chanson.</li>';
}

// ---------- popover mot / expression ----------
const pop = $('#pop');
let popCtx = null;
function closePop() { pop.hidden = true; popCtx = null; }

async function openPop(text, lineIdx, rect) {
  const s = song(); const line = s.lines[lineIdx];
  popCtx = { text, lineIdx, tr: '', rm: '' };
  pop.hidden = false;
  pop.style.left = Math.max(8, Math.min(window.scrollX + rect.left, window.scrollX + innerWidth - 300)) + 'px';
  pop.style.top = window.scrollY + rect.bottom + 8 + 'px';
  const draw = () => {
    const inLib = state.library.some((e) => norm(e.text) === norm(text));
    const inGoal = s.goal.words.some((g) => norm(g.word) === norm(text));
    const single = !/\s/.test(text.trim());
    pop.innerHTML = `<div class="t" dir="auto">${esc(text)}</div>
      <div class="r">${popCtx.tr ? esc(popCtx.tr) : 'Traduction…'}${popCtx.rm ? ` <small class="muted">· ${esc(popCtx.rm)}</small>` : ''}</div>
      <div class="ctx" dir="auto">« ${esc(line.text)} »</div>
      <div class="row"><button class="primary" id="pSave" ${inLib ? 'disabled' : ''}>${inLib ? '✓ Enregistré' : '💾 Enregistrer'}</button>
      ${single ? `<button class="secondary" id="pGoal">${inGoal ? 'Retirer de l’objectif' : '🎯 Ajouter à l’objectif'}</button>` : ''}
      <button class="secondary" id="pClose">Fermer</button></div>`;
  };
  draw();
  try {
    const r = await api('/api/translate', { text, target: state.target, source: s.source });
    if (popCtx?.text !== text) return;
    popCtx.tr = r.text; popCtx.rm = r.translit; draw();
  } catch (e) { popCtx.tr = '⚠ ' + e.message; draw(); }
}

pop.addEventListener('click', async (e) => {
  const s = song(); if (!popCtx) return;
  const id = e.target.id;
  if (id === 'pClose') return closePop();
  if (id === 'pSave') {
    const l = s.lines[popCtx.lineIdx];
    state.library.unshift({ id: crypto.randomUUID(), text: popCtx.text, tr: popCtx.tr, rm: popCtx.rm, lang: state.target, sentence: l.text, sentenceTr: l.tr || '', title: s.title, artist: s.artist, url: s.url, date: Date.now() });
    save(); closePop(); render();
  }
  if (id === 'pGoal') {
    const i = s.goal.words.findIndex((g) => norm(g.word) === norm(popCtx.text));
    if (i >= 0) s.goal.words.splice(i, 1);
    else s.goal.words.push({ word: popCtx.text, tr: popCtx.tr, done: false });
    save(); closePop(); render();
  }
});

$('#lyrics').addEventListener('mouseup', (e) => {
  setTimeout(() => {
    const sel = getSelection();
    const txt = sel.toString().trim();
    if (txt && !sel.isCollapsed) {
      const a = sel.anchorNode?.parentElement?.closest('.orig'), b = sel.focusNode?.parentElement?.closest('.orig');
      if (a && a === b) {
        const w = sel.anchorNode.parentElement.closest('.w') || sel.focusNode.parentElement.closest('.w');
        const li = Number((w || a.querySelector('.w'))?.dataset.l);
        if (!Number.isNaN(li)) { const rect = sel.getRangeAt(0).getBoundingClientRect(); return openPop(txt.replace(/\s+/g, ' '), li, rect); }
      }
      return;
    }
    const w = e.target.closest?.('.w');
    if (w) openPop(w.textContent, Number(w.dataset.l), w.getBoundingClientRect());
    else if (!e.target.closest('#pop')) closePop();
  }, 0);
});
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#pop') && !e.target.closest('#lyrics')) closePop(); });

// ---------- objectif ----------
function suggestWords() {
  const s = song();
  const counts = new Map(), forms = new Map();
  for (const l of s.lines) if (lineKind(l.text) === 'line') for (const m of l.text.matchAll(WORD_RE)) {
    const n = norm(m[0]); if ([...n].length < 3 || /^\d+$/.test(n)) continue;
    counts.set(n, (counts.get(n) || 0) + 1); if (!forms.has(n)) forms.set(n, m[0]);
  }
  const known = new Set(state.library.map((e) => norm(e.text)));
  const kept = new Map(s.goal.words.map((w) => [norm(w.word), w]));
  const ranked = [...counts].filter(([n]) => !known.has(n) && !kept.has(n))
    // mots présents plusieurs fois (refrain) mais pas omniprésents, plus longs = plus riches
    .map(([n, c]) => [n, Math.min(c, 4) + [...n].length * 0.35 + Math.random() * 0.6]).sort((a, b) => b[1] - a[1]);
  const size = Number($('#goalSize').value);
  const keep = s.goal.words.filter((w) => w.done);
  const fresh = ranked.slice(0, Math.max(0, size - keep.length)).map(([n]) => ({ word: forms.get(n), tr: '', done: false }));
  s.goal = { size, words: [...keep, ...fresh] };
}

$('#suggest').onclick = async () => {
  suggestWords(); save(); render();
  try { await translateGoal(); save(); renderGoal(); } catch (e) { setStatus(e.message, true); }
};
$('#goalSize').onchange = () => { song().goal.size = Number($('#goalSize').value); save(); };
$('#quiz').onchange = renderGoal;
$('#goalList').addEventListener('click', (e) => {
  const s = song();
  if (e.target.dataset.rm !== undefined) { s.goal.words.splice(Number(e.target.dataset.rm), 1); save(); render(); }
  else if (e.target.matches('input[data-i]')) { s.goal.words[Number(e.target.dataset.i)].done = e.target.checked; save(); render(); }
  else if (e.target.classList.contains('gt')) e.target.classList.toggle('show');
});

// ---------- bibliothèque ----------
function renderLibrary() {
  $('#libCount').textContent = state.library.length;
  const q = norm($('#libSearch').value || '');
  const items = state.library.filter((e) => !q || norm(`${e.text} ${e.tr} ${e.title} ${e.artist} ${e.sentence}`).includes(q));
  $('#libEmpty').hidden = state.library.length > 0;
  $('#libList').innerHTML = items.map((e) => `<li data-id="${e.id}">
    <span class="e" dir="auto">${esc(e.text)}</span>
    <span class="m">${esc(e.tr)}<div class="s">${esc(e.title)} · ${esc(e.artist)}</div></span>
    <button data-del="${e.id}" title="Supprimer">✕</button></li>`).join('');
}
$('#libSearch').oninput = renderLibrary;
$('#libList').addEventListener('click', (e) => {
  const id = e.target.dataset.del; if (!id) return;
  state.library = state.library.filter((x) => x.id !== id); save(); hideTip(); render();
});
$('#export').onclick = () => {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = state.library.map((e) => [e.text, e.tr, e.sentence, e.sentenceTr, `${e.title} - ${e.artist}`].map(q).join(';')).join('\n');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: 'bibliotheque-mots.csv' });
  a.click(); URL.revokeObjectURL(a.href);
};

// ---------- info-bulle (source du mot) ----------
const tip = $('#tip');
function hideTip() { tip.hidden = true; }
function showTip(entry, x, y) {
  const hi = esc(entry.sentence).replace(esc(entry.text), (m) => `<mark>${m}</mark>`);
  const hl = hi.includes('<mark>') ? hi : esc(entry.sentence).replace(new RegExp(esc(entry.text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), (m) => `<mark>${m}</mark>`);
  tip.innerHTML = `<div class="src" dir="auto">« ${hl} »</div>${entry.sentenceTr ? `<div class="meta">${esc(entry.sentenceTr)}</div>` : ''}
    <div class="meta">♪ ${esc(entry.title)} — ${esc(entry.artist)}</div>`;
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(x + 14, innerWidth - w - 8) + 'px';
  tip.style.top = (y + 18 + h > innerHeight ? y - h - 12 : y + 18) + 'px';
}
document.addEventListener('mousemove', (e) => {
  const li = e.target.closest?.('.lib .e'), w = e.target.closest?.('.w.saved');
  let entry;
  if (li) entry = state.library.find((x) => x.id === li.parentElement.dataset.id);
  else if (w) entry = state.library.find((x) => norm(x.text) === w.dataset.n);
  entry ? showTip(entry, e.clientX, e.clientY) : hideTip();
});

// ---------- navigation / événements ----------
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $('#songTab').hidden = b.dataset.tab !== 'song'; $('#libraryTab').hidden = b.dataset.tab !== 'library';
  closePop(); hideTip();
});
$('#showTr').onchange = render;
$('#target').onchange = async () => {
  state.target = $('#target').value; save();
  if (song()) await translateSong();
};
$('#songList').addEventListener('click', async (e) => {
  const del = e.target.dataset.del;
  if (del) { delete state.songs[del]; if (state.current === del) state.current = null; save(); return render(); }
  const li = e.target.closest('li[data-id]'); if (!li) return;
  state.current = li.dataset.id; save(); closePop();
  if (song().target !== state.target) await translateSong(); else render();
});
$('#urlForm').onsubmit = async (e) => {
  e.preventDefault();
  setStatus('Import des paroles…');
  try {
    const s = await api('/api/lyrics?url=' + encodeURIComponent($('#url').value.trim()));
    await addSong({ ...s, url: $('#url').value.trim() });
    $('#url').value = '';
  } catch (err) { setStatus(err.message, true); $('#manual').open = true; }
};
$('#mGo').onclick = async () => {
  const lyrics = $('#mLyrics').value.trim();
  if (!lyrics) return setStatus('Collez des paroles d’abord.', true);
  await addSong({ title: $('#mTitle').value.trim() || 'Sans titre', artist: $('#mArtist').value.trim(), lyrics });
  $('#mLyrics').value = '';
};

await initLanguages();
render();
