import { t, getLang, setLang, applyStatic } from './i18n.js';
import { parseEmbedCode, embedSrcdoc, cleanEmbedText } from './embed.js';
import { SAMPLE_SONG, howHtml, goalDiagramHtml, libEmptyHtml, startTour, endTour, isTourOpen } from './guide.js';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RTL = new Set(['ar', 'he', 'fa', 'ur']);
const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}]+)*/gu;
const norm = (w) => w.toLowerCase().normalize('NFC').replace(/[֑-ׇ]/g, '');

// ---------- état ----------
let state = { songs: {}, library: [], target: 'en', current: null };
let firstVisit = true;
try { const raw = localStorage.getItem('ll_state'); if (raw) { firstVisit = false; Object.assign(state, JSON.parse(raw)); } } catch {}
const save = () => { try { localStorage.setItem('ll_state', JSON.stringify(state)); } catch {} };
const song = () => state.songs[state.current];
const songsDlg = $('#songsDlg');

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(data.error || `${t('common.error')} ${res.status}`).replace(/Gemini|DeepL/gi, t('engine.name')));
  return data;
}
const setStatus = (m, err) => { const s = $('#status'); s.textContent = m; s.classList.toggle('err', !!err); };

// ---------- langues ----------
async function initLanguages() {
  const langs = await api('/api/languages');
  // première visite : langue de traduction = langue du navigateur si elle existe, sinon l'anglais
  if (firstVisit) { const nav = String(navigator.language || 'en'); const c = langs[nav] ? nav : langs[nav.slice(0, 2)] ? nav.slice(0, 2) : 'en'; state.target = c; }
  $('#target').innerHTML = Object.entries(langs).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  $('#target').value = state.target;
}

// ---------- import ----------
function lineKind(t) {
  if (!t.trim()) return 'gap';
  return /^\[.*\]$/.test(t.trim()) ? 'sec' : 'line';
}

async function addSong({ title, artist, url, lyrics, gid, sample }) {
  const lines = lyrics.split('\n').map((text) => ({ text: text.trimEnd() }));
  const id = (url || `${artist}-${title}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80) + '-' + Date.now().toString(36);
  state.songs[id] = { id, title, artist, url: url || '', gid: gid || '', sample: !!sample, lines, target: state.target, source: 'auto', goal: { size: 8, words: [] }, added: Date.now() };
  state.current = id;
  save();
  $('#hits').innerHTML = ''; $('#q').value = ''; setStatus('');
  if (songsDlg.open) songsDlg.close();
  showTab('song');
  translateSong(); // en arrière-plan
  if (!sample) loadMedia(state.songs[id]); // liens d'écoute connus de Genius : la chanson s'affiche tout de suite
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
  $('#sArtist').textContent = [t('kicker.now'), s.artist].filter(Boolean).join(' / ');
  $('#sEngine').textContent = !s.translating && s.engine === 'google' && geminiOn ? t('engine.simplified') : '';
  $('#sSrc').innerHTML = /^https:\/\/genius\.com\//i.test(s.url || '') ? `${t('src.lyricsOn')} <a class="gbadge" href="${esc(s.url)}" target="_blank" rel="noopener"><img src="genius-logo.svg" alt="Genius"></a>` : '';
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
      <button class="rm" data-rm="${i}" aria-label="${t('common.remove')}">✕</button>
      <b class="cw"><bdi>${esc(w.word)}</bdi></b><span class="ct">${esc(w.tr || '…')}</span></div>`).join('')
    + `<button class="cell cta" data-act="suggest" aria-label="${t('goal.suggestAria')}"><span>+</span><small>${ws.length ? t('goal.more') : t('goal.suggest')}</small></button>`
    + '<div class="cell empty"></div>'.repeat(pad);
  $('#goalSide').classList.toggle('quiz', $('#quiz').checked);
}

function renderSongList() {
  const list = Object.values(state.songs).sort((a, b) => b.added - a.added);
  $('#songList').innerHTML = list.length ? list.map((s) => `<li data-id="${s.id}" class="${s.id === state.current ? 'on' : ''}">
    <span><b>${esc(s.title)}</b><small>${esc(s.artist)}</small></span><button data-del="${s.id}" title="${t('common.delete')}" aria-label="${t('common.delete')}">✕</button></li>`).join('')
    : `<li class="small">${t('songs.empty')}</li>`;
}

