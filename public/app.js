import { t, getLang, setLang, applyStatic } from './i18n.js';
import { parseEmbedCode, embedSrcdoc, cleanEmbedText } from './embed.js';
import { initDemo } from './demo.js';
import * as spot from './spotify.js';
import { pickWords, makeChoice, checkTyped, review, masteredCount, usable, XP_PER_OK, XP_PERFECT } from './game.js';
import { birdSvg, birdXp, birdLevel, BIRD_STAGES } from './bird.js';
import { alignLines, locate, canSync, attachPlayer, attachSpotify } from './sync.js';
import { normLang, guessScript, flagOf, langName } from './langs.js';
import { howHtml, libEmptyHtml, startTour, endTour, isTourOpen } from './guide.js';
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
function toast(msg) {
  const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = msg;
  document.body.append(el); setTimeout(() => el.classList.add('out'), 4200); setTimeout(() => el.remove(), 4700);
}
const setStatus = (m, err) => { const s = $('#status'); s.textContent = m; s.classList.toggle('err', !!err); };

// ---------- langues ----------
const LANGS_NAME = (c) => document.querySelector(`#target option[value="${c}"]`)?.textContent || c;
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

let pendingPlayer = '';
const okCover = (u) => typeof u === 'string' && /^https:\/\/[\w.-]+\/[^\s'"()]+$/.test(u);
// pochettes des chansons déjà enregistrées : retrouvées une seule fois via la recherche Genius
let coverBusy = false;
async function ensureCovers() {
  if (coverBusy) return; coverBusy = true;
  try {
    let changed = false;
    for (const x of Object.values(state.songs)) {
      if (x.cover !== undefined || x.sample || !x.title) continue;
      try {
        const f = await api('/api/search?q=' + encodeURIComponent([x.artist, x.title].filter(Boolean).join(' ')));
        if (f.needsToken) break;
        const flat = (v) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        const hit = (f.hits || []).find((h) => flat(h.title) === flat(x.title)) || (f.hits || [])[0];
        x.cover = hit && okCover(hit.thumb) ? hit.thumb : ''; changed = true;
      } catch { break; }
    }
    if (changed) { save(); renderHome(); }
  } finally { coverBusy = false; }
}
async function addSong({ title, artist, url, lyrics, gid, sample, example, cover }) {
  const lines = lyrics.split('\n').map((text) => ({ text: text.trimEnd() }));
  const id = (url || `${artist}-${title}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80) + '-' + Date.now().toString(36);
  state.songs[id] = { id, title, artist, url: url || '', gid: gid || '', sample: !!sample, example: !!example, cover: okCover(cover) ? cover : undefined, lines, target: state.target, source: 'auto', goal: { size: 8, words: [] }, added: Date.now() };
  if (pendingPlayer && !sample) { state.songs[id].players = state.songs[id].players || {}; const k = setPlayer(state.songs[id], pendingPlayer, true); if (k && MAIN_SERVICES.includes(k) && (k !== 'spotify' || spot.isConnected() || spotifyId)) state.songs[id].playerPref = k; }
  pendingPlayer = '';
  state.current = id;
  save();
  $('#hits').innerHTML = ''; $('#q').value = ''; setStatus('');
  if (songsDlg.open) songsDlg.close();
  showTab('song');
  translateSong(); // en arrière-plan
  if (!sample) loadMedia(state.songs[id]); // liens d'écoute connus de Genius : la chanson s'affiche tout de suite
}

let geminiOn = false, spotifyId = '', spBad = '';

async function translateSong() {
  const s = song(); if (!s) return;
  const idx = s.lines.map((l, i) => (lineKind(l.text) === 'line' ? i : -1)).filter((i) => i >= 0);
  const all = idx.map((i) => s.lines[i].text);
  const CHUNK = 80, chunks = []; // peu de requêtes : une chanson tient en 1 ou 2 lots
  for (let i = 0; i < idx.length; i += CHUNK) chunks.push(idx.slice(i, i + CHUNK));
  const myTarget = state.target;
  s.lines.forEach((l) => { l.smart = false; });
  s.words = {}; s.wordsTarget = ''; s.engine = ''; s.warn = ''; s.translating = true;
  // les mots de l'objectif déjà traduits dans une autre langue sont retraduits dans la langue choisie
  s.goal.words.forEach((w) => { if (w.trLang !== myTarget) { w.tr = ''; w.note = ''; } });
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
            if (!x || !x.text) return; // ligne échouée : on garde l'existant
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
  await fastDone;
  // relance une fois les vers restés sans traduction (service momentanément saturé)
  const missing = idx.filter((i) => !s.lines[i].tr);
  if (missing.length && state.target === myTarget) {
    await new Promise((r) => setTimeout(r, 2500));
    chunks.length = 0;
    for (let i = 0; i < missing.length; i += CHUNK) chunks.push(missing.slice(i, i + CHUNK));
    await run(true);
    if (idx.some((i) => !s.lines[i].tr)) s.warn = s.warn || 'Some lines could not be translated. Click Translate again to retry.';
  }
  s.engine = engines.has('gemini') ? (engines.size > 1 ? 'mixed' : 'gemini') : engines.has('deepl') ? (engines.has('google') ? 'mixed' : 'deepl') : 'google';
  if (geminiOn && state.target === myTarget) prefetchWords(s, myTarget); // sans attendre la fin du lot rapide
  await fastDone;
  s.target = myTarget; s.translating = false;
  save(); if (state.current === s.id) render();
  try { await translateGoal(); save(); if (state.current === s.id) renderGoal(); } catch (e) { setStatus(e.message, true); }
}

// Précharge la traduction contextuelle de tous les mots : un clic est ensuite instantané.
async function prefetchWords(s, target) {
  const seen = new Map();
  for (const l of s.lines) if (lineKind(l.text) === 'line') for (const m of l.text.matchAll(WORD_RE)) {
    const n = norm(m[0]);
    if (!seen.has(n) && [...n].length >= 2 && !/^\d+$/.test(n)) seen.set(n, { text: m[0], context: l.text });
  }
  const entries = [...seen], CH = 200, parts = [];
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
  s.words = words; s.wordsTarget = target;
  for (const w of s.goal.words) { const x = words[norm(w.word)]; if (x?.text) { w.tr = x.text; w.trLang = s.wordsTarget || state.target; w.note = x.note || w.note || ''; } }
  save(); if (state.current === s.id) renderGoal();
}

// Enregistre un mot dans la bibliothèque avec sa traduction (dans la langue choisie) et la phrase d'où il vient
function saveWord(s, text, tr, rm, lang, line) {
  const l = line || s.lines.find((x) => [...x.text.matchAll(WORD_RE)].some((m) => norm(m[0]) === norm(text))) || { text: '', tr: '' };
  state.library.unshift({ id: crypto.randomUUID(), text, tr, rm: rm || '', lang, src: normLang(s.source) || guessScript(text) || guessScript(l.text), sentence: l.text, sentenceTr: l.tr || '', title: s.title, artist: s.artist, url: s.url, date: Date.now() });
}
function ctxFor(word) {
  const n = norm(word);
  const l = song().lines.find((x) => [...x.text.matchAll(WORD_RE)].some((m) => norm(m[0]) === n));
  return l ? l.text : '';
}

// Mots de l'objectif traduits dans une autre langue que celle choisie (ancienne langue, ancienne version) : retraduits une fois
function fixGoalLang(s) {
  if (!s || s.translating || s.goalFix === state.target || !s.goal.words.some((w) => w.trLang !== state.target)) return;
  s.goalFix = state.target;
  s.goal.words.forEach((w) => { if (w.trLang !== state.target) { w.tr = ''; w.note = ''; } });
  renderGoal();
  translateGoal().then(save);
}
async function translateGoal() {
  const s = song(); if (!s || !s.goal.words.length) return;
  const target = state.target;
  const items = s.goal.words.map((w) => ({ text: w.word, context: ctxFor(w.word) }));
  try {
    const { results } = await api('/api/translate-words', { items, target, source: s.source, fast: true });
    if (state.target !== target) return;
    results.forEach((r, i) => { const w = s.goal.words[i]; if (w && w.word === items[i].text && r && r.text && (!w.tr || w.trLang !== target)) { w.tr = r.text; w.trLang = target; w.note = r.note || w.note || ''; } });
    if (state.current === s.id) renderGoal();
  } catch { /* les traductions contextuelles du préchargement prendront le relais */ }
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
  syncLangPicker();
  if (currentTab === 'home') renderHome();
  const s = song();
  $('#empty').hidden = !!s; $('#songView').hidden = !s; $('#goalSide').hidden = !s;
  $('#songTab').classList.toggle('nosong', !s);
  if (!s) { popCtx = null; activeLine = null; return; }
  $('#tip1').hidden = tipSeen;
  $('#sTitle').textContent = s.title;
  $('#sArtist').textContent = [t('kicker.now'), s.artist].filter(Boolean).join(' / ');
  $('#trLoad').hidden = !s.translating;
  $('#trLoadT').textContent = t('tr.loading', { lang: LANGS_NAME(state.target) });
  syncTargetGo();
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
  syncEl = null; syncIdx = -1; syncWord = -2; syncWords = null;
  renderPlayer();
  renderGoal();
  fixGoalLang(s);
  checkBird();
  if (s.sync && s.sync.times && (syncPlaying || syncPos)) syncFrame();
}

function migrateGoal(s) {
  if (s.goalV === 3) return;
  s.goalV = 3; s.goalAuto = true;
  s.goal.words = s.goal.words.filter((w) => w.done || w.manual);
  save();
}
const goalSize = (s) => Math.min(30, Math.max(3, Number(s.goal.size) || 8));

function renderGoal() {
  const s = song(); migrateGoal(s); const ws = s.goal.words;
  const n = goalSize(s); s.goal.size = n;
  const done = ws.filter((w) => w.done).length;
  const has = ws.length > 0, win = has && done === ws.length;
  $('#goalEmpty').hidden = has; $('#goalHelp').hidden = !has; $('#goalGrid').hidden = !has; $('.goalbox .progress').hidden = !has;
  $('#goalFoot').hidden = !has; $('#goalWin').hidden = !win; $('.goalbox .quizrow').hidden = !has;
  $('#bar').style.width = has ? `${(done / ws.length) * 100}%` : '0';
  $('#progText').textContent = has ? t('goal.learned', { done, n: ws.length }) : '';
  const stepper = (cls = '') => `<span class="stepper ${cls}" role="group" aria-label="${esc(t('goal.count'))}"><button type="button" data-gs="-1" aria-label="−1">−</button><b>${n}</b><button type="button" data-gs="1" aria-label="+1">+</button></span>`;
  if (!has) {
    $('#goalEmpty').innerHTML = `<h3>${esc(t('goal.empty.t'))}</h3>
      <ol class="gsteps">
        <li><i>1</i><div><span>${esc(t('goal.s1'))}</span> ${stepper()}</div></li>
        <li><i>2</i><div><button class="btn solid" type="button" data-act="suggest">✨ ${esc(t('goal.suggestN', { n }))}</button><small>${esc(t('goal.s2b'))}</small></div></li>
        <li><i>3</i><div><span>${esc(t('goal.s3'))}</span></div></li>
      </ol>
      <p class="gtip">✓ ${esc(t('goal.then'))}</p>`;
  } else {
    const savedSet = new Set(state.library.map((e) => norm(e.text)));
    $('#goalGrid').innerHTML = ws.map((w, i) => `<div class="cell${w.done ? ' done' : ''}" data-i="${i}" role="checkbox" aria-checked="${!!w.done}" tabindex="0" title="${esc(w.note || t('goal.tick'))}">
      <i class="tick" aria-hidden="true">✓</i><button class="sv${savedSet.has(norm(w.word)) ? ' on' : ''}" data-sv="${i}" ${w.tr ? '' : 'disabled'} title="${esc(savedSet.has(norm(w.word)) ? t('goal.unsave') : t('goal.save'))}" aria-label="${esc(t('goal.save'))}" aria-pressed="${savedSet.has(norm(w.word))}">${savedSet.has(norm(w.word)) ? '★' : '☆'}</button><button class="rm" data-rm="${i}" aria-label="${t('common.remove')}">✕</button>
      <b class="cw"><bdi>${esc(w.word)}</bdi></b><span class="ct">${esc(w.tr || '…')}</span></div>`).join('');
    $('#goalWin').innerHTML = `${birdSvg(birdLevel(birdXp(state)).stage, 44)}<b>${esc(t('goal.win', { n: ws.length }))}</b> <button class="btn sm" type="button" data-svall="1">☆ ${esc(t('goal.saveAll'))}</button>`;
    $('#goalFoot').innerHTML = `<label>${esc(t('goal.size'))} ${stepper('sm')}</label><button class="btn" type="button" data-act="suggest">✨ ${esc(t('goal.moreN'))}</button>`;
  }
  $('#goalSide').classList.toggle('quiz', $('#quiz').checked);
}

function renderSongList() {
  const list = Object.values(state.songs).sort((a, b) => b.added - a.added);
  $('#songList').innerHTML = list.length ? list.map((s) => `<li data-id="${s.id}" class="${s.id === state.current ? 'on' : ''}">
    <span><b>${esc(s.title)}</b><small>${esc(s.artist)}</small></span><button data-del="${s.id}" title="${t('common.delete')}" aria-label="${t('common.delete')}">✕</button></li>`).join('')
    : `<li class="small">${t('songs.empty')}</li>`;
}

// ---------- accueil ----------

// ---------- Lyrio, l'oiseau : il grandit avec votre progression ----------
const birdName = (i) => t('bird.' + BIRD_STAGES[i].id);
function renderBird() {
  const el = $('#birdCard'); if (!el) return;
  const lv = birdLevel(birdXp(state));
  const stages = BIRD_STAGES.map((b, i) => `<span class="bs${i <= lv.stage ? ' on' : ''}${i === lv.stage ? ' now' : ''}" title="${esc(birdName(i))} · ${b.at} XP">${birdSvg(i, 40)}<small>${esc(birdName(i))}</small></span>`).join('<i class="bsep" aria-hidden="true">›</i>');
  el.innerHTML = `<div class="bc-art">${birdSvg(lv.stage, 132)}</div>
    <div class="bc-main">
      <div class="label">${esc(t('bird.title'))}</div>
      <h3>${esc(birdName(lv.stage))} <span class="bc-xp">${lv.xp} XP</span></h3>
      <div class="bc-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(lv.progress * 100)}"><i style="width:${Math.round(lv.progress * 100)}%"></i></div>
      <p class="bc-next">${lv.next != null ? esc(t('bird.next', { name: birdName(lv.next), n: lv.need })) : esc(t('bird.max'))}</p>
      <div class="bc-stages">${stages}</div>
      ${state.library.length ? `<button type="button" class="btn solid sm play-open">🎮 ${esc(t('play.evolve'))}</button>` : ''}
      <small class="bc-how">${esc(t('bird.how'))}</small>
    </div>`;
}
// un mot cherché compte une seule fois par chanson (pas de points à répéter le même clic)
function countLookup(s, text) {
  const n = norm(text); s.looked = s.looked || {};
  if (s.looked[n]) return; s.looked[n] = 1; state.lookups = (state.lookups || 0) + 1; save();
}
// Célébration quand l'oiseau passe au niveau suivant (jamais pour un utilisateur existant lors de la mise à jour : on mémorise son niveau actuel)
function checkBird() {
  const lv = birdLevel(birdXp(state));
  if (state.birdStage === undefined) { state.birdStage = lv.stage; save(); return; }
  if (lv.stage > state.birdStage && !document.querySelector('dialog[open]')) {
    state.birdStage = lv.stage; save();
    const box = document.createElement('div'); box.className = 'evo'; box.setAttribute('role', 'status');
    box.innerHTML = `<div class="evo-card"><div class="evo-bird">${birdSvg(lv.stage, 150)}</div><b>${esc(t('bird.evolved'))}</b><span>${esc(birdName(lv.stage))}</span><div class="evo-conf" aria-hidden="true">${'🎉✨🎶⭐'.repeat(3).split('').map((c, i) => `<i style="--i:${i}">${c}</i>`).join('')}</div></div>`;
    box.onclick = () => box.remove(); document.body.append(box); setTimeout(() => box.remove(), 5200);
    renderBird();
  }
}

function renderHome() {
  const songs = Object.values(state.songs).sort((a, b) => b.added - a.added);
  const learned = songs.reduce((n, x) => n + x.goal.words.filter((w) => w.done).length, 0);
  $('#stats').innerHTML = [[songs.length, songs.length === 1 ? t('stat.song') : t('stat.songs')], [state.library.length, t('stat.saved')], [learned, t('stat.learned')]]
    .map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');
  $('#homeResume').hidden = !song();
  { const hint = document.querySelector('.cta-hint'); if (hint) hint.hidden = !!song() || songs.length > 0; } // l'indication « Commencez ici » ne sert qu'au tout début
  $('#stats').hidden = !songs.length;
  $('#homeSongs').closest('.hblock').hidden = !songs.length;
  $('#how').innerHTML = howHtml(t);
  renderBird(); checkBird();
  renderStart();
  $('#homeSongs').innerHTML = songs.map((x) => {
    const done = x.goal.words.filter((w) => w.done).length, tot = x.goal.words.length;
    return `<div class="card${okCover(x.cover) ? ' has-cover' : ''}" data-id="${x.id}" role="button" tabindex="0"${okCover(x.cover) ? ` style="--cover:url('${esc(x.cover)}')"` : ''}>
      <button class="del" data-del="${x.id}" aria-label="${t('common.delete')}">✕</button>
      <div><div class="ct1">${normLang(x.source) ? flagHtml(normLang(x.source)) + ' ' : ''}${esc(x.artist || t('common.song'))}</div><h3 dir="auto">${esc(x.title)}</h3></div>
      <div><div class="mini"><span>${tot ? t('card.progress', { done, tot }) : t('card.nogoal')}</span><span>${esc(x.id === state.current ? t('card.current') : '')}</span></div>
        <div class="minibar"><i style="width:${tot ? (done / tot) * 100 : 0}%"></i></div></div></div>`;
  }).join('') + '<button class="card new" id="homeNew" type="button"><span>+</span><small>' + t('card.new') + '</small></button>';
  ensureCovers();
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
      ? `<div class="start-cta"><button class="btn solid" id="startAdd" type="button">${esc(t('home.cta'))}</button></div>`
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
  if (id === 'startOpen') { const s = song() || Object.values(state.songs).sort((x, y) => y.added - x.added)[0]; if (s) { state.current = s.id; save(); render(); showTab('song'); } }
  if (id === 'startHide') { startHidden = true; try { localStorage.setItem('ll_start_hide', '1'); } catch {} renderStart(); }
});

$('#heroAdd').onclick = () => songsDlg.showModal();

// ---------- aide : schémas + bons réflexes ----------
const helpDlg = $('#helpDlg');
function buildHelp() {
  $('#helpBody').innerHTML = `<h3 class="ht">${esc(t('home.how'))}</h3>${howHtml(t)}
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
    { sel: '#goalBox', title: 'tour.3.t', desc: 'tour.3.d' },
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
const MAIN_SERVICES = ['youtube', 'spotify', 'soundcloud'];
function visibleServices(s) {
  const main = MAIN_SERVICES.filter((k) => s.players[k]);
  return main.length ? main : SERVICES.map(([k]) => k).filter((k) => s.players[k]);
}
function pickPlayer(s) {
  // un lecteur Apple Music / Deezer mémorisé avant la simplification est remplacé par YouTube quand il existe
  if (s.playerPref && !MAIN_SERVICES.includes(s.playerPref) && MAIN_SERVICES.some((k) => s.players[k])) s.playerPref = '';
  if (s.playerPref && s.players[s.playerPref]) return;
  const have = ['youtube', 'soundcloud', 'spotify', 'deezer', 'apple'].filter((k) => s.players[k]);
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
        s.ytAlts = Array.isArray(tracks?.youtubeAlts) ? tracks.youtubeAlts : [];
        s.ytSecs = tracks?.youtubeSecs || {};
      } catch { /* pas bloquant */ }
    }
    pickPlayer(s);
  } finally { s.finding = false; s.mediaLoaded = true; s.mediaV = 3; save(); chooseVideo(s); renderIfCurrent(s); renderSyncBar(s); }
}
const ensureMedia = (s) => { if (s && (!s.mediaLoaded || s.mediaV !== 3) && !s.finding) loadMedia(s); };

