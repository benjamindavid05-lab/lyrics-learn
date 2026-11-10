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
  $('#hits').innerHTML = ''; $('#q').value = ''; setStatus('');
  $('#addCard').open = false;
  translateSong(); // en arrière-plan : la chanson s'affiche tout de suite
}

let geminiOn = false;

async function translateSong() {
  const s = song(); if (!s) return;
  const idx = s.lines.map((l, i) => (lineKind(l.text) === 'line' ? i : -1)).filter((i) => i >= 0);
  const all = idx.map((i) => s.lines[i].text);
  const CHUNK = 30, chunks = [];
  for (let i = 0; i < idx.length; i += CHUNK) chunks.push(idx.slice(i, i + CHUNK));
  const myTarget = state.target;
  s.lines.forEach((l) => { l.smart = false; });
  s.words = {}; s.wordsTarget = ''; s.engine = ''; s.warn = ''; s.translating = true;
  render();
  const engines = new Set();
  // fast = traduction instantanée (Google) ; sinon Gemini avec contexte, qui remplace la première
  const run = async (fast) => {
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const part = chunks[next++];
        try {
          const r = await api('/api/translate-lines', { lines: part.map((i) => s.lines[i].text), context: all, target: myTarget, source: s.source, fast });
          if (state.target !== myTarget) return;
          r.results.forEach((x, k) => {
            const l = s.lines[part[k]];
            if (fast && l.smart) return;
            l.tr = x.text; l.rm = x.translit; l.smart = !fast && r.engine === 'gemini';
          });
          if (r.source && s.source === 'auto') s.source = r.source;
          if (!fast) { engines.add(r.engine); if (r.warning) s.warn = r.warning; }
        } catch (e) { if (!fast) s.warn = e.message; }
        if (state.current === s.id && state.target === myTarget) render();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));
  };
  const fastDone = run(true);
  await run(false);
  s.engine = engines.has('gemini') ? (engines.has('google') ? 'mixed' : 'gemini') : 'google';
  if (geminiOn && state.target === myTarget) prefetchWords(s, myTarget); // sans attendre la fin du lot rapide
  await fastDone;
  s.target = myTarget; s.translating = false;
  save(); if (state.current === s.id) render();
  let autoMode = '';
  if (!s.goal.words.length && !s.goalAuto && state.current === s.id) { s.goalAuto = true; autoMode = await suggestGoal(); save(); renderGoal(); }
  try { if (autoMode !== 'llm') await translateGoal(); save(); if (state.current === s.id) renderGoal(); } catch (e) { setStatus(e.message, true); }
}

// Précharge la traduction contextuelle de tous les mots : un clic est ensuite instantané.
async function prefetchWords(s, target) {
  const seen = new Map();
  for (const l of s.lines) if (lineKind(l.text) === 'line') for (const m of l.text.matchAll(WORD_RE)) {
    const n = norm(m[0]);
    if (!seen.has(n) && [...n].length >= 2 && !/^\d+$/.test(n)) seen.set(n, { text: m[0], context: l.text });
  }
  const entries = [...seen], CH = 80, parts = [];
  for (let i = 0; i < entries.length; i += CH) parts.push(entries.slice(i, i + CH));
  const words = {};
  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const part = parts[next++];
      try {
        const r = await api('/api/translate-words', { items: part.map(([, v]) => v), target, source: s.source, llmOnly: true });
        r.results.forEach((x, k) => { words[part[k][0]] = { text: x.text, translit: x.translit, note: x.note }; });
      } catch { /* on retombe sur la traduction à la demande */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, parts.length) }, worker));
  if (state.target !== target) return;
  s.words = words; s.wordsTarget = target; save();
}

function ctxFor(word) {
  const n = norm(word);
  const l = song().lines.find((x) => [...x.text.matchAll(WORD_RE)].some((m) => norm(m[0]) === n));
  return l ? l.text : '';
}