// ---------- accueil ----------
function renderHome() {
  const songs = Object.values(state.songs).sort((a, b) => b.added - a.added);
  const learned = songs.reduce((n, x) => n + x.goal.words.filter((w) => w.done).length, 0);
  $('#stats').innerHTML = [[songs.length, songs.length === 1 ? t('stat.song') : t('stat.songs')], [state.library.length, t('stat.saved')], [learned, t('stat.learned')]]
    .map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');
  $('#homeResume').hidden = !song();
  $('#stats').hidden = !songs.length;
  $('#homeSongs').closest('.hblock').hidden = !songs.length;
  $('#how').innerHTML = howHtml(t);
  renderStart();
  $('#homeSongs').innerHTML = songs.map((x) => {
    const done = x.goal.words.filter((w) => w.done).length, tot = x.goal.words.length;
    return `<div class="card" data-id="${x.id}" role="button" tabindex="0">
      <button class="del" data-del="${x.id}" aria-label="${t('common.delete')}">✕</button>
      <div><div class="ct1">${esc(x.artist || t('common.song'))}</div><h3 dir="auto">${esc(x.title)}</h3></div>
      <div><div class="mini"><span>${tot ? t('card.progress', { done, tot }) : t('card.nogoal')}</span><span>${esc(x.id === state.current ? t('card.current') : '')}</span></div>
        <div class="minibar"><i style="width:${tot ? (done / tot) * 100 : 0}%"></i></div></div></div>`;
  }).join('') + '<button class="card new" id="homeNew" type="button"><span>+</span><small>' + t('card.new') + '</small></button>';
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

// ---------- « Pour commencer » : 3 étapes qui se cochent toutes seules ----------
let startHidden = false;
try { startHidden = localStorage.getItem('ll_start_hide') === '1'; } catch {}
function renderStart() {
  const box = $('#start');
  const songs = Object.values(state.songs);
  const done = [songs.length > 0, state.library.length > 0, songs.some((x) => x.goal.words.some((w) => w.done))];
  const n = done.filter(Boolean).length;
  if (startHidden) { box.hidden = true; return; }
  box.hidden = false;
  const cur = done.findIndex((d) => !d);
  const items = [1, 2, 3].map((k, i) => {
    const cta = i !== cur ? '' : i === 0
      ? `<div class="start-cta"><button class="btn solid" id="startAdd" type="button">${esc(t('home.add'))}</button><button class="link" id="startTry" type="button">${esc(t('start.example'))}</button></div>`
      : `<div class="start-cta"><button class="btn solid" id="startOpen" type="button">${esc(t('start.open'))}</button></div>`;
    return `<li class="${done[i] ? 'done' : i === cur ? 'cur' : ''}"><span class="sn">${done[i] ? '✓' : k}</span><div><h3>${esc(t(`start.s${k}.t`))}</h3><p>${esc(t(`start.s${k}.d`))}</p>${cta}</div></li>`;
  }).join('');
  box.innerHTML = `<div class="start-h"><div class="label">${esc(t('start.title'))}</div><span class="prog">${esc(t('start.progress', { done: n, total: 3 }))}</span><span class="pspace"></span><button class="link" id="startHide" type="button">${esc(t('start.hide'))}</button></div>
    <div class="progress"><div style="width:${(n / 3) * 100}%"></div></div>`
    + (n === 3 ? `<p class="start-done">${esc(t('start.alldone'))}</p>` : `<ol class="start-list">${items}</ol>`);
}
$('#start').addEventListener('click', (e) => {
  const id = e.target.closest('button')?.id;
  if (id === 'startAdd') songsDlg.showModal();
  if (id === 'startTry') tryExample();
  if (id === 'startOpen') { const s = song() || Object.values(state.songs).sort((x, y) => y.added - x.added)[0]; if (s) { state.current = s.id; save(); render(); showTab('song'); } }
  if (id === 'startHide') { startHidden = true; try { localStorage.setItem('ll_start_hide', '1'); } catch {} renderStart(); }
});

// ---------- chanson d'exemple : essayer sans rien chercher ----------
function tryExample() {
  if (songsDlg.open) songsDlg.close();
  const existing = Object.values(state.songs).find((x) => x.sample);
  if (existing) { state.current = existing.id; save(); render(); showTab('song'); return; }
  addSong({ title: SAMPLE_SONG.title, artist: SAMPLE_SONG.artist, url: '', lyrics: SAMPLE_SONG.lyrics, sample: true });
}
$('#homeTry').onclick = tryExample;
$('#heroTry').onclick = tryExample;
$('#dlgExample').onclick = tryExample;
$('#heroAdd').onclick = () => songsDlg.showModal();

// ---------- aide : schémas + bons réflexes ----------
const helpDlg = $('#helpDlg');
function buildHelp() {
  $('#helpBody').innerHTML = `<h3 class="ht">${esc(t('home.how'))}</h3>${howHtml(t)}
    <h3 class="ht">${esc(t('help.goal.t'))}</h3>${goalDiagramHtml(t)}
    <h3 class="ht">${esc(t('help.tips.t'))}</h3><ul class="tips">${[1, 2, 3, 4, 5].map((k) => `<li>${esc(t(`help.tip${k}`))}</li>`).join('')}</ul>
    <p id="helpNeed" class="status err" hidden>${esc(t('help.needSong'))}</p>`;
}
$('#helpBtn').onclick = () => { buildHelp(); helpDlg.showModal(); };
$('#helpX').onclick = () => helpDlg.close();
helpDlg.addEventListener('click', (e) => { if (e.target === helpDlg) helpDlg.close(); });
$('#helpTour').onclick = () => {
  if (!song()) { $('#helpNeed').hidden = false; return; }
  helpDlg.close(); showTab('song'); setTimeout(() => runTour(), 500);
};

// ---------- visite guidée au premier passage dans une chanson ----------
let tourSeen = false;
try { tourSeen = localStorage.getItem('ll_tour') === '1'; } catch {}
function runTour() {
  const steps = [
    { sel: '#lyrics .w', title: 'tour.1.t', desc: 'tour.1.d' },
    { sel: '#wordPanel', title: 'tour.2.t', desc: 'tour.2.d', skipNarrow: true, before: () => { const w = document.querySelector('#lyrics .w'); if (w && !popCtx) openPop(w.textContent, Number(w.dataset.l)); } },
    { sel: '#goalGrid', title: 'tour.3.t', desc: 'tour.3.d' },
    { sel: '#ptabs', title: 'tour.4.t', desc: 'tour.4.d' },
    { sel: '.lang', title: 'tour.5.t', desc: 'tour.5.d' }
  ].filter((s) => document.querySelector(s.sel));
  startTour({ t, steps, onClose: () => { tourSeen = true; try { localStorage.setItem('ll_tour', '1'); } catch {} closePop(); } });
}
function maybeTour() {
  if (tourSeen || isTourOpen()) return;
  setTimeout(() => {
    if (tourSeen || isTourOpen() || currentTab !== 'song' || !song() || document.querySelector('dialog[open]')) return;
    if (!document.querySelector('#lyrics .w')) return;
    runTour();
  }, 1400);
}
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

// ---------- lecteurs intégrés : Spotify, Apple Music, Deezer, YouTube, SoundCloud ----------
const HOSTS = { spotify: /(^|\.)spotify\.com$/, youtube: /(^|\.)(youtube\.com|youtu\.be)$/, soundcloud: /(^|\.)soundcloud\.com$/ };
function safeLink(u, kind) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) && HOSTS[kind].test(x.hostname) ? x.href : ''; } catch { return ''; }
}
const SERVICES = [['spotify', 'Spotify'], ['apple', 'Apple Music'], ['deezer', 'Deezer'], ['youtube', 'YouTube'], ['soundcloud', 'SoundCloud']];
const SVC_BY_NAME = { Spotify: 'spotify', 'Apple Music': 'apple', Deezer: 'deezer', YouTube: 'youtube', SoundCloud: 'soundcloud' };
let pref = '';
try { pref = localStorage.getItem('ll_pp') || ''; } catch {}