// ---------- surlignage synchronisé avec la musique (mot à mot) ----------
let playerCtl = null, syncStop = null, syncPos = 0, syncAt = 0, syncPlaying = false, syncRaf = 0, syncIdx = -1, syncEl = null, syncWord = -2, syncWords = null;
let follow = true; try { follow = localStorage.getItem('ll_follow') !== '0'; } catch {}
function stopSync() { try { syncStop && syncStop(); } catch {} syncStop = null; playerCtl = null; setTimeout(nowRender, 0); playerSeen = false; playerPreview = false; if (!manualOn) { syncPlaying = false; cancelAnimationFrame(syncRaf); syncRaf = 0; } clearPlaying(); }
function clearPlaying() {
  if (syncEl) { syncEl.classList.remove('playing'); syncEl.querySelectorAll('.w.sung,.w.now').forEach((w) => { w.classList.remove('sung', 'now'); w.style.removeProperty('--wp'); }); }
  syncEl = null; syncIdx = -1; syncWord = -2; syncWords = null;
}
// Le minutage ne vaut que pour UN montage du morceau. On choisit la vidéo dont la durée correspond à une version du minutage
// (idéalement mot à mot) : c'est ce qui garantit que les paroles tombent au bon endroit.
function chooseVideo(s) {
  if (!s || !s.sync || !s.sync.versions || !s.sync.versions.length || !s.ytSecs) return;
  const urls = [s.players.youtube && s.players.youtube.url, ...(s.ytAlts || [])].filter(Boolean).filter((u, i, a) => a.indexOf(u) === i && s.ytSecs[u] && !(s.ytBad || []).includes(u));
  let best = null;
  for (const u of urls) for (const v of s.sync.versions) {
    const delta = Math.abs(s.ytSecs[u] - v.d);
    if (delta > 2.5) continue;
    const cost = delta - (v.ws ? 1.2 : 0);
    if (!best || cost < best.cost) best = { u, v, cost, delta };
  }
  if (!best) { s.syncMatch = false; return; }
  s.syncMatch = true;
  const cur = s.players.youtube && s.players.youtube.url;
  if (best.u !== cur) { setPlayer(s, best.u, true); if (s.playerPref === 'youtube') renderIfCurrent(s); }
  if (!s.sync.dur || Math.abs(s.sync.dur - best.v.d) > 0.15) { s.syncD = best.v.d; s.sync = undefined; ensureSync(s); }
  save();
}
// Vidéo YouTube injouable ici (région, intégration refusée, supprimée) : on passe automatiquement à la suivante
function youtubeFailed() {
  const s = song(); if (!s || !s.players.youtube) return;
  const bad = (s.ytBad = s.ytBad || []); const cur = s.players.youtube.url; bad.push(cur);
  chooseVideo(s); // d'abord une vidéo restante dont la durée correspond au minutage
  if (s.players.youtube.url !== cur) { save(); renderPlayer(); return; }
  const alt = (s.ytAlts || []).find((u) => !bad.includes(u));
  if (alt) { setPlayer(s, alt, true); save(); renderPlayer(); }
  else { s.ytDead = true; save(); renderSyncBar(s); }
}
let manualOn = false, manualSong = '', playerSeen = false, playerPreview = false, syncKnownDur = 0;
// positions envoyées par le lecteur (Spotify, YouTube, SoundCloud)
function onTick(pos, playing, dur) {
  if (dur > 30) syncKnownDur = dur;
  if (window.__syncDebug) console.log('[sync] position', pos.toFixed(1), playing ? 'play' : 'pause', 'durée', dur);
  const s0 = song();
  if (manualOn && s0 && manualSong === s0.id) return; // mode manuel : l'horloge interne prend le relais
  // Spotify non connecté : lecture d'un extrait de 30 s dont la position ne correspond pas à celle de la chanson
  const prev = !!(dur && dur < 45 && s0 && s0.sync && s0.sync.dur > 90);
  if (!playerSeen || prev !== playerPreview) {
    playerSeen = true; playerPreview = prev;
    // extrait de 30 s : on passe tout seul à YouTube s'il existe (une seule fois par chanson)
    if (prev && s0 && s0.players.youtube && s0.playerPref === 'spotify' && !s0.spSwitched) {
      s0.spSwitched = true; s0.playerPref = pref = 'youtube'; save(); toast(t('sp.autoYt')); renderPlayer(); return;
    }
    if (s0) renderSyncBar(s0);
  }
  feed(pos, playing, dur);
}
// Avance globale (par appareil) : les horaires des paroles marquent le DÉBUT du vers et les lecteurs annoncent leur position avec un léger retard ;
// surligner un peu en avance donne l'impression d'être pile en rythme. Réglable une fois pour toutes dans le mode karaoké.
let lead = 0.3; try { const v = localStorage.getItem('ll_lead'); if (v != null && v !== '' && !Number.isNaN(Number(v))) lead = Number(v); } catch { /* valeur par défaut */ }
const setLead = (v) => { lead = Math.round(Math.max(-1, Math.min(1.5, v)) * 20) / 20; try { localStorage.setItem('ll_lead', String(lead)); } catch { /* rien */ } };
const effOff = (s) => getOff(s) + lead;
const offKey = (s) => { const p = s.players && s.players[s.playerPref]; return p ? p.src : ''; };
const getOff = (s) => { const o = (s.syncOffs || {})[offKey(s)]; return o != null ? o : 0; };
const setOff = (s, v) => { s.syncOffs = s.syncOffs || {}; s.syncOffs[offKey(s)] = Math.round(v * 10) / 10; };
let syncCorr = 0, syncCorrAt = 0;
function feed(pos, playing, dur) {
  if (kara.open) setTimeout(() => karaCtl(playing), 0);
  if (playing && wordPaused && Date.now() - wordPausedAt > 1500) { wordPaused = false; clearPicked(); if (popCtx) drawPanel(); }
  setTimeout(nowRender, 0);
  if (study.open) {
    if (study.listenUntil != null && playing && pos >= study.listenUntil) { study.listenUntil = null; try { playerCtl && playerCtl.pause(); } catch {} }
    studyMusicRender(playing);
  }
  // lissage : un petit écart entre l'horloge interne et la position annoncée est résorbé en 0,4 s au lieu de provoquer un saut
  const pred = currentPos(), diff = syncPlaying && playing ? pred - pos : 0;
  syncCorr = Math.abs(diff) < 0.5 ? diff : 0; syncCorrAt = performance.now();
  syncPos = pos; syncAt = performance.now(); syncPlaying = playing;
  const s = song();
  // la version du minutage doit avoir la même durée que le morceau joué : sinon on en cherche une autre
  if (s && dur > 30 && s.sync && s.sync.v === 2 && s.sync.playerDur !== dur && !(playerPreview)) { s.sync.playerDur = dur; renderSyncBar(s); }
  if (s && dur > 30 && s.sync && s.sync.v === 2 && !s.sync.durChecked) {
    s.sync.durChecked = true;
    if (s.sync.dur && Math.abs(s.sync.dur - dur) > 2.5) { s.syncD = Math.round(dur); s.sync = undefined; ensureSync(s).then(() => { if (s.sync && s.sync.v === 2) s.sync.playerDur = dur; }); }
  }
  if (playing && !syncRaf) syncRaf = requestAnimationFrame(syncFrame);
  else if (!playing) syncFrame(); // pause ou déplacement du curseur : on met à jour une fois
}
const currentPos = () => syncPos + (syncPlaying ? (performance.now() - syncAt) / 1000 : 0) + syncCorr * Math.max(0, 1 - (performance.now() - syncCorrAt) / 400);
function syncFrame() {
  syncRaf = 0;
  const s = song(); if (!s || !s.sync || !s.sync.times || s.sync.v !== 2) return;
  let loc; try { loc = locate(s.sync, currentPos() + effOff(s)); } catch { return; }
  if (kara.open) karaUpdate(s, loc);
  if (loc.i !== syncIdx || !syncEl || !syncEl.isConnected) {
    clearPlaying(); syncIdx = loc.i;
    if (study.open && study.follow && loc.i >= 0) studyGoLine(loc.i);
    syncEl = loc.i >= 0 ? document.querySelector(`#lyrics .ln[data-i="${loc.i}"]`) : null;
    if (syncEl) { syncEl.classList.add('playing'); syncWords = syncEl.querySelectorAll('.w'); if (follow && syncPlaying) syncEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
  const exactLine = loc.i >= 0 && s.sync.exact && s.sync.exact[loc.i];
  if (syncEl) { syncEl.classList.toggle('approx', !exactLine); if (!exactLine) syncEl.style.setProperty('--lp', `${Math.round(loc.line * 100)}%`); }
  if (syncEl && syncWords && exactLine) {
    if (loc.k !== syncWord) {
      syncWords.forEach((w, m) => { w.classList.toggle('sung', m < loc.k); w.classList.toggle('now', m === loc.k); if (m !== loc.k) w.style.removeProperty('--wp'); });
      syncWord = loc.k;
    }
    if (loc.k >= 0 && syncWords[loc.k]) syncWords[loc.k].style.setProperty('--wp', `${Math.round(loc.p * 100)}%`);
  }
  if (syncPlaying) syncRaf = requestAnimationFrame(syncFrame);
}
async function ensureSync(s) {
  if (!s || s.syncing || !s.title) return;
  // anciens minutages (format précédent) ou « introuvable » datant de plus de 10 min : on recommence
  if (s.sync && (s.sync.none ? Date.now() - (s.sync.at || 0) > 600000 : s.sync.v !== 2)) s.sync = undefined;
  if (s.sync) return;
  s.syncing = true;
  try {
    const r = await api(`/api/synced?title=${encodeURIComponent(s.title)}&artist=${encodeURIComponent(s.artist || '')}${s.syncD ? `&d=${s.syncD}` : ''}`);
    const texts = s.lines.map((l) => (lineKind(l.text) === 'line' ? l.text : null));
    const n = texts.filter((x) => x != null).length;
    const al = r.lines && r.lines.length ? alignLines(texts, r.lines) : null;
    s.sync = al && al.matched >= Math.max(3, n * 0.3)
      ? { v: 2, versions: r.versions || [], times: al.times, ends: al.ends, words: al.words, exact: al.exact, exactLines: al.exactLines, total: al.matched, dur: r.duration || 0, wordSync: !!r.wordSync, durChecked: !!s.syncD }
      : { none: true, at: Date.now(), found: (r.lines || []).length, matched: al ? al.matched : 0, n };
  } catch { s.sync = { none: true, at: Date.now() }; }
  finally { s.syncing = false; save(); chooseVideo(s); if (state.current === s.id) renderSyncBar(s); }
}
let fixOpen = false;
// Barre discrète sous le lecteur : elle n'apparaît que si le suivi de la musique est possible, sans aucun réglage technique en avant.
function renderSyncBar(s, p) {
  const bar = $('#syncBar'); if (!bar) return;
  if (!p) p = s.playerPref && s.players[s.playerPref];
  const ready = !!(p && s.sync && s.sync.v === 2 && s.sync.times && canSync(p.provider));
  let html = '';
  if (ready && playerSeen && playerPreview) {
    html = `<span class="syncst warn"><b class="dot wait"></b>${esc(t('sync.preview2'))}${s.players.youtube && s.playerPref !== 'youtube' ? ` <button type="button" class="btn sm solid" data-switch="youtube">${esc(t('sync.toYoutube'))}</button>` : ''}</span>`;
  } else if (ready && playerSeen) {
    html = `<span class="syncst"><b class="dot ok"></b>${esc(t('sync.following'))}</span>`;
  } else if (ready) {
    html = `<span class="syncst"><b class="dot wait"></b>${esc(t('sync.press'))}</span>`;
  }
  else if (s.sync && s.sync.none && s.sync.found) html = `<span class="syncst warn"><b class="dot wait"></b>${esc(t('sync.nomatch', { m: s.sync.matched, n: s.sync.n }))}</span>`;
  else if (s.sync && s.sync.none) html = `<span class="syncst warn"><b class="dot wait"></b>${esc(t('sync.nofound'))}</span>`;
  bar.innerHTML = html; bar.hidden = !html;
  $('#followWrap').hidden = !(ready && playerSeen);
  $('#follow').checked = follow;
}
$('#syncBar').addEventListener('click', (e) => {
  const s = song(); if (!s) return;
  const sw = e.target.closest('[data-switch]');
  if (sw && s.players[sw.dataset.switch]) { s.playerPref = pref = sw.dataset.switch; try { localStorage.setItem('ll_pp', pref); } catch {} save(); renderPlayer(); return; }
  if (e.target.closest('[data-fix]')) { fixOpen = !fixOpen; renderSyncBar(s); return; }
  const b = e.target.closest('[data-off]'); if (!b || !s.sync || !s.sync.times) return;
  setOff(s, Number(b.dataset.off) === 0 ? 0 : getOff(s) + Number(b.dataset.off)); save(); renderSyncBar(s);
  if (!syncPlaying) syncFrame();
});
$('#follow').onchange = () => { follow = $('#follow').checked; try { localStorage.setItem('ll_follow', follow ? '1' : '0'); } catch {} };


// ---------- mode étude : une ligne à la fois, à votre rythme ----------
const study = { listenUntil: null, open: false, list: [], k: 0, shown: false, auto: false, speed: 1, timer: 0, looked: new Map(), follow: false, chips: [] };
function studyOpen() {
  const s = song(); if (!s) return;
  const list = s.lines.map((l, i) => (lineKind(l.text) === 'line' ? i : -1)).filter((i) => i >= 0);
  if (!list.length) return;
  Object.assign(study, { open: true, list, k: 0, shown: false, auto: false, looked: new Map(), follow: false, chips: [] });
  const start = syncPlaying && syncIdx >= 0 ? syncIdx : activeLine != null ? activeLine : list[0];
  const k = list.indexOf(start); if (k >= 0) study.k = k;
  study.follow = false; study.listenUntil = null;
  try { if (playerCtl && syncPlaying) playerCtl.pause(); } catch {} // on étudie : la musique s'arrête, elle se relance depuis la fenêtre
  $('#studyDlg').showModal(); studyRender();
}
function studyClose() { clearTimeout(study.timer); study.open = false; study.auto = false; if ($('#studyDlg').open) $('#studyDlg').close(); }
function studyLineHtml(text, lineIdx) {
  let out = '', last = 0;
  for (const m of text.matchAll(WORD_RE)) { out += esc(text.slice(last, m.index)) + `<span class="sw" data-n="${esc(norm(m[0]))}" data-l="${lineIdx}">${esc(m[0])}</span>`; last = m.index + m[0].length; }
  return out + esc(text.slice(last));
}
function studyRender() {
  const s = song(); if (!s || !study.open) return;
  const n = study.list.length, end = study.k >= n;
  $('#stMain').hidden = end; $('#stEnd').hidden = !end;
  $('#stBar').style.width = `${Math.min(100, (study.k / n) * 100)}%`;
  $('#stCount').textContent = end ? '🎉' : t('study.count', { k: study.k + 1, n });
  $('#stPrev').disabled = study.k === 0; $('#stNext').textContent = end ? t('study.close') : t('study.next') + ' ▶';
  $('#stXp').textContent = '⭐ ' + t(study.looked.size === 1 ? 'study.word1' : 'study.words', { n: study.looked.size });
  const canFollow = !!(syncReliable(s) && syncPlaying);
  $('#stFollow').innerHTML = study.follow ? `<b class="dot ok"></b> ${esc(t('study.following'))}` : canFollow ? `<button type="button" class="link" id="stResume">♪ ${esc(t('study.resume'))}</button>` : '';
  $('#stHint').textContent = t('study.hint'); studyMusicRender();
  if (end) {
    const saved = new Set(state.library.map((e) => norm(e.text)));
    const items = [...study.looked.values()];
    $('#stEnd').innerHTML = `<div class="st-win">${birdSvg(birdLevel(birdXp(state)).stage, 110)}</div><h2>${esc(t('study.done'))}</h2><p>${esc(t(items.length === 1 ? 'study.summary1' : 'study.summary', { n: items.length }))}</p>
      ${items.length ? `<div class="st-words">${items.map((w) => `<span class="chip${saved.has(norm(w.text)) ? ' on' : ''}"><b>${esc(w.text)}</b> ${esc(w.tr)}</span>`).join('')}</div><button class="btn solid" type="button" id="stSaveAll">☆ ${esc(t('study.saveAll'))}</button>` : ''}
      <button class="btn" type="button" id="stAgain">↺ ${esc(t('study.again'))}</button>`;
    return;
  }
  const i = study.list[study.k], l = s.lines[i];
  $('#stLine').innerHTML = studyLineHtml(l.text, i);
  $('#stTr').textContent = l.tr || '…'; $('#stTr').classList.toggle('show', study.shown);
  $('#stReveal').textContent = study.shown ? '🙈 ' + t('study.hide') : '👁 ' + t('study.show');
  $('#stMeaning').innerHTML = study.chips.map((c, m) => `<span class="chip"><b>${esc(c.text)}</b> ${c.tr ? esc(c.tr) : '…'} ${c.tr ? `<button type="button" data-stsave="${m}" aria-label="${esc(t('goal.save'))}">${state.library.some((e) => norm(e.text) === norm(c.text)) ? '★' : '☆'}</button>` : ''}</span>`).join('');
  clearTimeout(study.timer);
}
// suivi de la musique proposé seulement si presque toutes les lignes correspondent (sinon il afficherait une mauvaise ligne)
function syncReliable(s) { if (!(s && s.sync && s.sync.times && s.sync.v === 2)) return false; const n = s.lines.filter((l) => lineKind(l.text) === 'line').length; return s.sync.total >= Math.max(3, n * 0.8); }
function studyStep(d, keepAuto) {
  const n = study.list.length; if (!keepAuto) { study.auto = false; study.follow = false; }
  study.k = Math.max(0, Math.min(n, study.k + d)); study.shown = false; study.chips = [];
  if (study.k >= n) study.auto = false;
  studyRender();
}
function studyGoLine(i) {
  const k = study.list.indexOf(i);
  if (k >= 0 && k !== study.k) { study.k = k; study.shown = false; study.chips = []; studyRender(); }
}
async function studyWord(span) {
  const s = song(); const text = span.textContent, i = Number(span.dataset.l);
  study.auto = false; clearTimeout(study.timer);
  let chip = study.chips.find((c) => norm(c.text) === norm(text));
  if (!chip) { chip = { text, tr: '', rm: '', line: i }; study.chips.push(chip); }
  span.classList.add('picked'); studyRenderChips();
  const key = `${state.target}|${text}|${i}`;
  let r = wordCache.get(key) || (s.wordsTarget === state.target && s.words && s.words[norm(text)]);
  if (!r) { try { r = await api('/api/translate', { text, target: state.target, source: s.source, context: s.lines[i].text }); wordCache.set(key, r); } catch { r = { text: t('panel.busy'), translit: '' }; } }
  chip.tr = r.text; chip.rm = r.translit || ''; if (r.text && r.text !== t('panel.busy')) countLookup(s, text);
  if (r.text && r.text !== t('panel.busy')) study.looked.set(norm(text), { text, tr: r.text, rm: chip.rm, line: i });
  studyRenderChips(); $('#stXp').textContent = '⭐ ' + t(study.looked.size === 1 ? 'study.word1' : 'study.words', { n: study.looked.size });
}
function studyRenderChips() {
  $('#stMeaning').innerHTML = study.chips.map((c, m) => `<span class="chip"><b>${esc(c.text)}</b> ${c.tr ? esc(c.tr) : '…'} ${c.tr ? `<button type="button" data-stsave="${m}" aria-label="${esc(t('goal.save'))}">${state.library.some((e) => norm(e.text) === norm(c.text)) ? '★' : '☆'}</button>` : ''}</span>`).join('');
}

// ---- musique pilotée depuis le mode étude : pause / lecture / « écouter cette ligne » ----
function studyMusicRender(playingNow) {
  const box = $('#stMusic'); if (!box) return;
  const s = song(); const p = s && s.players[s.playerPref];
  const playing = playingNow != null ? playingNow : syncPlaying;
  if (!p) { box.innerHTML = ''; return; }
  if (!playerCtl) { box.innerHTML = `<small>${esc(t('study.noctl'))}</small>`; return; }
  const i = study.list[study.k];
  const canListen = !!(s.sync && s.sync.v === 2 && s.sync.times && i != null && s.sync.times[i] != null);
  box.innerHTML = `<button type="button" class="btn sm${playing ? ' on' : ''}" data-mu="toggle">${playing ? '⏸ ' + esc(t('study.musicPause')) : '♪ ' + esc(t('study.musicPlay'))}</button>`
    + (canListen ? ` <button type="button" class="btn sm" data-mu="listen">🔁 ${esc(t('study.listen'))}</button>` : '');
}
function studyMusicAction(a) {
  const s = song(); if (!s || !playerCtl) return;
  try {
    if (a === 'toggle') {
      if (syncPlaying) { playerCtl.pause(); study.follow = false; study.listenUntil = null; }
      else { playerCtl.play(); study.follow = syncReliable(s); studyRender(); }
    } else if (a === 'listen') {
      const i = study.list[study.k], off = effOff(s);
      study.follow = false; study.auto = false; clearTimeout(study.timer);
      // marge avant/après le vers : une petite erreur de minutage ne coupe jamais un mot
      study.listenUntil = s.sync.ends[i] - off + 0.45;
      playerCtl.seek(s.sync.times[i] - off - 0.45); playerCtl.play();
    }
  } catch { /* lecteur indisponible */ }
  studyMusicRender();
}
$('#stMusic').addEventListener('click', (e) => { const b = e.target.closest('[data-mu]'); if (b) studyMusicAction(b.dataset.mu); });
$('#studyBtn').onclick = studyOpen;
$('#stClose').onclick = studyClose;
$('#studyDlg').addEventListener('close', () => { clearTimeout(study.timer); study.open = false; study.auto = false; });
$('#stNext').onclick = () => (study.k >= study.list.length ? studyClose() : studyStep(1));
$('#stPrev').onclick = () => studyStep(-1);
$('#stReveal').onclick = () => { study.shown = !study.shown; $('#stTr').classList.toggle('show', study.shown); $('#stReveal').textContent = study.shown ? '🙈 ' + t('study.hide') : '👁 ' + t('study.show'); };
$('#stLine').addEventListener('click', (e) => { const w = e.target.closest('.sw'); if (w) studyWord(w); });
$('#stMeaning').addEventListener('click', (e) => {
  const b = e.target.closest('[data-stsave]'); const s = song(); if (!b || !s) return;
  const c = study.chips[Number(b.dataset.stsave)]; if (!c || !c.tr) return;
  const cur = state.library.find((x) => norm(x.text) === norm(c.text));
  if (cur) state.library = state.library.filter((x) => x !== cur); else saveWord(s, c.text, c.tr, c.rm, state.target, s.lines[c.line]);
  save(); studyRenderChips(); render();
});
$('#stFollow').addEventListener('click', (e) => { if (e.target.closest('#stResume')) { study.follow = true; if (syncIdx >= 0) studyGoLine(syncIdx); studyRender(); } });
$('#stEnd').addEventListener('click', (e) => {
  const s = song(); if (!s) return;
  if (e.target.closest('#stAgain')) { study.k = 0; study.shown = false; study.chips = []; study.looked = new Map(); studyRender(); }
  if (e.target.closest('#stSaveAll')) { for (const w of study.looked.values()) if (!state.library.some((x) => norm(x.text) === norm(w.text))) saveWord(s, w.text, w.tr, w.rm, state.target, s.lines[w.line]); save(); render(); studyRender(); }
});
document.addEventListener('keydown', (e) => {
  if (!study.open) return;
  if (e.code === 'Space') { e.preventDefault(); if (study.k >= study.list.length) return; if (!study.shown) { study.shown = true; $('#stTr').classList.add('show'); $('#stReveal').textContent = '🙈 ' + t('study.hide'); } else studyStep(1); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); studyStep(1); } else if (e.code === 'ArrowLeft') { e.preventDefault(); studyStep(-1); }
});

// ---------- « Se tester » : le jeu à partir de la bibliothèque ----------
const play = { mode: '', qs: [], i: 0, score: 0, streak: 0, best: 0, wrong: [], phase: 'menu', xpGained: 0, q: null, answered: false };
function renderPlayCta() {
  const el = $('#playCta'); if (!el) return;
  const n = usable(state.library).length, m = masteredCount(state.library);
  el.hidden = !state.library.length;
  if (!state.library.length) return;
  el.innerHTML = `<div class="pc-art">${birdSvg(birdLevel(birdXp(state)).stage, 76)}</div>
    <div class="pc-txt"><b>${esc(t('play.ctaTitle'))}</b><span>${esc(t('play.ctaSub', { n, m }))}</span></div>
    <button type="button" class="btn solid ticket play-open">🎮 ${esc(t('play.btn'))}</button>`;
}
function playOpen() {
  Object.assign(play, { mode: '', qs: [], i: 0, score: 0, streak: 0, best: 0, wrong: [], phase: 'menu', xpGained: 0, q: null, answered: false });
  $('#playDlg').showModal(); playRender();
}
function playClose() { if ($('#playDlg').open) $('#playDlg').close(); }
function playStart(mode) {
  const words = pickWords(state.library, 10);
  if (!words.length) return;
  play.mode = mode; play.qs = words; play.i = 0; play.score = 0; play.streak = 0; play.best = 0; play.wrong = []; play.xpGained = 0; play.phase = 'q';
  playNext(0);
}
function playNext(d = 1) {
  play.i += d; play.answered = false; play.pick = null; play.flip = false; play.typed = ''; play.lastOk = false;
  if (play.i >= play.qs.length) return playEnd();
  const w = play.qs[play.i];
  play.q = null;
  if (play.mode === 'quiz') { play.q = makeChoice(w, state.library); if (!play.q) play.q = { fallback: true }; }
  play.phase = 'q'; playRender();
}
function playAnswer(ok, w) {
  if (play.answered) return; play.answered = true;
  review(w, ok);
  if (ok) { play.score++; play.streak++; play.best = Math.max(play.best, play.streak); state.quizXp = (state.quizXp || 0) + XP_PER_OK; play.xpGained += XP_PER_OK; }
  else { play.streak = 0; play.wrong.push(w); }
  save(); playRender(true);
  if (ok) setTimeout(() => { if ($('#playDlg').open && play.phase === 'q' && play.qs[play.i] === w) playNext(); }, play.mode === 'flash' ? 0 : 1300);
}
function playEnd() {
  play.phase = 'end';
  if (play.qs.length >= 8 && play.score === play.qs.length) { state.quizXp = (state.quizXp || 0) + XP_PERFECT; play.xpGained += XP_PERFECT; }
  save(); playRender(); render(); renderPlayCta();
}
function playRender(feedback) {
  const body = $('#pgBody'); if (!body) return;
  const n = play.qs.length, lib = usable(state.library);
  $('#pgTitle').textContent = play.phase === 'menu' ? t('play.title') : play.phase === 'end' ? '🎉' : t('play.count', { k: Math.min(play.i + 1, n), n });
  $('#pgBar').style.width = play.phase === 'menu' ? '0' : `${Math.min(100, ((play.phase === 'end' ? n : play.i + (play.answered ? 1 : 0)) / Math.max(1, n)) * 100)}%`;
  $('#pgStreak').textContent = play.streak >= 2 ? `🔥 ${play.streak}` : '';
  const stage = birdLevel(birdXp(state)).stage;
  if (play.phase === 'menu') {
    const quizOk = lib.length >= 4 && new Set(lib.map((e) => e.tr.toLowerCase())).size >= 4;
    body.innerHTML = `<div class="pg-menu"><div class="pg-bird">${birdSvg(stage, 96)}</div><h2>${esc(t('play.title'))}</h2>
      <p>${esc(t('play.pool', { n: lib.length, m: masteredCount(state.library) }))}</p>
      <div class="pg-modes">
        <button type="button" data-mode="quiz" ${quizOk ? '' : 'disabled'}><span>🎯</span><b>${esc(t('play.quiz'))}</b><small>${esc(quizOk ? t('play.quizD') : t('play.need4'))}</small></button>
        <button type="button" data-mode="flash"><span>🃏</span><b>${esc(t('play.flash'))}</b><small>${esc(t('play.flashD'))}</small></button>
        <button type="button" data-mode="write"><span>✍️</span><b>${esc(t('play.write'))}</b><small>${esc(t('play.writeD'))}</small></button>
      </div><small class="pg-xp">${esc(t('play.xp', { a: XP_PER_OK, b: XP_PERFECT }))}</small></div>`;
    return;
  }
  if (play.phase === 'end') {
    const ratio = n ? play.score / n : 0, msg = ratio === 1 ? t('play.perfect') : ratio >= 0.7 ? t('play.good') : ratio >= 0.4 ? t('play.ok') : t('play.again');
    body.innerHTML = `<div class="pg-end">${ratio >= 0.8 ? '<div class="pg-conf" aria-hidden="true">🎉✨🎶⭐🎉✨🎶⭐</div>' : ''}<div class="pg-bird big">${birdSvg(stage, 120)}</div>
      <div class="pg-score"><b>${play.score}</b><span>/ ${n}</span></div><h2>${esc(msg)}</h2>
      <p>${esc(t('play.gained', { xp: play.xpGained, s: play.best }))}</p>
      ${play.wrong.length ? `<div class="pg-wrong"><small>${esc(t('play.review'))}</small>${play.wrong.map((w) => `<span class="chip"><b>${esc(w.text)}</b> ${esc(w.tr)}</span>`).join('')}</div>` : ''}
      <div class="pg-acts"><button type="button" class="btn solid" data-mode="${play.mode}">↺ ${esc(t('play.replay'))}</button><button type="button" class="btn" data-pg="menu">${esc(t('play.change'))}</button><button type="button" class="btn" data-pg="close">${esc(t('study.close'))}</button></div></div>`;
    return;
  }
  const w = play.qs[play.i];
  const ctx = w.sentence ? `<div class="pg-ctx" dir="auto">“${esc(w.sentence)}”</div>` : '';
  if (play.mode === 'quiz' && play.q && !play.q.fallback) {
    const q = play.q;
    body.innerHTML = `<div class="pg-q"><small>${esc(t(q.rev ? 'play.whichWord' : 'play.whatMeans'))}</small><div class="pg-word" dir="auto">${esc(q.prompt)}</div>${q.rev ? '' : ctx}
      <div class="pg-choices">${q.choices.map((c, k) => `<button type="button" data-c="${k}" class="${play.answered ? (k === q.correct ? 'right' : (play.pick === k ? 'wrong' : 'dim')) : ''}" ${play.answered ? 'disabled' : ''} dir="auto">${esc(c)}</button>`).join('')}</div>
      <div class="pg-fb ${play.answered ? (play.pick === q.correct ? 'ok' : 'ko') : ''}">${play.answered ? (play.pick === q.correct ? '✓ ' + esc(t('play.right')) : '✗ ' + esc(t('play.wrongIs', { a: q.answer }))) : ''}</div>
      ${play.answered && play.pick !== q.correct ? `<button type="button" class="btn solid" data-pg="next">${esc(t('study.next'))} ▶</button>` : ''}</div>`;
    return;
  }
  if (play.mode === 'write') {
    body.innerHTML = `<div class="pg-q"><small>${esc(t('play.typeMeaning'))}</small><div class="pg-word" dir="auto">${esc(w.text)}</div>${ctx}
      <form id="pgForm" class="pg-form"><input id="pgInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(t('play.typePh'))}" ${play.answered ? 'disabled' : ''} value="${esc(play.typed || '')}"><button class="btn solid" ${play.answered ? 'disabled' : ''}>${esc(t('play.check'))}</button></form>
      <div class="pg-fb ${play.answered ? (play.lastOk ? 'ok' : 'ko') : ''}">${play.answered ? (play.lastOk ? '✓ ' + esc(t('play.right')) + ' — ' + esc(w.tr) : '✗ ' + esc(t('play.wrongIs', { a: w.tr }))) : ''}</div>
      ${play.answered && !play.lastOk ? `<button type="button" class="btn solid" data-pg="next">${esc(t('study.next'))} ▶</button>` : ''}</div>`;
    const inp = $('#pgInput'); if (inp && !play.answered) inp.focus();
    return;
  }
  // cartes (et repli du quiz si pas assez de mots)
  const flipped = !!play.flip;
  body.innerHTML = `<div class="pg-q"><small>${esc(t('play.flipHint'))}</small>
    <button type="button" class="pg-card${flipped ? ' flip' : ''}" data-pg="flip"><span class="front" dir="auto">${esc(w.text)}</span><span class="back" dir="auto">${esc(w.tr)}</span></button>${ctx}
    <div class="pg-acts">${flipped ? `<button type="button" class="btn" data-pg="no">😕 ${esc(t('play.toReview'))}</button><button type="button" class="btn solid" data-pg="yes">😎 ${esc(t('play.knew'))}</button>` : `<button type="button" class="btn solid" data-pg="flip">${esc(t('play.reveal'))}</button>`}</div></div>`;
}
$('#pgBody').addEventListener('click', (e) => {
  const m = e.target.closest('[data-mode]'); if (m && !m.disabled) { play.flip = false; return playStart(m.dataset.mode); }
  const w = play.qs[play.i];
  const c = e.target.closest('[data-c]');
  if (c && play.q && !play.answered) { play.pick = Number(c.dataset.c); return playAnswer(play.pick === play.q.correct, w); }
  const g = e.target.closest('[data-pg]'); if (!g) return;
  const k = g.dataset.pg;
  if (k === 'menu') { play.phase = 'menu'; return playRender(); }
  if (k === 'close') return playClose();
  if (k === 'next') return playNext();
  if (k === 'flip') { play.flip = !play.flip; return playRender(); }
  if (k === 'yes' || k === 'no') { play.flip = false; return playAnswer(k === 'yes', w); }
});
$('#pgBody').addEventListener('submit', (e) => {
  if (e.target.id !== 'pgForm') return; e.preventDefault();
  const w = play.qs[play.i]; if (play.answered) return;
  play.typed = $('#pgInput').value; play.lastOk = checkTyped(play.typed, w.tr);
  playAnswer(play.lastOk, w); play.typed = '';
});
$('#pgClose').onclick = playClose;
document.addEventListener('click', (e) => { if (e.target.closest('.play-open')) playOpen(); });
document.addEventListener('keydown', (e) => {
  if (!$('#playDlg').open) return;
  if (play.phase === 'q' && play.mode === 'flash' && e.code === 'Space') { e.preventDefault(); play.flip = !play.flip; playRender(); }
  else if (play.phase === 'q' && (e.code === 'Enter') && play.answered && !(play.mode === 'quiz' ? play.pick === play.q.correct : play.lastOk)) { if (!/^(INPUT)$/.test(document.activeElement.tagName)) playNext(); }
  else if (play.phase === 'q' && play.mode === 'quiz' && !play.answered && /^[1-4]$/.test(e.key)) { const k = Number(e.key) - 1; if (play.q && play.q.choices[k] != null) { play.pick = k; playAnswer(k === play.q.correct, play.qs[play.i]); } }
});

// ---------- « en lecture » : indicateur visible sur toutes les pages ----------
const fmtTime = (sec) => { sec = Math.max(0, Math.floor(sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
let nowTimer = 0, baseTitle = '';
function nowRender() {
  const bar = $('#nowBar'); if (!bar) return;
  const s = song();
  const show = !!(s && playerCtl && playerSeen && !playerPreview) && currentTab !== 'song';
  const playing = !!(s && playerCtl && playerSeen && syncPlaying);
  // onglet « Lecture » : petites barres animées quand ça joue
  document.querySelector('.nav button[data-tab="song"]')?.classList.toggle('is-playing', playing);
  // titre de la page : ♪ pendant la lecture
  if (!baseTitle) baseTitle = document.title;
  if (playing && s) document.title = `♪ ${s.title} · Lyrio`; else if (baseTitle && document.title.startsWith('♪')) document.title = baseTitle;
  bar.hidden = !show; bar.classList.toggle('on', playing); document.body.classList.toggle('has-now', show);
  if (!show) { clearInterval(nowTimer); nowTimer = 0; return; }
  if (!bar.dataset.bird) { bar.dataset.bird = '1'; bar.querySelector('.nb-bird').innerHTML = birdSvg(3, 40, { tail: false, legs: false, phones: true }); }
  $('#nbTitle').textContent = s.title; $('#nbArtist').textContent = s.artist || '';
  $('#nbToggle').textContent = playing ? '⏸' : '▶'; $('#nbToggle').setAttribute('aria-label', t(playing ? 'now.pause' : 'now.play'));
  $('#nbGo').textContent = t('now.open');
  const tick = () => { const p = currentPos(), d = syncKnownDur; $('#nbTime').textContent = d ? `${fmtTime(p)} / ${fmtTime(d)}` : fmtTime(p); $('#nbProg').style.width = d ? `${Math.min(100, (p / d) * 100)}%` : '0'; };
  tick(); clearInterval(nowTimer); if (playing) nowTimer = setInterval(tick, 500);
}
$('#nbToggle').addEventListener('click', () => { try { if (syncPlaying) playerCtl.pause(); else playerCtl.play(); } catch {} });
$('#nbGo').addEventListener('click', () => showTab('song'));

// ---------- Spotify connecté dans la page (lecture complète, Premium) ----------
let spStarted = false, spUri = '';
function spState(st) {
  const tr = st.track_window && st.track_window.current_track;
  if (!tr || (spUri && tr.uri !== spUri && !(tr.linked_from && tr.linked_from.uri === spUri))) return; // un autre morceau joue : on ignore
  const pos = st.position / 1000 + (st.paused ? 0 : (Date.now() - st.timestamp) / 1000);
  onTick(pos, !st.paused, st.duration / 1000);
  const info = $('#spInfo'); if (info) info.textContent = `${tr.name} · ${(tr.artists || []).map((a) => a.name).join(', ')}`;
  const go = $('#spGo'); if (go) go.textContent = st.paused ? '▶ ' + t('sp.play') : '⏸ ' + t('now.pause');
}
async function spOwnStart(id, fk) {
  spUri = `spotify:track:${id}`; spStarted = false;
  try {
    const box = await spot.startPlayer({ onState: spState, onError: (k) => { if (k === 'premium') { spBad = 'premium'; renderPlayer(); } } });
    if (frameKey !== fk) return;
    playerCtl = { play: () => (spStarted ? box.resume() : (spStarted = true, box.playTrack(spUri))), pause: () => box.pause(), seek: (sec) => box.seek(sec) };
    syncStop = () => {};
    window.__spBox = box;
    if (study.open) studyMusicRender();
  } catch (e) {
    if (frameKey !== fk) return;
    if (!spBad) spBad = e.message === 'premium' ? 'premium' : 'error';
    renderPlayer();
  }
}
document.addEventListener('click', async (e) => {
  const s = song(); if (!s) return;
  if (e.target.closest('#spConnect')) {
    const b = e.target.closest('#spConnect'); b.disabled = true;
    try { await spot.connect(spotifyId); spBad = ''; renderPlayer(); } catch (err) { b.disabled = false; const n = b.parentElement.querySelector('small'); if (n) n.textContent = err.message === 'popup' ? t('sp.popup') : t('sp.fail'); }
  } else if (e.target.closest('#spGo')) {
    try { if (!playerCtl) return; if (syncPlaying) playerCtl.pause(); else playerCtl.play(); } catch { /* lecteur non prêt */ }
  } else if (e.target.closest('#spOut')) {
    try { window.__spBox && window.__spBox.stop(); } catch { /* rien */ }
    spot.disconnect(); spBad = ''; stopSync(); renderPlayer();
  }
});

// ---------- mode karaoké : texte géant qui suit la musique, comme sur Spotify ----------
const kara = { open: false, idx: -2, els: new Map(), words: null, word: -2 };
function karaOpen() {
  const s = song(); if (!s) return;
  const hasSync = !!(s.sync && s.sync.v === 2 && s.sync.times);
  kara.open = true; kara.idx = -2; kara.els = new Map(); kara.words = null; kara.word = -2;
  $('#kaTitle').textContent = s.title; $('#kaArtist').textContent = s.artist || '';
  $('#kaNo').hidden = hasSync; $('#kaNo').textContent = t('kara.nosync');
  const trOn = $('#kaTr').checked;
  $('#kaLines').className = 'ka-lines' + (trOn ? '' : ' no-tr');
  $('#kaLines').innerHTML = s.lines.map((l, i) => {
    if (lineKind(l.text) !== 'line') return '';
    let out = '', last = 0;
    for (const m of l.text.matchAll(WORD_RE)) { out += esc(l.text.slice(last, m.index)) + `<span class="kw" data-n="${esc(norm(m[0]))}" data-l="${i}">${esc(m[0])}</span>`; last = m.index + m[0].length; }
    out += esc(l.text.slice(last));
    return `<div class="kl" data-i="${i}"><div class="ko" dir="auto">${out}</div>${l.tr ? `<div class="kt" dir="auto">${esc(l.tr)}</div>` : ''}</div>`;
  }).join('');
  $('#kaLines').querySelectorAll('.kl').forEach((e) => kara.els.set(Number(e.dataset.i), e));
  $('#kaWord').hidden = true;
  $('#karaDlg').showModal(); karaCtl(); karaLead();
  try { if (!localStorage.getItem('ll_leadhint')) { localStorage.setItem('ll_leadhint', '1'); toast(t('kara.hint')); } } catch { /* rien */ }
  if (hasSync) syncFrame();
}
function karaUpdate(s, loc) {
  if (loc.i !== kara.idx) {
    kara.idx = loc.i; kara.word = -2;
    kara.els.forEach((el, i) => { el.classList.toggle('past', loc.i >= 0 && i < loc.i); el.classList.toggle('active', i === loc.i); if (i !== loc.i) { el.classList.remove('approx'); el.querySelectorAll('.kw.sung,.kw.now').forEach((w) => w.classList.remove('sung', 'now')); } });
    const el = kara.els.get(loc.i); kara.words = el ? el.querySelectorAll('.kw') : null;
    if (el && !kara.pinned) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  const el = kara.els.get(loc.i); if (!el) return;
  const exact = s.sync.exact && s.sync.exact[loc.i];
  el.classList.toggle('approx', !exact); if (!exact) el.style.setProperty('--lp', `${Math.round(loc.line * 100)}%`);
  if (exact && kara.words && loc.k !== kara.word) { kara.words.forEach((w, m) => { w.classList.toggle('sung', m < loc.k); w.classList.toggle('now', m === loc.k); }); kara.word = loc.k; }
}
function karaCtl(playing) {
  const btn = $('#kaPlay'); if (!btn) return;
  const pl = playing != null ? playing : syncPlaying;
  btn.textContent = pl ? '⏸' : '▶'; btn.disabled = !playerCtl;
  const d = syncKnownDur; $('#kaTime').textContent = d ? `${fmtTime(currentPos())} / ${fmtTime(d)}` : fmtTime(currentPos());
}
async function karaWord(span) {
  const s = song(); if (!s) return;
  const text = span.textContent, i = Number(span.dataset.l);
  pauseForWord(); kara.pinned = true;
  const bar = $('#kaWord'); bar.hidden = false; bar.innerHTML = `<b dir="auto">${esc(text)}</b> <span>…</span>`;
  const key = `${state.target}|${text}|${i}`;
  let r = wordCache.get(key) || (s.wordsTarget === state.target && s.words && s.words[norm(text)]);
  if (!r) { try { r = await api('/api/translate', { text, target: state.target, source: s.source, context: s.lines[i].text }); wordCache.set(key, r); } catch { r = { text: t('panel.busy'), translit: '' }; } }
  if (r.text && r.text !== t('panel.busy')) countLookup(s, text);
  const saved = state.library.some((e) => norm(e.text) === norm(text));
  bar.innerHTML = `<b dir="auto">${esc(text)}</b><span dir="auto">${esc(r.text || '')}</span>
    <button type="button" class="ka-act" data-ks="1" ${r.text ? '' : 'disabled'}>${saved ? '★' : '☆'} ${esc(t('goal.save'))}</button>
    <button type="button" class="ka-act go" data-kr="1">▶ ${esc(t('panel.resume'))}</button>`;
  bar.dataset.word = text; bar.dataset.line = i; bar.dataset.tr = r.text || ''; bar.dataset.rm = r.translit || '';
}
$('#karaBtn').onclick = karaOpen;
$('#kaClose').onclick = () => $('#karaDlg').close();
$('#karaDlg').addEventListener('close', () => { kara.open = false; kara.pinned = false; });
$('#kaTr').onchange = () => $('#kaLines').classList.toggle('no-tr', !$('#kaTr').checked);
$('#kaPlay').onclick = () => { try { if (!playerCtl) return; if (syncPlaying) playerCtl.pause(); else playerCtl.play(); } catch { /* lecteur non prêt */ } kara.pinned = false; };
$('#kaLines').addEventListener('click', (e) => { const w = e.target.closest('.kw'); if (w) karaWord(w); });
$('#kaWord').addEventListener('click', (e) => {
  const s = song(); const bar = $('#kaWord'); if (!s) return;
  if (e.target.closest('[data-kr]')) { bar.hidden = true; kara.pinned = false; const was = wordPaused; wordPaused = false; if (was && playerCtl) { try { playerCtl.play(); } catch { /* rien */ } } }
  if (e.target.closest('[data-ks]') && bar.dataset.tr) {
    const text = bar.dataset.word, cur = state.library.find((x) => norm(x.text) === norm(text));
    if (cur) state.library = state.library.filter((x) => x !== cur); else saveWord(s, text, bar.dataset.tr, bar.dataset.rm, state.target, s.lines[Number(bar.dataset.line)]);
    save(); e.target.closest('[data-ks]').textContent = (state.library.some((x) => norm(x.text) === norm(text)) ? '★ ' : '☆ ') + t('goal.save');
  }
});
function karaLead() { const el = $('#kaLead'); if (el) el.textContent = `${lead > 0 ? '+' : ''}${lead.toFixed(2).replace(/0$/, '')} s`; }
document.querySelector('.ka-off').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ko]'); if (!b) return;
  setLead(lead + Number(b.dataset.ko)); karaLead(); if (!syncPlaying) syncFrame();
});
document.addEventListener('keydown', (e) => { if (kara.open && e.code === 'Space' && !/^(INPUT|BUTTON)$/.test(document.activeElement.tagName)) { e.preventDefault(); $('#kaPlay').click(); } });

let frameKey = '', formKey = '', playerEditing = false;
const frameHeight = (p) => (/open\.spotify\.com\/embed\/track\//.test(p.src) ? 80 : p.h);
function renderPlayer() {
  const s = song(); if (!s) return;
  migratePlayers(s);
  const sel = s.playerPref && s.players[s.playerPref] ? s.playerPref : '';
  // onglets : peuvent être redessinés à tout moment sans toucher au lecteur
  const vis = visibleServices(s), names = Object.fromEntries(SERVICES);
  $('#ptabs').innerHTML = `<details class="pmore"><summary>${esc(sel ? names[sel] : t('player.listenLabel'))}${s.finding ? ' …' : ''} <span aria-hidden="true">▾</span></summary><div class="pmore-in">`
    + (vis.length > 1 ? vis.map((k) => `<button type="button" class="ptab${sel === k ? ' on' : ''}" data-svc="${k}">${esc(names[k])}</button>`).join('') : '')
    + `<button class="link" type="button" data-p="change">${esc(t('player.link'))}</button>`
    + (sel ? `<button class="link" type="button" data-p="remove">${esc(t('player.remove'))}</button>` : '')
    + `</div></details>`;
  // lecteur : recréé seulement si le morceau change, pour ne pas couper la musique
  const p = sel && s.players[sel];
  const fk = `${s.id}|${p ? p.src : ''}${p ? '' : '|' + !!s.finding}|${getLang()}|${spot.isConnected() ? 1 : 0}${spBad ? 1 : 0}`;
  if (fk !== frameKey) {
    frameKey = fk;
    const h = p && frameHeight(p);
    stopSync();
    const spTrack = p && p.provider === 'Spotify' && /\/embed\/track\/([A-Za-z0-9]+)/.exec(p.src);
    const src = p && p.kind === 'yt' ? p.src + (p.src.includes('?') ? '&' : '?') + 'enablejsapi=1&playsinline=1&origin=' + encodeURIComponent(location.origin) : p && p.src;
    const iframeHtml = (u) => `<iframe class="${p.kind === 'yt' ? 'yt' : ''}" src="${esc(u)}" ${h ? `height="${h}"` : ''} loading="lazy" referrerpolicy="strict-origin-when-cross-origin"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" allowfullscreen title="${esc(t('player.title'))} ${esc(p.provider)}"></iframe>`;
    const spOwn = !!(spTrack && spotifyId && spot.isConnected() && !spBad);
    const spBanner = spTrack && spotifyId && !spOwn ? `<div class="sp-connect"><button type="button" class="btn solid sm" id="spConnect">${esc(t('sp.connect'))}</button><small>${esc(spBad === 'premium' ? t('sp.notPremium') : spBad ? t('sp.fail') : t('sp.connectNote'))}</small></div>` : '';
    $('#pframe').innerHTML = p
      ? (spOwn
        ? `<div id="spOwn" class="sp-own"><span class="sp-ico" aria-hidden="true">♪</span><div class="sp-meta"><b>Spotify · ${esc(t('sp.full'))}</b><small id="spInfo">${esc(t('sp.ready'))}</small></div><button type="button" class="btn solid" id="spGo">▶ ${esc(t('sp.play'))}</button><button type="button" class="link" id="spOut">${esc(t('sp.out'))}</button></div>`
        : `${spBanner}${spTrack ? '<div id="spHost"></div>' : iframeHtml(src)}<p class="pnote">${esc(t('player.note'))}</p>`)
      : (s.finding ? '' : `<p class="pnote">${esc(t('player.none'))}</p>`);
    if (spOwn) { spOwnStart(spTrack[1], fk); }
    if (p && canSync(p.provider) && !spOwn) {
      const ok = (res) => { if (frameKey === fk) { syncStop = res.stop; playerCtl = res.ctl; if (study.open) studyMusicRender(); } else res.stop(); };
      if (spTrack) {
        attachSpotify($('#spHost'), `spotify:track:${spTrack[1]}`, onTick).then(ok).catch(() => {
          const host = $('#spHost'); if (host && frameKey === fk) host.outerHTML = iframeHtml(p.src);
        });
      } else attachPlayer(p.provider, $('#pframe iframe'), onTick, youtubeFailed).then(ok).catch(() => {});
    }
  }
  ensureSync(s); renderSyncBar(s, p);
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
// Cliquer un mot met la musique en pause (si le lecteur se pilote) et surligne le mot ; un bouton la relance depuis le même endroit.
let wordPaused = false, wordPausedAt = 0;
function pauseForWord() { if (playerCtl && syncPlaying) { try { playerCtl.pause(); wordPaused = true; wordPausedAt = Date.now(); } catch { /* lecteur non prêt */ } } }
function clearPicked() { document.querySelectorAll('#lyrics .w.picked').forEach((w) => w.classList.remove('picked')); }
function markPicked(text, lineIdx) {
  clearPicked();
  const n = norm(text); const words = n.split(/\s+/).filter(Boolean);
  document.querySelectorAll(`#lyrics .ln[data-i="${lineIdx}"] .w`).forEach((w) => { if (words.includes(w.dataset.n)) w.classList.add('picked'); });
}
function resumeAfterWord() { const was = wordPaused; wordPaused = false; clearPicked(); if (was && playerCtl) { try { playerCtl.play(); } catch { /* rien */ } } drawPanel(); }
function closePop() { popCtx = null; wordPaused = false; clearPicked(); setActiveLine(null); drawPanel(); }

function drawPanel() {
  const s = song();
  pop.classList.toggle('open', !!popCtx && !!s);
  if (!popCtx || !s) { pop.innerHTML = `<div class="label">${esc(t('panel.title'))}</div><p class="placeholder">${esc(t('panel.placeholder'))}</p>`; return; }
  const line = s.lines[popCtx.lineIdx] || { text: '' }, text = popCtx.text;
  const libEntry = state.library.find((e) => norm(e.text) === norm(text)), inLib = !!libEntry;
  const stale = inLib && popCtx.tr && libEntry.lang && libEntry.lang !== state.target; // enregistré dans une autre langue de traduction
  const inGoal = s.goal.words.some((g) => norm(g.word) === norm(text));
  const single = !/\s/.test(text.trim());
  pop.innerHTML = `<div class="label"><span>${esc(t('panel.title'))}</span><button id="pClose" aria-label="${esc(t('common.close'))}">✕</button></div>
    <div class="wordbig" dir="auto">${esc(text)}</div>
    <div class="wmeta">${popCtx.rm ? esc(popCtx.rm) : ''}</div>
    ${popCtx.err ? `<p class="def">${esc(t('panel.busy'))}</p><button class="btn" id="pRetry" type="button">${esc(t('panel.retry'))}</button>` : `<p class="def">${popCtx.tr ? esc(popCtx.tr) : '<span class="dots">…</span>'}</p>`}
    ${popCtx.note ? `<p class="note"><b>${esc(t('panel.note'))}</b>${esc(popCtx.note)}</p>` : ''}
    <p class="ctx" dir="auto">“${esc(line.text)}”</p>
    ${line.tr ? `<p class="ctxtr">${esc(line.tr)}</p>` : ''}
    <div class="acts"><button class="btn solid${inLib && !stale ? ' saved' : ''}" id="pSave" ${!inLib && !popCtx.tr ? 'disabled' : ''} title="${inLib && !stale ? esc(t('panel.unsaveHint')) : ''}">${stale ? esc(t('panel.update')) : inLib ? t('panel.saved') : t('panel.save')}</button>
      ${single ? `<button class="btn" id="pGoal">${inGoal ? t('panel.goalRemove') : t('panel.goalAdd')}</button>` : ''}</div>
    ${wordPaused && playerCtl ? `<button class="btn resume" id="pResume" type="button">▶ ${esc(t('panel.resume'))}</button>` : ''}`;
}

async function openPop(text, lineIdx) {
  const s = song();
  pauseForWord();
  popCtx = { text, lineIdx, tr: '', rm: '', note: '' };
  setActiveLine(lineIdx); markPicked(text, lineIdx);
  drawPanel();
  const key = `${state.target}|${text}|${lineIdx}`;
  const apply = (r) => {
    if (popCtx?.text !== text) return;
    popCtx.tr = r.text; popCtx.rm = r.translit; popCtx.note = r.note || ''; if (r.text) countLookup(s, text); drawPanel();
  };
  const pre = !/\s/.test(text.trim()) && s.wordsTarget === state.target && s.words?.[norm(text)];
  if (pre) return apply(pre);
  if (wordCache.has(key)) return apply(wordCache.get(key));
  const base = { text, target: state.target, source: s.source };
  let smartDone = false;
  // 1) réponse immédiate, 2) version contextuelle qui la remplace
  api('/api/translate', { ...base, fast: true }).then((r) => { if (!smartDone) apply(r); }).catch(() => {});
  const attempt = async (n) => {
    try { return await api('/api/translate', { ...base, context: s.lines[lineIdx].text }); }
    catch (e) {
      if (n >= 2 || popCtx?.text !== text) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (n + 1)));   // le service est parfois saturé : on patiente un peu
      return attempt(n + 1);
    }
  };
  try {
    const r = await attempt(0);
    smartDone = true; wordCache.set(key, r); apply(r);
  } catch {
    smartDone = true;
    if (popCtx?.text === text && !popCtx.tr) { popCtx.err = true; drawPanel(); }
  }
}

pop.addEventListener('click', (e) => {
  const s = song(); const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'pClose') return closePop();
  if (b.id === 'pResume') return resumeAfterWord();
  if (!popCtx || !s) return;
  if (b.id === 'pRetry') { wordCache.delete(`${state.target}|${popCtx.text}|${popCtx.lineIdx}`); return openPop(popCtx.text, popCtx.lineIdx); }
  if (b.id === 'pSave') {
    const cur = state.library.find((e) => norm(e.text) === norm(popCtx.text));
    if (cur) {
      if (popCtx.tr && cur.lang && cur.lang !== state.target) { cur.tr = popCtx.tr; cur.rm = popCtx.rm; cur.lang = state.target; } // met à jour la traduction dans la langue choisie
      else state.library = state.library.filter((e) => e !== cur); // un second clic retire le mot de la bibliothèque
      save(); render(); drawPanel(); return;
    }
    if (!popCtx.tr) return; // on n'enregistre jamais un mot sans sa traduction
    const l = s.lines[popCtx.lineIdx];
    saveWord(s, popCtx.text, popCtx.tr, popCtx.rm, state.target, l);
    save(); render(); drawPanel();
  }
  if (b.id === 'pGoal') {
    const i = s.goal.words.findIndex((g) => norm(g.word) === norm(popCtx.text));
    if (i >= 0) s.goal.words.splice(i, 1);
    else s.goal.words.push({ word: popCtx.text, tr: popCtx.tr, trLang: state.target, note: popCtx.note, done: false, manual: true });
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
  const size = goalSize(s);
  const keep = s.goal.words.filter((w) => w.done);
  const fresh = ranked.slice(0, Math.max(0, size - keep.length)).map(([n]) => ({ word: forms.get(n), tr: '', done: false }));
  s.goal = { size, words: [...keep, ...fresh] };
}

// Choix des mots utiles (pas de mots-outils) ; sinon repli sur une heuristique.
async function suggestGoal() {
  const s = song(); const size = goalSize(s);
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
          seen.add(n); fresh.push({ word: forms.get(n), tr: w.tr, trLang: state.target, note: w.note, done: false });
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
$('#quiz').onchange = renderGoal;
$('#goalBox').addEventListener('click', (e) => {
  const s = song(); if (!s) return;
  const gs = e.target.closest('[data-gs]');
  if (gs) { s.goal.size = Math.min(30, Math.max(3, goalSize(s) + Number(gs.dataset.gs))); save(); renderGoal(); return; }
  if (e.target.closest('[data-act="suggest"]')) return runSuggest();
  const sv = e.target.closest('[data-sv]');
  if (sv) {
    const w = s.goal.words[Number(sv.dataset.sv)]; if (!w || !w.tr) return;
    const cur = state.library.find((x) => norm(x.text) === norm(w.word));
    if (cur) state.library = state.library.filter((x) => x !== cur); else saveWord(s, w.word, w.tr, '', w.trLang || state.target);
    save(); render(); return;
  }
  if (e.target.closest('[data-svall]')) {
    s.goal.words.forEach((w) => { if (w.tr && !state.library.some((x) => norm(x.text) === norm(w.word))) saveWord(s, w.word, w.tr, '', w.trLang || state.target); });
    save(); render(); return;
  }
  if (!e.target.closest('#goalGrid')) return;
  const rm = e.target.closest('[data-rm]');
  if (rm) { s.goal.words.splice(Number(rm.dataset.rm), 1); save(); render(); return; }
  const cell = e.target.closest('.cell[data-i]'); if (!cell) return;
  if ($('#quiz').checked && e.target.classList.contains('ct') && !e.target.classList.contains('show')) { e.target.classList.add('show'); return; }
  const w = s.goal.words[Number(cell.dataset.i)]; w.done = !w.done; save(); render();
});
$('#goalBox').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.cell[data-i]')) { e.preventDefault(); e.target.click(); }
});

// ---------- bibliothèque ----------
// Langue d'origine de chaque mot (celle qu'on apprend). Les anciennes entrées n'en avaient pas : on la retrouve une fois.
function migrateLibrary() {
  let changed = false;
  for (const e of state.library) {
    if (e.src !== undefined) continue;
    const song = Object.values(state.songs).find((x) => x.title === e.title && (x.artist || '') === (e.artist || ''));
    e.src = normLang(song?.source) || guessScript(e.text) || guessScript(e.sentence);
    changed = true;
  }
  if (changed) save();
}
let libLang = 'all';
const ui = () => getLang();
const flagHtml = (code) => `<span class="flag" aria-hidden="true">${flagOf(code)}</span>`;

let libFilling = false;
async function backfillLibrary() {
  if (libFilling) return;
  const missing = state.library.filter((e) => !e.tr && e.text && !e.fillTried).slice(0, 40);
  if (!missing.length) return;
  libFilling = true;
  try {
    const byLang = {};
    missing.forEach((e) => { e.fillTried = true; (byLang[e.lang || state.target] ||= []).push(e); });
    for (const [lang, list] of Object.entries(byLang)) {
      try {
        const { results } = await api('/api/translate-words', { items: list.map((e) => ({ text: e.text, context: e.sentence || '' })), target: lang, source: list[0].src || 'auto', fast: true });
        results.forEach((r, i) => { if (r && r.text) { list[i].tr = r.text; list[i].rm = list[i].rm || r.translit || ''; list[i].lang = lang; } });
      } catch { list.forEach((e) => { e.fillTried = false; }); }
    }
    save();
  } finally { libFilling = false; }
  renderLibrary();
}
function renderLibrary() {
  $('#libCount').textContent = state.library.length;
  migrateLibrary();
  backfillLibrary();
  renderPlayCta();
  const q = norm($('#libSearch').value || '');
  const count = {};
  for (const e of state.library) count[e.src || ''] = (count[e.src || ''] || 0) + 1;
  const order = Object.keys(count).sort((x, y) => count[y] - count[x] || langName(x, ui()).localeCompare(langName(y, ui())));
  if (libLang !== 'all' && !count[libLang]) libLang = 'all';
  const chip = (id, label, n) => `<button type="button" class="lchip${libLang === id ? ' on' : ''}" data-lang="${esc(id)}" aria-pressed="${libLang === id}">${label}<small>${n}</small></button>`;
  const filters = $('#libFilters');
  filters.hidden = order.length < 2;
  filters.innerHTML = chip('all', esc(t('lib.all')), state.library.length) + order.map((l) => chip(l, `${flagHtml(l)} ${esc(langName(l, ui()))}`, count[l])).join('');

  const match = (e) => !q || norm(`${e.text} ${e.tr} ${e.title} ${e.artist} ${e.sentence}`).includes(q);
  const row = (e) => `<li data-id="${e.id}">
    <span class="e"><bdi>${esc(e.text)}</bdi></span>
    <span class="m">${e.tr ? esc(e.tr) : '<span class="muted">…</span>'}<div class="s">${e.lang ? `${flagOf(e.lang)} ${esc(langName(e.lang, ui()))} · ` : ''}${esc(e.title)}${e.artist ? ' · ' + esc(e.artist) : ''} · ${new Date(e.date).toLocaleDateString()}</div></span>
    <span class="mst" tabindex="0" role="note" data-tip="${esc(t('mst.' + Math.min(4, e.box || 0)) + '\n' + t('mst.rule'))}" aria-label="${esc(t('mst.' + Math.min(4, e.box || 0)))}">${'●'.repeat(Math.min(4, e.box || 0))}${'○'.repeat(4 - Math.min(4, e.box || 0))}</span><button data-del="${e.id}" title="${t('common.delete')}">✕</button></li>`;
  $('#libEmpty').hidden = state.library.length > 0;
  $('#libEmpty').innerHTML = libEmptyHtml(t);
  // « Toutes » : regroupé par langue, avec le drapeau en en-tête ; sinon la langue choisie seulement
  const langs = libLang === 'all' ? order : [libLang];
  $('#libList').innerHTML = langs.map((l) => {
    const items = state.library.filter((e) => (e.src || '') === l && match(e));
    if (!items.length) return '';
    const head = (libLang === 'all' || true) ? `<li class="lib-h"><span class="flag" aria-hidden="true">${flagOf(l)}</span><span>${esc(langName(l, ui()))}</span><small>${items.length}</small></li>` : '';
    return head + items.map(row).join('');
  }).join('');
}
$('#libFilters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lang]'); if (!b) return;
  libLang = b.dataset.lang; renderLibrary();
});
$('#libSearch').oninput = renderLibrary;
$('#libList').addEventListener('click', (e) => {
  const id = e.target.dataset.del; if (!id) return;
  state.library = state.library.filter((x) => x.id !== id); save(); hideTip(); render();
});
$('#export').onclick = () => {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = state.library.map((e) => [e.text, e.tr, e.sentence, e.sentenceTr, `${e.title} - ${e.artist}`, langName(e.src, ui()), langName(e.lang, ui())].map(q).join(';')).join('\n');
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
// Le choix de la langue de traduction ne sert que quand une chanson est ouverte à la lecture.
function syncLangPicker() { const el = document.querySelector('.lang'); if (el) el.hidden = !(song() && currentTab === 'song'); moveNavInk(); }

// trait coloré qui glisse sous l'onglet actif
function moveNavInk() {
  const nav = document.querySelector('.nav'), act = nav && nav.querySelector('button.active'); if (!act) return;
  let ink = nav.querySelector('.nav-ink'); if (!ink) { ink = document.createElement('span'); ink.className = 'nav-ink'; nav.append(ink); }
  ink.style.width = act.offsetWidth + 'px'; ink.style.top = (act.offsetTop + act.offsetHeight - 3) + 'px'; ink.style.transform = `translateX(${act.offsetLeft}px)`;
}
window.addEventListener('resize', moveNavInk);
// la mise en page du menu change quand le sélecteur de langue apparaît, que le compteur change ou que les polices se chargent : on suit
if (window.ResizeObserver) { const ro = new ResizeObserver(() => moveNavInk()); ro.observe(document.querySelector('.nav')); ro.observe(document.querySelector('.top')); document.querySelectorAll('.nav button').forEach((b) => ro.observe(b)); }
// onde au clic sur les éléments cliquables
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest?.('.btn,.ptab,.lchip,.uilang button,.nav button'); if (!el || el.disabled || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = el.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2;
  const dot = document.createElement('span'); dot.className = 'ripple';
  dot.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
  el.append(dot); setTimeout(() => dot.remove(), 650);
});
function showTab(name) {
  currentTab = name; setTimeout(nowRender, 0);
  document.querySelectorAll('.nav button[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  $('#homeTab').hidden = name !== 'home'; $('#songTab').hidden = name !== 'song'; $('#libraryTab').hidden = name !== 'library';
  closePop(); hideTip(); window.scrollTo({ top: 0, behavior: 'smooth' }); moveNavInk();
  if (name === 'home') renderHome();
  syncLangPicker();
  if (name === 'song') { ensureMedia(song()); maybeTour(); } else endTour();
}
document.querySelectorAll('.nav button[data-tab]').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
$('#brand').onclick = (e) => { e.preventDefault(); showTab('home'); };

$('#showTr').onchange = render;
// Le choix de langue se valide avec un bouton ; pendant la traduction, une animation de musique indique que ça charge.
function syncTargetGo() {
  const s = song(), btn = $('#targetGo'), picked = $('#target').value;
  const busy = !!(s && s.translating);
  btn.hidden = !s || (!busy && picked === state.target && s.target === state.target);
  btn.disabled = busy; btn.classList.toggle('loading', busy);
  $('#targetGoT').textContent = busy ? t('tr.going') : t('tr.go');
}
$('#target').onchange = syncTargetGo;
$('#targetGo').onclick = async () => {
  if (!song() || song().translating) return;
  state.target = $('#target').value; save();
  await translateSong();
  syncTargetGo();
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
    url: meta.url || '', lyrics, gid: meta.id || '', example: !!meta.example, cover: meta.thumb
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

// Lien copié depuis un lecteur (Spotify, YouTube, Apple Music, Deezer, SoundCloud) : on retrouve titre + artiste, puis on cherche sur Genius
const isMusicLink = (q) => !GENIUS_LINK.test(q) && /^(https?:\/\/)?[^\s/]+\.[^\s]+/.test(q) && !!parsePlayer(q);
async function resolveLink(q) {
  const seq = ++searchSeq;
  setStatus(t('link.finding'));
  try {
    const r = await api('/api/track-link?url=' + encodeURIComponent(q));
    if (seq !== searchSeq) return;
    pendingPlayer = q;
    const name = [r.artist, r.title].filter(Boolean).join(' ');
    $('#q').value = name;
    setStatus(t('link.found', { name }));
    const found = await api('/api/search?q=' + encodeURIComponent(name));
    if (seq !== searchSeq) return;
    if (found.needsToken) return setStatus(t('search.notConfigured'), true);
    renderHits(found.hits);
    setStatus(found.hits.length ? t('link.found', { name }) : t('search.none'), !found.hits.length);
  } catch (err) { if (seq === searchSeq) setStatus(/open\.spotify\.com\/(intl-\w+\/)?(album|playlist|artist|show|episode)\//i.test(q) || /music\.apple\.com\/\w+\/(playlist|artist)\//i.test(q) ? t('link.notrack') : t('link.fail'), true); }
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
  if (isMusicLink(q)) return resolveLink(q);
  if (hitIdx >= 0 && hitList[hitIdx]) return openImport(hitList[hitIdx]);
  runSearch(q, false);
};

let liveTimer;
$('#q').addEventListener('input', () => {
  clearTimeout(liveTimer);
  const q = $('#q').value.trim();
  if (openFromEmbedCode(q)) return;
  if (isMusicLink(q)) { searchSeq++; liveTimer = setTimeout(() => resolveLink(q), 200); return; }
  pendingPlayer = '';
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
  dlg.innerHTML = `<button class="x" id="dX" aria-label="${esc(t('common.close'))}">✕</button>
    <div class="label">${esc(t('imp.step'))}</div>
    <h2 dir="auto">${esc(label)} <a class="gbadge" href="${esc(h.url)}" target="_blank" rel="noopener" title="${esc(t('imp.openOn'))}"><img src="genius-logo.svg" alt="Genius"></a></h2>
    ${hasEmbed ? `<p class="helper">${esc(t('imp.helper'))}</p>
      <div class="embedbox"><iframe id="embedFrame" title="${esc(t('imp.previewSub'))}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe></div>
      <div id="embedState" class="small">${esc(t('imp.previewLoading'))}</div>
      <div class="acts"><button class="btn solid" id="dImport" type="button" disabled>${esc(t('imp.importThese'))}</button></div>` : `<div id="embedState" class="small">${esc(t('imp.previewFail'))}</div>`}
    <div id="embedFallback" class="acts" ${hasEmbed ? 'hidden' : ''}><button class="btn" id="dToManual" type="button">${esc(t('dlg.manual'))}</button></div>`;

  let done = false, embedText = '', timer = null;
  const finish = async (raw) => {
    if (done) return; done = true;
    const box = $('#embedState');
    box.innerHTML = `<span class="ok">${esc(t('imp.found'))}</span>`;
    if (await useText(raw, h)) { stop(); dlg.close(); } else done = false;
  };
  // aperçu Genius : le cadre isolé renvoie le texte affiché par l'embed officiel
  const previewFail = () => { const e = $('#embedState'); if (e && !embedText) { e.textContent = t('imp.previewFail'); $('#embedFallback').hidden = false; } };
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
  const stop = () => { window.removeEventListener('message', onMsg); clearInterval(watcher); clearTimeout(timer); };

  if (hasEmbed) {
    window.addEventListener('message', onMsg);
    $('#embedFrame').srcdoc = embedSrcdoc(h.id);
    $('#dImport').onclick = () => finish(embedText);
    timer = setTimeout(previewFail, 12000);
  }
  $('#dToManual').onclick = () => { stop(); dlg.close(); songsDlg.showModal(); const m = $('#manual'); if (m) m.open = true; };
  $('#dX').onclick = () => { stop(); dlg.close(); };
  dlg.onclose = stop;
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
  geminiOn = !!st.gemini; spotifyId = st.spotifyClientId || '';
} catch {}
await initLanguages();
applyStatic();
initDemo();
drawPanel();
render();
showTab('home');
moveNavInk(); document.fonts?.ready.then(moveNavInk);
document.querySelectorAll('[data-lang]').forEach((b) => b.onclick = () => {
  setLang(b.dataset.lang);
  frameKey = ''; formKey = '';          // reconstruit le lecteur avec les nouveaux libellés
  render(); renderHome(); drawPanel();
  if (helpDlg.open) buildHelp();
});