async function translateGoal() {
  const s = song(); if (!s || !s.goal.words.length) return;
  const items = s.goal.words.map((w) => ({ text: w.word, context: ctxFor(w.word) }));
  const body = { items, target: state.target, source: s.source };
  const apply = (results, overwrite) => results.forEach((r, i) => {
    const w = s.goal.words[i]; if (!w || w.word !== items[i].text) return;
    if (overwrite || !w.tr) { w.tr = r.text; w.note = r.note || w.note || ''; }
  });
  const quick = api('/api/translate-words', { ...body, fast: true })
    .then(({ results }) => { apply(results, false); if (state.current === s.id) renderGoal(); }).catch(() => {});
  const { results } = await api('/api/translate-words', body);
  await quick; apply(results, true);
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

let tipSeen = false;
try { tipSeen = localStorage.getItem('ll_tip1') === '1'; } catch {}
$('#tip1x').onclick = () => { tipSeen = true; try { localStorage.setItem('ll_tip1', '1'); } catch {} $('#tip1').hidden = true; };

function render() {
  renderSongList(); renderLibrary();
  const s = song();
  $('#empty').hidden = !!s; $('#songView').hidden = !s; $('#goalSide').hidden = !s;
  $('#songTab').classList.toggle('nosong', !s);
  if (!s) { $('#addCard').open = true; return; }
  $('#tip1').hidden = tipSeen;
  $('#sTitle').textContent = s.title; $('#sArtist').textContent = s.artist;
  $('#sEngine').textContent = s.translating ? '' : s.engine === 'mixed' ? 'Traduction Gemini + Google (certains lots en secours)' : s.engine === 'gemini' ? '✨ Traduit avec Gemini (contexte de la chanson)' : s.engine === 'google' ? 'Traduction Google (vers par vers)' + (s.warn ? ' — ' + s.warn : '') : '';
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
  $('#progText').textContent = ws.length ? `${done} / ${ws.length} mots appris${done === ws.length ? ' 🎉' : ''}` : 'Choisissez les mots à retenir : « Suggérer » en propose.';
  $('#goalList').innerHTML = ws.map((w, i) => `<li class="${w.done ? 'done' : ''}">
    <input type="checkbox" data-i="${i}" ${w.done ? 'checked' : ''} aria-label="appris">
    <span class="g"><b><bdi>${esc(w.word)}</bdi></b><span class="gt muted">${esc(w.tr || '…')}</span>${w.note ? `<small class="muted">💡 ${esc(w.note)}</small>` : ''}</span>
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
const wordCache = new Map();
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
      ${popCtx.note ? `<div class="small">💡 ${esc(popCtx.note)}</div>` : ''}
      <div class="ctx" dir="auto">« ${esc(line.text)} »</div>
      <div class="row"><button class="primary" id="pSave" ${inLib ? 'disabled' : ''}>${inLib ? '✓ Enregistré' : '💾 Enregistrer'}</button>
      ${single ? `<button class="secondary" id="pGoal">${inGoal ? 'Retirer de l’objectif' : '🎯 Ajouter à l’objectif'}</button>` : ''}
      <button class="secondary" id="pClose">Fermer</button></div>`;
  };
  draw();
  const key = `${state.target}|${text}|${lineIdx}`;
  const apply = (r, refining) => {
    if (popCtx?.text !== text) return;
    popCtx.tr = r.text; popCtx.rm = r.translit; popCtx.note = r.note || ''; popCtx.refining = refining; draw();
  };
  const pre = !/\s/.test(text.trim()) && s.wordsTarget === state.target && s.words?.[norm(text)];
  if (pre) return apply(pre, false);
  if (wordCache.has(key)) return apply(wordCache.get(key), false);
  const base = { text, target: state.target, source: s.source };
  let smartDone = false;
  // 1) réponse immédiate (Google), 2) version contextuelle (Gemini) qui la remplace
  api('/api/translate', { ...base, fast: true }).then((r) => { if (!smartDone) apply(r, true); }).catch(() => {});
  try {
    const r = await api('/api/translate', { ...base, context: line.text });
    smartDone = true; wordCache.set(key, r); apply(r, false);
  } catch (e) {
    smartDone = true;
    if (popCtx?.text === text) { popCtx.refining = false; if (!popCtx.tr) popCtx.tr = '⚠ ' + e.message; draw(); }
  }
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
    const n = norm(m[0]); if ([...n].length < (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(n) ? 2 : 4) || /^\d+$/.test(n)) continue;
    counts.set(n, (counts.get(n) || 0) + 1); if (!forms.has(n)) forms.set(n, m[0]);
  }
  const known = new Set(state.library.map((e) => norm(e.text)));
  const kept = new Map(s.goal.words.map((w) => [norm(w.word), w]));
  const ranked = [...counts].filter(([n]) => !known.has(n) && !kept.has(n))
    // mots présents plusieurs fois (refrain) mais pas omniprésents, plus longs = plus riches
    .map(([n, c]) => [n, Math.min(c, 2) + [...n].length * 0.5 + Math.random() * 0.6]).sort((a, b) => b[1] - a[1]);
  const size = Number($('#goalSize').value);
  const keep = s.goal.words.filter((w) => w.done);
  const fresh = ranked.slice(0, Math.max(0, size - keep.length)).map(([n]) => ({ word: forms.get(n), tr: '', done: false }));
  s.goal = { size, words: [...keep, ...fresh] };
}