function migratePlayers(s) {
  if (!s.players) s.players = {};
  if (s.player) { // ancien format : un seul lecteur
    const k = SVC_BY_NAME[s.player.provider];
    if (k && !s.players[k]) s.players[k] = s.player;
    if (k && !s.playerPref) s.playerPref = k;
    delete s.player;
  }
}
// Ajoute un lecteur à partir d'un lien (toujours filtré par parsePlayer : seuls les 5 services sont acceptés).
function setPlayer(s, url, overwrite = false) {
  const p = parsePlayer(url); const k = p && SVC_BY_NAME[p.provider];
  if (!k) return '';
  if (!overwrite && s.players[k]) return k;
  s.players[k] = { ...p, url }; return k;
}
function pickPlayer(s) {
  if (s.playerPref && s.players[s.playerPref]) return;
  const have = SERVICES.map(([k]) => k).filter((k) => s.players[k]);
  s.playerPref = pref && s.players[pref] ? pref : (have[0] || '');
}
const renderIfCurrent = (s) => { if (state.current === s.id) renderPlayer(); };

// Retrouve le morceau sur chaque service : liens connus de Genius, puis recherche par titre et artiste.
async function loadMedia(s) {
  if (!s || s.finding) return;
  migratePlayers(s); s.finding = true; renderIfCurrent(s);
  try {
    if (s.gid) {
      try {
        const { media } = await api('/api/song-media?id=' + encodeURIComponent(s.gid));
        s.media = media || {};
        for (const kind of ['spotify', 'youtube', 'soundcloud']) { const u = safeLink(s.media[kind], kind); if (u) setPlayer(s, u); }
      } catch { /* pas bloquant */ }
    }
    if (s.title) {
      try {
        const { tracks } = await api(`/api/find-track?title=${encodeURIComponent(s.title)}&artist=${encodeURIComponent(s.artist || '')}`);
        for (const k of ['spotify', 'apple', 'deezer', 'youtube']) if (tracks?.[k]) setPlayer(s, tracks[k]);
      } catch { /* pas bloquant */ }
    }
    pickPlayer(s);
  } finally { s.finding = false; s.mediaLoaded = true; save(); renderIfCurrent(s); }
}
const ensureMedia = (s) => { if (s && !s.mediaLoaded && !s.finding) loadMedia(s); };

