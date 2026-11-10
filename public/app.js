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
const songsDlg = $('#songsDlg');

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(data.error || `Erreur ${res.status}`).replace(/Gemini|DeepL/gi, 'le moteur de traduction'));
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

async function addSong({ title, artist, url, lyrics, gid }) {
  const lines = lyrics.split('\n').map((text) => ({ text: text.trimEnd() }));
  const id = (url || `${artist}-${title}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80) + '-' + Date.now().toString(36);
  state.songs[id] = { id, title, artist, url: url || '', gid: gid || '', lines, target: state.target, source: 'auto', goal: { size: 8, words: [] }, added: Date.now() };
  state.current = id;
  save();
  $('#hits').innerHTML = ''; $('#q').value = ''; setStatus('');
  if (songsDlg.open) songsDlg.close();
  showTab('song');
  translateSong(); // en arrière-plan
  loadMedia(state.songs[id]); // liens d'écoute connus de Genius : la chanson s'affiche tout de suite
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
  // fast = traduction instantanée ; sinon moteur contextuel, qui remplace la première
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
  s.engine = engines.has('gemini') ? (engines.size > 1 ? 'mixed' : 'gemini') : engines.has('deepl') ? (engines.has('google') ? 'mixed' : 'deepl') : 'google';
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
  if (currentTab === 'home') renderHome();
  const s = song();
  $('#empty').hidden = !!s; $('#songView').hidden = !s; $('#goalSide').hidden = !s;
  $('#songTab').classList.toggle('nosong', !s);
  if (!s) { popCtx = null; activeLine = null; return; }
  $('#tip1').hidden = tipSeen;
  $('#sTitle').textContent = s.title;
  $('#sArtist').textContent = ['En cours', s.artist].filter(Boolean).join(' / ');
  $('#sEngine').textContent = !s.translating && s.engine === 'google' && geminiOn ? 'Traduction simplifiée : le moteur principal est momentanément indisponible.' : '';
  $('#sSrc').innerHTML = /^https:\/\/genius\.com\//i.test(s.url || '') ? `Paroles sur <a class="gbadge" href="${esc(s.url)}" target="_blank" rel="noopener"><img src="genius-logo.svg" alt="Genius"></a>` : '';
  const dir = RTL.has(state.target) ? 'rtl' : 'ltr';
  $('#lyrics').className = 'lyrics' + ($('#showTr').checked ? '' : ' hide-tr');
  $('#lyrics').innerHTML = s.lines.map((l, i) => {
    const k = lineKind(l.text);
    if (k === 'gap') return '<div class="gap"></div>';
    if (k === 'sec') return `<div class="sec">${esc(l.text.replace(/^\[|\]$/g, ''))}</div>`;
    const tr = l.tr ? `<div class="tr" dir="${dir}">${esc(l.tr)}${l.rm ? ` <small>· ${esc(l.rm)}</small>` : ''}</div>` : '';
    return `<div class="ln${activeLine === i ? ' active' : ''}" data-i="${i}"><div class="orig" dir="auto">${wordsHtml(l.text, i)}</div>${tr}</div>`;
  }).join('');
  renderPlayer();
  renderListen();
  renderGoal();
}

function renderGoal() {
  const s = song(); const ws = s.goal.words;
  $('#goalSize').value = s.goal.size;
  const done = ws.filter((w) => w.done).length;
  $('#bar').style.width = ws.length ? `${(done / ws.length) * 100}%` : '0';
  $('#progText').textContent = ws.length ? `${done} / ${ws.length}` : '';
  const pad = (3 - ((ws.length + 1) % 3)) % 3;
  $('#goalGrid').innerHTML = ws.map((w, i) => `<div class="cell${w.done ? ' done' : ''}" data-i="${i}" role="button" tabindex="0" title="${esc(w.note || '')}">
      <button class="rm" data-rm="${i}" aria-label="Retirer">✕</button>
      <b class="cw"><bdi>${esc(w.word)}</bdi></b><span class="ct">${esc(w.tr || '…')}</span></div>`).join('')
    + `<button class="cell cta" data-act="suggest" aria-label="Suggérer des mots"><span>+</span><small>${ws.length ? 'Autres mots' : 'Suggérer'}</small></button>`
    + '<div class="cell empty"></div>'.repeat(pad);
  $('#goalSide').classList.toggle('quiz', $('#quiz').checked);
}

function renderSongList() {
  const list = Object.values(state.songs).sort((a, b) => b.added - a.added);
  $('#songList').innerHTML = list.length ? list.map((s) => `<li data-id="${s.id}" class="${s.id === state.current ? 'on' : ''}">
    <span><b>${esc(s.title)}</b><small>${esc(s.artist)}</small></span><button data-del="${s.id}" title="Supprimer" aria-label="Supprimer">✕</button></li>`).join('')
    : '<li class="small">Aucune chanson pour l’instant.</li>';
}

// ---------- accueil ----------
function renderHome() {
  const songs = Object.values(state.songs).sort((a, b) => b.added - a.added);
  const learned = songs.reduce((n, x) => n + x.goal.words.filter((w) => w.done).length, 0);
  $('#stats').innerHTML = [[songs.length, songs.length > 1 ? 'Chansons' : 'Chanson'], [state.library.length, 'Mots enregistrés'], [learned, 'Mots appris']]
    .map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');
  $('#homeResume').hidden = !song();
  $('#homeSongs').innerHTML = songs.map((x) => {
    const done = x.goal.words.filter((w) => w.done).length, tot = x.goal.words.length;
    return `<div class="card" data-id="${x.id}" role="button" tabindex="0">
      <button class="del" data-del="${x.id}" aria-label="Supprimer">✕</button>
      <div><div class="ct1">${esc(x.artist || 'Chanson')}</div><h3 dir="auto">${esc(x.title)}</h3></div>
      <div><div class="mini"><span>${tot ? `${done} / ${tot} mots appris` : 'Pas d’objectif'}</span><span>${esc(x.id === state.current ? 'En cours' : '')}</span></div>
        <div class="minibar"><i style="width:${tot ? (done / tot) * 100 : 0}%"></i></div></div></div>`;
  }).join('') + '<button class="card new" id="homeNew" type="button"><span>+</span><small>Nouvelle chanson</small></button>';
}
$('#homeSongs').addEventListener('click', async (e) => {
  if (e.target.closest('#homeNew')) return songsDlg.showModal();
  const del = e.target.closest('[data-del]');
  if (del) { delete state.songs[del.dataset.del]; if (state.current === del.dataset.del) state.current = null; save(); render(); return; }
  const card = e.target.closest('.card[data-id]'); if (!card) return;
  state.current = card.dataset.id; save(); render(); showTab('song');
  if (song().target !== state.target) await translateSong();
});
$('#homeSongs').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card[data-id]')) { e.preventDefault(); e.target.click(); } });
$('#homeAdd').onclick = () => songsDlg.showModal();
$('#homeResume').onclick = () => showTab('song');

// ---------- lecteur : Spotify, Apple Music, Deezer, YouTube, SoundCloud ----------
function parsePlayer(input) {
  let raw = String(input).trim();
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let u; try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname.toLowerCase().replace(/^((www|m|music|open|embed|play)\.)+/, '');
  const path = u.pathname;
  let m;
  if (h === 'spotify.com' && (m = path.match(/\/(track|album|playlist|episode|show)\/([A-Za-z0-9]{10,30})/)))
    return { provider: 'Spotify', src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`, h: m[1] === 'track' ? 80 : m[1] === 'episode' ? 152 : 352 };
  if (h === 'apple.com' && /^\/[a-z]{2}\/(album|song|playlist)\//i.test(path)) {
    const i = u.searchParams.get('i');
    return { provider: 'Apple Music', src: 'https://embed.music.apple.com' + path.replace(/[^A-Za-z0-9/_%.\-]/g, '') + (i && /^\d+$/.test(i) ? `?i=${i}` : ''), h: /\/song\//.test(path) || i ? 175 : 450 };
  }
  if (h === 'deezer.com' && (m = path.match(/\/(track|album|playlist)\/(\d+)/)))
    return { provider: 'Deezer', src: `https://widget.deezer.com/widget/auto/${m[1]}/${m[2]}`, h: m[1] === 'track' ? 150 : 300 };
  let yt = '';
  if (h === 'youtu.be') yt = (path.match(/^\/([A-Za-z0-9_-]{6,15})/) || [])[1] || '';
  else if (h === 'youtube.com') yt = (path.match(/^\/embed\/([A-Za-z0-9_-]{6,15})/) || [])[1] || u.searchParams.get('v') || '';
  if (/^[A-Za-z0-9_-]{6,15}$/.test(yt)) return { provider: 'YouTube', src: `https://www.youtube-nocookie.com/embed/${yt}`, h: 0, kind: 'yt' };
  if (h === 'soundcloud.com' && /^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/.test(path))
    return { provider: 'SoundCloud', src: 'https://w.soundcloud.com/player/?url=' + encodeURIComponent('https://soundcloud.com' + path.replace(/[^A-Za-z0-9/_-]/g, '')) + '&color=%23000000&hide_related=true&show_comments=false', h: 166 };
  return null;
}

// ---------- écouter ailleurs : liens Spotify, Apple Music, Deezer, YouTube, SoundCloud ----------
const HOSTS = { spotify: /(^|\.)spotify\.com$/, youtube: /(^|\.)(youtube\.com|youtu\.be)$/, soundcloud: /(^|\.)soundcloud\.com$/ };
function safeLink(u, kind) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) && HOSTS[kind].test(x.hostname) ? x.href : ''; } catch { return ''; }
}
function listenLinks(s) {
  const q = encodeURIComponent([s.artist, s.title].filter(Boolean).join(' ').trim());
  const m = s.media || {};
  return [
    ['Spotify', safeLink(m.spotify, 'spotify') || `https://open.spotify.com/search/${q}`],
    ['Apple Music', `https://music.apple.com/search?term=${q}`],
    ['Deezer', `https://www.deezer.com/search/${q}`],
    ['YouTube', safeLink(m.youtube, 'youtube') || `https://www.youtube.com/results?search_query=${q}`],
    ['SoundCloud', safeLink(m.soundcloud, 'soundcloud') || `https://soundcloud.com/search?q=${q}`]
  ];
}
function renderListen() {
  const s = song(); if (!s) return;
  $('#listen').innerHTML = '<span class="label">Écouter sur</span>' + listenLinks(s)
    .map(([n, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(n)}</a>`).join('');
}
async function loadMedia(s) {
  if (!s || !s.gid) return;
  try {
    const { media } = await api('/api/song-media?id=' + encodeURIComponent(s.gid));
    if (!media || !Object.values(media).some(Boolean)) return;
    s.media = media;
    // si l'utilisateur n'a pas choisi de lecteur, on en propose un (Spotify, sinon YouTube)
    if (!s.player) {
      for (const u of [safeLink(media.spotify, 'spotify'), safeLink(media.youtube, 'youtube')]) {
        const p = u && parsePlayer(u); if (p) { s.player = { ...p, url: u, auto: true }; break; }
      }
    }
    save();
    if (state.current === s.id) { renderPlayer(); renderListen(); }
  } catch { /* pas bloquant */ }
}

let playerKey = '', playerEditing = false;
function renderPlayer() {
  const s = song(); if (!s) return;
  const p = s.player;
  const key = `${s.id}|${p ? p.src : ''}|${playerEditing}`;
  if (key === playerKey) return; // ne recrée pas l'iframe : la musique ne doit pas s'interrompre
  playerKey = key;
  const box = $('#player');
  if (p && !playerEditing) {
    box.innerHTML = `<div class="pbar"><span class="label">Écouter · ${esc(p.provider)}</span>
        <button class="link" data-p="change">Changer</button><button class="link" data-p="remove">Retirer</button></div>
      <iframe class="${p.kind === 'yt' ? 'yt' : ''}" src="${esc(p.src)}" ${(/open\.spotify\.com\/embed\/track\//.test(p.src) ? 80 : p.h) ? `height="${/open\.spotify\.com\/embed\/track\//.test(p.src) ? 80 : p.h}"` : ''} loading="lazy" referrerpolicy="strict-origin-when-cross-origin"
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" allowfullscreen title="Lecteur ${esc(p.provider)}"></iframe>
      <p class="pnote">Selon le service, l’écoute complète demande d’être connecté à votre compte dans ce navigateur ; sinon un extrait est joué.</p>`;
  } else if (playerEditing || p) {
    box.innerHTML = `<form id="playerForm"><input id="playerUrl" type="text" placeholder="Lien Spotify, Apple Music, Deezer, YouTube ou SoundCloud" required autocomplete="off">
        <button class="btn solid">Ajouter</button><button class="link" type="button" data-p="cancel">Annuler</button></form><p class="perr" id="playerErr" hidden></p>`;
    $('#playerUrl').focus();
  } else {
    box.innerHTML = '<button class="add" data-p="change">＋ Ajouter un lecteur</button>';
  }
}
$('#player').addEventListener('click', (e) => {
  const a = e.target.closest('[data-p]'); if (!a) return;
  const s = song(); if (!s) return;
  if (a.dataset.p === 'change') playerEditing = true;
  if (a.dataset.p === 'cancel') playerEditing = false;
  if (a.dataset.p === 'remove') { delete s.player; playerEditing = false; save(); }
  renderPlayer();
});
$('#player').addEventListener('submit', (e) => {
  e.preventDefault();
  const s = song(); const p = parsePlayer($('#playerUrl').value);
  if (!p) { const er = $('#playerErr'); er.textContent = 'Lien non reconnu. Collez le lien de partage d’un titre (Spotify, Apple Music, Deezer, YouTube, SoundCloud).'; er.hidden = false; return; }
  s.player = { ...p, url: $('#playerUrl').value.trim() }; playerEditing = false; save(); renderPlayer();
});

// ---------- panneau de traduction (mot / expression) ----------
const pop = $('#wordPanel');
let popCtx = null, activeLine = null;
const wordCache = new Map();

function setActiveLine(i) {
  activeLine = i;
  document.querySelectorAll('#lyrics .ln').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === i));
}
function closePop() { popCtx = null; setActiveLine(null); drawPanel(); }

function drawPanel() {
  const s = song();
  pop.classList.toggle('open', !!popCtx && !!s);
  if (!popCtx || !s) { pop.innerHTML = '<div class="label">Traduction</div><p class="placeholder">Cliquez un mot dans les paroles, ou sélectionnez plusieurs mots, pour voir sa traduction ici.</p>'; return; }
  const line = s.lines[popCtx.lineIdx] || { text: '' }, text = popCtx.text;
  const inLib = state.library.some((e) => norm(e.text) === norm(text));
  const inGoal = s.goal.words.some((g) => norm(g.word) === norm(text));
  const single = !/\s/.test(text.trim());
  pop.innerHTML = `<div class="label"><span>Traduction</span><button id="pClose" aria-label="Fermer">✕</button></div>
    <div class="wordbig" dir="auto">${esc(text)}</div>
    <div class="wmeta">${popCtx.rm ? esc(popCtx.rm) : ''}</div>
    <p class="def">${popCtx.tr ? esc(popCtx.tr) : '<span class="dots">…</span>'}</p>
    ${popCtx.note ? `<p class="note"><b>Note</b>${esc(popCtx.note)}</p>` : ''}
    <p class="ctx" dir="auto">« ${esc(line.text)} »</p>
    ${line.tr ? `<p class="ctxtr">${esc(line.tr)}</p>` : ''}
    <div class="acts"><button class="btn solid" id="pSave" ${inLib ? 'disabled' : ''}>${inLib ? 'Enregistré ✓' : 'Enregistrer'}</button>
      ${single ? `<button class="btn" id="pGoal">${inGoal ? 'Retirer de l’objectif' : 'Ajouter à l’objectif'}</button>` : ''}</div>`;
}

async function openPop(text, lineIdx) {
  const s = song();
  popCtx = { text, lineIdx, tr: '', rm: '', note: '' };
  setActiveLine(lineIdx);
  drawPanel();
  const key = `${state.target}|${text}|${lineIdx}`;
  const apply = (r) => {
    if (popCtx?.text !== text) return;
    popCtx.tr = r.text; popCtx.rm = r.translit; popCtx.note = r.note || ''; drawPanel();
  };
  const pre = !/\s/.test(text.trim()) && s.wordsTarget === state.target && s.words?.[norm(text)];
  if (pre) return apply(pre);
  if (wordCache.has(key)) return apply(wordCache.get(key));
  const base = { text, target: state.target, source: s.source };
  let smartDone = false;
  // 1) réponse immédiate, 2) version contextuelle qui la remplace
  api('/api/translate', { ...base, fast: true }).then((r) => { if (!smartDone) apply(r); }).catch(() => {});
  try {
    const r = await api('/api/translate', { ...base, context: s.lines[lineIdx].text });
    smartDone = true; wordCache.set(key, r); apply(r);
  } catch (e) {
    smartDone = true;
    if (popCtx?.text === text && !popCtx.tr) { popCtx.tr = '⚠ ' + e.message; drawPanel(); }
  }
}

pop.addEventListener('click', (e) => {
  const s = song(); const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'pClose') return closePop();
  if (!popCtx || !s) return;
  if (b.id === 'pSave') {
    const l = s.lines[popCtx.lineIdx];
    state.library.unshift({ id: crypto.randomUUID(), text: popCtx.text, tr: popCtx.tr, rm: popCtx.rm, lang: state.target, sentence: l.text, sentenceTr: l.tr || '', title: s.title, artist: s.artist, url: s.url, date: Date.now() });
    save(); render(); drawPanel();
  }
  if (b.id === 'pGoal') {
    const i = s.goal.words.findIndex((g) => norm(g.word) === norm(popCtx.text));
    if (i >= 0) s.goal.words.splice(i, 1);
    else s.goal.words.push({ word: popCtx.text, tr: popCtx.tr, note: popCtx.note, done: false });
    save(); render(); drawPanel();
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
        if (!Number.isNaN(li)) return openPop(txt.replace(/\s+/g, ' '), li);
      }
      return;
    }
    const w = e.target.closest?.('.w');
    if (w) openPop(w.textContent, Number(w.dataset.l));
  }, 0);
});

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

// Choix des mots utiles (pas de mots-outils) ; sinon repli sur une heuristique.
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

async function runSuggest() {
  $('#progText').textContent = '…';
  const mode = await suggestGoal(); save(); render();
  if (mode !== 'llm') { try { await translateGoal(); save(); renderGoal(); } catch (e) { setStatus(e.message, true); } }
}
$('#goalSize').onchange = () => { song().goal.size = Number($('#goalSize').value); save(); };
$('#quiz').onchange = renderGoal;
$('#goalGrid').addEventListener('click', (e) => {
  const s = song(); if (!s) return;
  if (e.target.closest('[data-act="suggest"]')) return runSuggest();
  const rm = e.target.closest('[data-rm]');
  if (rm) { s.goal.words.splice(Number(rm.dataset.rm), 1); save(); render(); return; }
  const cell = e.target.closest('.cell[data-i]'); if (!cell) return;
  if ($('#quiz').checked && e.target.classList.contains('ct') && !e.target.classList.contains('show')) { e.target.classList.add('show'); return; }
  const w = s.goal.words[Number(cell.dataset.i)]; w.done = !w.done; save(); render();
});
$('#goalGrid').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.cell[data-i]')) { e.preventDefault(); e.target.click(); }
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
let currentTab = 'home';
function showTab(name) {
  currentTab = name;
  document.querySelectorAll('.nav button[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  $('#homeTab').hidden = name !== 'home'; $('#songTab').hidden = name !== 'song'; $('#libraryTab').hidden = name !== 'library';
  closePop(); hideTip(); window.scrollTo(0, 0);
  if (name === 'home') renderHome();
}
document.querySelectorAll('.nav button[data-tab]').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
$('#brand').onclick = (e) => { e.preventDefault(); showTab('home'); };

$('#showTr').onchange = render;
$('#target').onchange = async () => {
  state.target = $('#target').value; save();
  if (song()) await translateSong();
};
$('#songList').addEventListener('click', async (e) => {
  const del = e.target.dataset.del;
  if (del) { delete state.songs[del]; if (state.current === del) state.current = null; save(); return render(); }
  const li = e.target.closest('li[data-id]'); if (!li) return;
  state.current = li.dataset.id; save(); closePop(); songsDlg.close(); showTab('song');
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
    url: meta.url || '', lyrics, gid: meta.id || ''
  });
  return true;
}

// ---------- recherche Genius + fenêtre guidée ----------
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? '⌘' : 'Ctrl';
const slugToQuery = (u) => decodeURIComponent(new URL(u).pathname.replace(/^\//, '').replace(/-lyrics.*$/i, '')).replace(/-/g, ' ');

// Recherche : au fil de la frappe (aperçu) et à l'envoi du formulaire.
let searchSeq = 0, hitList = [], hitIdx = -1;
const GENIUS_LINK = /^https?:\/\/(www\.)?genius\.com\//i;

function renderHits(hits) {
  hitList = hits; hitIdx = -1;
  $('#hits').innerHTML = hits.map((h, i) => `<li data-i="${i}"><img src="${esc(h.thumb)}" alt=""><span><b dir="auto">${esc(h.title)}</b><small>${esc(h.artist)}</small></span></li>`).join('');
}
$('#hits').addEventListener('click', (ev) => { const li = ev.target.closest('li'); if (li && hitList[Number(li.dataset.i)]) openImport(hitList[Number(li.dataset.i)]); });

async function runSearch(q, live) {
  const seq = ++searchSeq;
  setStatus(live ? '' : 'Recherche…');
  try {
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    if (seq !== searchSeq) return; // une recherche plus récente a pris le relais
    if (r.needsToken) return setStatus('Recherche non configurée : ajoutez GENIUS_TOKEN (voir README). Vous pouvez coller un lien Genius à la place.', true);
    renderHits(r.hits);
    setStatus(r.hits.length ? '' : 'Aucun résultat.', !r.hits.length);
  } catch (err) {
    if (seq === searchSeq) setStatus(err.message + ' En attendant, vous pouvez coller directement un lien Genius dans ce champ.', true);
  }
}

$('#searchForm').onsubmit = (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (GENIUS_LINK.test(q)) { renderHits([]); return openImport({ title: slugToQuery(q), artist: '', url: q, thumb: '', guessed: true }); }
  if (hitIdx >= 0 && hitList[hitIdx]) return openImport(hitList[hitIdx]);
  runSearch(q, false);
};

let liveTimer;
$('#q').addEventListener('input', () => {
  clearTimeout(liveTimer);
  const q = $('#q').value.trim();
  if (q.length < 2 || GENIUS_LINK.test(q)) { searchSeq++; renderHits([]); if (q.length < 2) setStatus(''); return; }
  liveTimer = setTimeout(() => runSearch(q, true), 300);
});
$('#q').addEventListener('keydown', (e) => {
  if (!hitList.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  e.preventDefault();
  hitIdx = (hitIdx + (e.key === 'ArrowDown' ? 1 : -1) + hitList.length) % hitList.length;
  document.querySelectorAll('#hits li').forEach((li, k) => li.classList.toggle('sel', k === hitIdx));
  document.querySelector('#hits li.sel')?.scrollIntoView({ block: 'nearest' });
});

const dlg = $('#dlg');
let watcher = null;
function openImport(h) {
  if (songsDlg.open) songsDlg.close();
  const label = [h.title, h.artist].filter(Boolean).join(' — ');
  dlg.innerHTML = `<button class="x" id="dX" aria-label="Fermer">✕</button>
    <h2 dir="auto">${esc(label)} <a class="gbadge" href="${esc(h.url)}" target="_blank" rel="noopener" title="Ouvrir sur Genius"><img src="genius-logo.svg" alt="Genius"></a></h2><div class="muted small">Importer les paroles en 3 gestes</div>
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

$('#openSongs').onclick = () => songsDlg.showModal();
$('#heroAdd').onclick = () => songsDlg.showModal();
$('#songsX').onclick = () => songsDlg.close();
songsDlg.addEventListener('click', (e) => { if (e.target === songsDlg) songsDlg.close(); });

try {
  const st = await api('/api/status');
  geminiOn = !!st.gemini;
} catch {}
await initLanguages();
drawPanel();
render();
showTab('home');