// Gemini choisit des mots utiles (pas de mots-outils) ; sans Gemini, repli sur une heuristique.
async function suggestGoal() {
  const s = song(); const size = Number($('#goalSize').value) || s.goal.size || 8;
  const keep = s.goal.words.filter((w) => w.done);
  if (geminiOn && size > keep.length) {
    try {
      const r = await api('/api/suggest-words', {
        lines: s.lines.filter((l) => lineKind(l.text) === 'line').map((l) => l.text), target: state.target, source: s.source,
        n: size - keep.length, exclude: [...keep.map((w) => w.word), ...state.library.map((e) => e.text)].slice(0, 100)
      });
      if (r.words) {
        const forms = new Map();
        for (const l of s.lines) for (const m of l.text.matchAll(WORD_RE)) if (!forms.has(norm(m[0]))) forms.set(norm(m[0]), m[0]);
        const seen = new Set(keep.map((w) => norm(w.word))), fresh = [];
        for (const w of r.words) {
          let n = norm(w.word);
          // tolère une forme sans préfixe collé (ex. hébreu : « בגדים » pour « הבגדים »)
          if (!forms.has(n)) n = [...forms.keys()].find((k) => k.endsWith(n) && k.length - n.length <= 2) || '';
          if (!n || seen.has(n)) continue;
          seen.add(n); fresh.push({ word: forms.get(n), tr: w.tr, note: w.note, done: false });
        }
        if (fresh.length >= Math.min(2, size - keep.length)) { s.goal = { size, words: [...keep, ...fresh] }; return 'llm'; }
      }
    } catch { /* repli */ }
  }
  suggestWords(); return 'heuristic';
}