let frameKey = '', formKey = '', playerEditing = false;
const frameHeight = (p) => (/open\.spotify\.com\/embed\/track\//.test(p.src) ? 80 : p.h);
function renderPlayer() {
  const s = song(); if (!s) return;
  migratePlayers(s);
  const sel = s.playerPref && s.players[s.playerPref] ? s.playerPref : '';
  // onglets : peuvent être redessinés à tout moment sans toucher au lecteur
  $('#ptabs').innerHTML = `<span class="label">${esc(t('player.listenLabel'))}</span>`
    + SERVICES.map(([k, name]) => `<button type="button" class="ptab${sel === k ? ' on' : ''}" data-svc="${k}" ${s.players[k] ? '' : 'disabled'} title="${s.players[k] ? '' : esc(t('player.notFound'))}">${esc(name)}</button>`).join('')
    + (s.finding ? `<span class="small pfind">${esc(t('player.finding'))}</span>` : '')
    + `<span class="pspace"></span><button class="link" type="button" data-p="change">${esc(t('player.link'))}</button>`
    + (sel ? `<button class="link" type="button" data-p="remove">${esc(t('player.remove'))}</button>` : '');
  // lecteur : recréé seulement si le morceau change, pour ne pas couper la musique
  const p = sel && s.players[sel];
  const fk = `${s.id}|${p ? p.src : ''}${p ? '' : '|' + !!s.finding}|${getLang()}`;
  if (fk !== frameKey) {
    frameKey = fk;
    const h = p && frameHeight(p);
    $('#pframe').innerHTML = p
      ? `<iframe class="${p.kind === 'yt' ? 'yt' : ''}" src="${esc(p.src)}" ${h ? `height="${h}"` : ''} loading="lazy" referrerpolicy="strict-origin-when-cross-origin"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" allowfullscreen title="${esc(t('player.title'))} ${esc(p.provider)}"></iframe>
         <p class="pnote">${esc(t('player.note'))}</p>`
      : (s.finding ? '' : `<p class="pnote">${esc(t('player.none'))}</p>`);
  }
  // formulaire « coller un lien »
  const fm = playerEditing ? 'on' : 'off';
  if (fm !== formKey) {
    formKey = fm;
    $('#pform').innerHTML = playerEditing
      ? `<form id="playerForm"><input id="playerUrl" type="text" placeholder="${esc(t('player.ph'))}" required autocomplete="off">
          <button class="btn solid">${esc(t('player.addBtn'))}</button><button class="link" type="button" data-p="cancel">${esc(t('player.cancel'))}</button></form><p class="perr" id="playerErr" hidden></p>`
      : '';
    if (playerEditing) $('#playerUrl').focus();
  }
}
$('#player').addEventListener('click', (e) => {
  const s = song(); if (!s) return;
  const tab = e.target.closest('[data-svc]');
  if (tab && !tab.disabled) {
    s.playerPref = pref = tab.dataset.svc;
    try { localStorage.setItem('ll_pp', pref); } catch {}
    save(); renderPlayer(); return;
  }
  const a = e.target.closest('[data-p]'); if (!a) return;
  if (a.dataset.p === 'change') playerEditing = true;
  if (a.dataset.p === 'cancel') playerEditing = false;
  if (a.dataset.p === 'remove') { delete s.players[s.playerPref]; s.playerPref = ''; pickPlayer(s); save(); }
  renderPlayer();
});
$('#player').addEventListener('submit', (e) => {
  e.preventDefault();
  const s = song(); const url = $('#playerUrl').value.trim();
  const k = parsePlayer(url) && setPlayer(s, url, true);
  if (!k) { const er = $('#playerErr'); er.textContent = t('player.err'); er.hidden = false; return; }
  s.playerPref = pref = k; try { localStorage.setItem('ll_pp', pref); } catch {}
  playerEditing = false; save(); renderPlayer();
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
  if (!popCtx || !s) { pop.innerHTML = `<div class="label">${esc(t('panel.title'))}</div><p class="placeholder">${esc(t('panel.placeholder'))}</p>`; return; }
  const line = s.lines[popCtx.lineIdx] || { text: '' }, text = popCtx.text;
  const inLib = state.library.some((e) => norm(e.text) === norm(text));
  const inGoal = s.goal.words.some((g) => norm(g.word) === norm(text));
  const single = !/\s/.test(text.trim());
  pop.innerHTML = `<div class="label"><span>${esc(t('panel.title'))}</span><button id="pClose" aria-label="${esc(t('common.close'))}">✕</button></div>
    <div class="wordbig" dir="auto">${esc(text)}</div>
    <div class="wmeta">${popCtx.rm ? esc(popCtx.rm) : ''}</div>
    <p class="def">${popCtx.tr ? esc(popCtx.tr) : '<span class="dots">…</span>'}</p>
    ${popCtx.note ? `<p class="note"><b>${esc(t('panel.note'))}</b>${esc(popCtx.note)}</p>` : ''}
    <p class="ctx" dir="auto">“${esc(line.text)}”</p>
    ${line.tr ? `<p class="ctxtr">${esc(line.tr)}</p>` : ''}
    <div class="acts"><button class="btn solid" id="pSave" ${inLib ? 'disabled' : ''}>${inLib ? t('panel.saved') : t('panel.save')}</button>
      ${single ? `<button class="btn" id="pGoal">${inGoal ? t('panel.goalRemove') : t('panel.goalAdd')}</button>` : ''}</div>`;
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
  $('#libEmpty').innerHTML = libEmptyHtml(t);
  $('#libList').innerHTML = items.map((e) => `<li data-id="${e.id}">
    <span class="e"><bdi>${esc(e.text)}</bdi></span>
    <span class="m">${esc(e.tr)}<div class="s">${esc(e.title)}${e.artist ? ' · ' + esc(e.artist) : ''} · ${new Date(e.date).toLocaleDateString()}</div></span>
    <button data-del="${e.id}" title="${t('common.delete')}">✕</button></li>`).join('');
}
$('#libSearch').oninput = renderLibrary;
$('#libList').addEventListener('click', (e) => {
  const id = e.target.dataset.del; if (!id) return;
  state.library = state.library.filter((x) => x.id !== id); save(); hideTip(); render();
});
$('#export').onclick = () => {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = state.library.map((e) => [e.text, e.tr, e.sentence, e.sentenceTr, `${e.title} - ${e.artist}`].map(q).join(';')).join('\n');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: t('csv.name') });
  a.click(); URL.revokeObjectURL(a.href);
};

// ---------- info-bulle (source du mot) ----------
const tip = $('#tip');
function hideTip() { tip.hidden = true; }
function showTip(entry, x, y) {
  const hi = esc(entry.sentence).replace(esc(entry.text), (m) => `<mark>${m}</mark>`);
  const hl = hi.includes('<mark>') ? hi : esc(entry.sentence).replace(new RegExp(esc(entry.text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), (m) => `<mark>${m}</mark>`);
  tip.innerHTML = `<div class="src" dir="auto">“${hl}”</div>${entry.sentenceTr ? `<div class="meta">${esc(entry.sentenceTr)}</div>` : ''}
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
  if (name === 'song') { ensureMedia(song()); maybeTour(); } else endTour();
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
  if (!lyrics) { setStatus(t('imp.nothing'), true); return false; }
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
    title: t || $('#mTitle').value.trim() || name || t('common.untitled'),
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
  setStatus(live ? '' : t('search.searching'));
  try {
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    if (seq !== searchSeq) return; // une recherche plus récente a pris le relais
    if (r.needsToken) return setStatus(t('search.notConfigured'), true);
    renderHits(r.hits);
    setStatus(r.hits.length ? '' : t('search.none'), !r.hits.length);
  } catch (err) {
    if (seq === searchSeq) setStatus(err.message + t('search.fallback'), true);
  }
}

function openFromEmbedCode(q) {
  const emb = parseEmbedCode(q); if (!emb) return false;
  renderHits([]); $('#q').value = ''; setStatus('');
  openImport({ id: emb.id, title: emb.title, artist: emb.artist, url: emb.url || `https://genius.com/songs/${emb.id}`, thumb: '' });
  return true;
}
$('#searchForm').onsubmit = (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (openFromEmbedCode(q)) return;
  if (GENIUS_LINK.test(q)) { renderHits([]); return openImport({ title: slugToQuery(q), artist: '', url: q, thumb: '', guessed: true }); }
  if (hitIdx >= 0 && hitList[hitIdx]) return openImport(hitList[hitIdx]);
  runSearch(q, false);
};

let liveTimer;
$('#q').addEventListener('input', () => {
  clearTimeout(liveTimer);
  const q = $('#q').value.trim();
  if (openFromEmbedCode(q)) return;
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
  const label = [h.title, h.artist].filter(Boolean).join(' — ') || 'Genius';
  const hasEmbed = /^\d{1,12}$/.test(String(h.id || ''));
  const steps = `<ol>
      <li><div><button class="primary" id="dOpen">${esc(t('imp.openGenius'))}</button>
        <div class="muted small" style="margin-top:4px">${esc(t('imp.openNote'))}</div></div></li>
      <li><div>${esc(t('imp.step2'))} <kbd>${MOD}</kbd> + <kbd>A</kbd> ${esc(t('imp.then'))} <kbd>${MOD}</kbd> + <kbd>C</kbd>
        <div class="demo" aria-hidden="true"><div class="bar"><i></i><i></i><i></i></div>
          <div class="page"><span>אולי אולא, יהיה לי רע</span><span>יהיה לי טוב</span><span>הכל יכול לקרות</span><div class="sel"></div><div class="toast">${esc(t('imp.copied'))}</div></div>
          <div class="keys"><kbd>${MOD} A</kbd><kbd>${MOD} C</kbd></div></div></div></li>
      <li><div id="dState">${esc(t('imp.step3'))}
        <div style="margin-top:8px"><button class="secondary" id="dPaste">${esc(t('imp.paste'))}</button></div></div></li>
    </ol>`;
  dlg.innerHTML = `<button class="x" id="dX" aria-label="${esc(t('common.close'))}">✕</button>
    <div class="label">${esc(t('imp.step'))}</div>
    <h2 dir="auto">${esc(label)} <a class="gbadge" href="${esc(h.url)}" target="_blank" rel="noopener" title="${esc(t('imp.openOn'))}"><img src="genius-logo.svg" alt="Genius"></a></h2>
    ${hasEmbed ? `<p class="helper">${esc(t('imp.helper'))}</p>
      <div class="embedbox"><iframe id="embedFrame" title="${esc(t('imp.previewSub'))}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe></div>
      <div id="embedState" class="small">${esc(t('imp.previewLoading'))}</div>
      <div class="acts"><button class="btn solid" id="dImport" type="button" disabled>${esc(t('imp.importThese'))}</button></div>` : `<div class="muted small">${esc(t('imp.sub'))}</div>`}
    <details id="dManual" ${hasEmbed ? '' : 'open'}><summary>${esc(t('imp.orCopy'))}</summary>${steps}</details>`;

  const state$ = () => $('#dState');
  let popup = null, done = false, embedText = '', timer = null;
  const finish = async (raw) => {
    if (done) return; done = true;
    const box = $('#embedState') || state$();
    box.innerHTML = `<span class="ok">${esc(t('imp.found'))}</span>`;
    if (await useText(raw, h)) { stop(); dlg.close(); if (popup && !popup.closed) popup.close(); } else done = false;
  };
  const tryClipboard = async (auto) => {
    try {
      const txt = await navigator.clipboard.readText();
      const looksRight = norm(txt).includes(norm(h.title)) && txt.length > 60;
      if (looksRight || (!auto && txt.trim())) return finish(txt);
      if (!auto) state$().insertAdjacentHTML('beforeend', `<div class="status err">${esc(t('imp.noLyrics'))}</div>`);
    } catch { if (!auto) state$().insertAdjacentHTML('beforeend', `<div class="status err">${esc(t('imp.denied'))}</div>`); }
  };
  const onFocus = () => setTimeout(() => tryClipboard(true), 250);

  // aperçu Genius : le cadre isolé renvoie le texte affiché par l'embed officiel
  const previewFail = () => { const e = $('#embedState'); if (e && !embedText) { e.textContent = t('imp.previewFail'); const d = $('#dManual'); if (d) d.open = true; } };
  const onMsg = (ev) => {
    const f = $('#embedFrame');
    if (!f || ev.source !== f.contentWindow || !ev.data || ev.data.llEmbed !== true || String(ev.data.id) !== String(h.id)) return;
    clearTimeout(timer);
    const cleaned = cleanEmbedText(String(ev.data.text || '').slice(0, 60000));
    if (cleaned.length < 60) return previewFail();
    embedText = cleaned;
    $('#embedState').textContent = t('imp.previewReady', { n: cleaned.split('\n').filter((x) => x.trim() && !/^\[.*\]$/.test(x.trim())).length });
    $('#dImport').disabled = false;
  };
  const stop = () => { window.removeEventListener('focus', onFocus); window.removeEventListener('message', onMsg); clearInterval(watcher); clearTimeout(timer); };

  if (hasEmbed) {
    window.addEventListener('message', onMsg);
    $('#embedFrame').srcdoc = embedSrcdoc(h.id);
    $('#dImport').onclick = () => finish(embedText);
    timer = setTimeout(previewFail, 12000);
  }
  $('#dOpen').onclick = () => {
    popup = window.open(h.url, 'genius', 'width=980,height=820');
    if (!popup) state$().insertAdjacentHTML('afterbegin', `<div class="status err">${esc(t('imp.blockedPre'))}<a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(t('imp.blockedLink'))}</a>${esc(t('imp.blockedPost'))}</div>`);
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
  if (!lyrics) return setStatus(t('manual.empty'), true);
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
applyStatic();
drawPanel();
render();
showTab('home');
document.querySelectorAll('[data-lang]').forEach((b) => b.onclick = () => {
  setLang(b.dataset.lang);
  frameKey = ''; formKey = '';          // reconstruit le lecteur avec les nouveaux libellés
  render(); renderHome(); drawPanel();
  if (helpDlg.open) buildHelp();
});