$('#suggest').onclick = async () => {
  $('#progText').textContent = 'Choix des mots…';
  const mode = await suggestGoal(); save(); render();
  if (mode !== 'llm') { try { await translateGoal(); save(); renderGoal(); } catch (e) { setStatus(e.message, true); } }
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
  $('#libEmpty').textContent = 'Aucun mot enregistré. Ouvrez une chanson, cliquez sur un mot puis « Enregistrer ».';
  $('#libList').innerHTML = items.map((e) => `<li data-id="${e.id}">
    <span class="e"><bdi>${esc(e.text)}</bdi></span>
    <span class="m">${esc(e.tr)}<div class="s">${esc(e.title)}${e.artist ? ' · ' + esc(e.artist) : ''} · ${new Date(e.date).toLocaleDateString()}</div></span>
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
// Nettoie un texte copié depuis toute une page Genius (Cmd+A) : ne garde que les paroles.
function cleanPasted(raw) {
  const L = raw.replace(/\r/g, '').split('\n').map((x) => x.trim() === '' ? '' : x.replace(/\s+$/, ''));
  let start = L.findIndex((x) => /^\[.+\]$/.test(x.trim()));
  let title = '';
  const head = L.slice(0, start < 0 ? L.length : start);
  const h = head.find((x) => /\sLyrics$/i.test(x.trim()) && x.trim().length < 120);
  if (h) title = h.trim().replace(/\s+Lyrics$/i, '');
  if (start < 0) start = h ? L.indexOf(h) + 1 : 0;
  let end = L.findIndex((x, i) => i > start && /^(\d*\s*Embed|Share URL|About|Credits|Release Date|Comments?)$/i.test(x.trim()));
  if (end < 0) end = L.length;
  const lyrics = L.slice(start, end).filter((x) => !/^(You might also like|Read More\s*.*)$/i.test(x.trim()))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, lyrics };
}
async function useText(raw, meta = {}) {
  const { title, lyrics } = cleanPasted(raw);
  if (!lyrics) { setStatus('Rien à importer : copiez d’abord les paroles.', true); return false; }
  const parts = title.split(/\s[–—-]\s/);
  const [artist, name] = parts.length > 1 ? [parts[0], parts.slice(1).join(' - ')] : ['', title];
  let t = meta.title, ar = meta.artist;
  if (meta.guessed && name) { // lien direct : le titre vient de l'URL, on préfère celui de la page
    const flat = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const ns = flat(meta.title || ''), nt = flat(name);
    if (nt && ns.endsWith(nt) && ns.length > nt.length) ar = ns.slice(0, ns.length - nt.length).trim().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
    t = name;
  }
  await addSong({
    title: t || $('#mTitle').value.trim() || name || 'Sans titre',
    artist: ar || $('#mArtist').value.trim() || artist,
    url: meta.url || '', lyrics
  });
  return true;
}

// ---------- recherche Genius + fenêtre guidée ----------
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? '⌘' : 'Ctrl';
const slugToQuery = (u) => decodeURIComponent(new URL(u).pathname.replace(/^\//, '').replace(/-lyrics.*$/i, '')).replace(/-/g, ' ');

$('#searchForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('#q').value.trim(); $('#hits').innerHTML = '';
  if (/^https?:\/\/(www\.)?genius\.com\//i.test(q)) {
    // lien direct : pas besoin de recherche
    return openImport({ title: slugToQuery(q), artist: '', url: q, thumb: '', guessed: true });
  }
  setStatus('Recherche…');
  try {
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    if (r.needsToken) return setStatus('Recherche non configurée : ajoutez GENIUS_TOKEN (voir README). Vous pouvez coller un lien Genius à la place.', true);
    setStatus(r.hits.length ? '' : 'Aucun résultat.', !r.hits.length);
    $('#hits').innerHTML = r.hits.map((h, i) => `<li data-i="${i}"><img src="${esc(h.thumb)}" alt=""><span><b dir="auto">${esc(h.title)}</b><small>${esc(h.artist)}</small></span></li>`).join('');
    $('#hits').onclick = (ev) => { const li = ev.target.closest('li'); if (li) openImport(r.hits[Number(li.dataset.i)]); };
  } catch (err) { setStatus(err.message, true); }
};

const dlg = $('#dlg');
let watcher = null;
function openImport(h) {
  const label = [h.title, h.artist].filter(Boolean).join(' — ');
  dlg.innerHTML = `<button class="x" id="dX" aria-label="Fermer">✕</button>
    <h2 dir="auto">${esc(label)}</h2><div class="muted small">Importer les paroles en 3 gestes</div>
    <ol>
      <li><div><button class="primary" id="dOpen">Ouvrir la page Genius</button>
        <div class="muted small" style="margin-top:4px">Elle s’ouvre dans une petite fenêtre à côté de l’app, qui reste ouverte.</div></div></li>
      <li><div>Dans la fenêtre Genius : cliquez sur le texte, puis <kbd>${MOD}</kbd> + <kbd>A</kbd> puis <kbd>${MOD}</kbd> + <kbd>C</kbd>
        <div class="demo" aria-hidden="true"><div class="bar"><i></i><i></i><i></i></div>
          <div class="page"><span>אולי אולא, יהיה לי רע</span><span>יהיה לי טוב</span><span>הכל יכול לקרות</span><div class="sel"></div><div class="toast">Copié ✓</div></div>
          <div class="keys"><kbd>${MOD} A</kbd><kbd>${MOD} C</kbd></div></div></div></li>
      <li><div id="dState">Revenez dans l’app : les paroles copiées sont détectées automatiquement.
        <div style="margin-top:8px"><button class="secondary" id="dPaste">📋 Coller les paroles copiées</button></div></div></li>
    </ol>`;
  const state$ = () => $('#dState');
  let popup = null, done = false;
  const finish = async (raw) => {
    if (done) return; done = true;
    state$().innerHTML = '<span class="ok">Paroles trouvées, import en cours…</span>';
    if (await useText(raw, h)) { stop(); dlg.close(); if (popup && !popup.closed) popup.close(); } else done = false;
  };
  const tryClipboard = async (auto) => {
    try {
      const txt = await navigator.clipboard.readText();
      const looksRight = norm(txt).includes(norm(h.title)) && txt.length > 60;
      if (looksRight || (!auto && txt.trim())) return finish(txt);
      if (!auto) state$().insertAdjacentHTML('beforeend', '<div class="status err">Le presse-papiers ne contient pas les paroles. Refaites ⌘A puis ⌘C dans la fenêtre Genius.</div>');
    } catch { if (!auto) state$().insertAdjacentHTML('beforeend', '<div class="status err">Accès au presse-papiers refusé : autorisez-le, ou collez dans « Coller à la main ».</div>'); }
  };
  const onFocus = () => setTimeout(() => tryClipboard(true), 250);
  const stop = () => { window.removeEventListener('focus', onFocus); clearInterval(watcher); };
  $('#dOpen').onclick = () => {
    popup = window.open(h.url, 'genius', 'width=980,height=820');
    if (!popup) state$().insertAdjacentHTML('afterbegin', `<div class="status err">Fenêtre bloquée : <a href="${esc(h.url)}" target="_blank" rel="noopener">ouvrir Genius dans un onglet</a>, puis revenez ici.</div>`);
  };
  $('#dPaste').onclick = () => tryClipboard(false);
  $('#dX').onclick = () => { stop(); dlg.close(); };
  dlg.onclose = stop;
  window.addEventListener('focus', onFocus);
  dlg.showModal();
}

$('#mLyrics').addEventListener('paste', (e) => {
  const txt = e.clipboardData?.getData('text'); if (!txt) return;
  e.preventDefault(); useText(txt);
});
$('#mGo').onclick = async () => {
  const lyrics = $('#mLyrics').value.trim();
  if (!lyrics) return setStatus('Collez des paroles d’abord.', true);
  await useText(lyrics);
  $('#mLyrics').value = '';
};

try {
  const st = await api('/api/status');
  geminiOn = !!st.gemini;
  $('#engine').textContent = st.gemini ? '✨ Gemini' : 'Google Translate';
  $('#engine').classList.toggle('on', !!st.gemini);
  $('#engine').title = st.gemini ? 'Traduction contextuelle par Gemini' : 'Traduction mot à mot. Pour une meilleure qualité, ajoutez GEMINI_API_KEY dans le fichier .env';
} catch {}
await initLanguages();
render();
