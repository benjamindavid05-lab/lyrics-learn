// Suivi de la musique : associe chaque vers à un instant, puis lit la position du lecteur (Spotify, YouTube, SoundCloud).

const words = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function lev1(a, b) { // vrai si a et b diffèrent d'au plus 1 caractère (insertion, suppression, remplacement)
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 5) return false;
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++d > 1) return false;
    if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
}
const dice = (a, b) => {
  if (!a.length || !b.length) return 0;
  const used = new Array(b.length).fill(false); let hit = 0;
  for (const w of a) { const k = b.findIndex((x, m) => !used[m] && (x === w || lev1(x, w))); if (k >= 0) { used[k] = true; hit++; } }
  return (2 * hit) / (a.length + b.length);
};

const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}]+)*/gu;
const normTok = (w) => String(w || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const tokens = (text) => [...String(text || '').matchAll(WORD_RE)].map((m) => normTok(m[0])).filter(Boolean);

// Répartit des instants pour les mots entre start et end quand l'instant exact est inconnu : proportionnellement aux syllabes,
// avec une note finale plus longue (en chanson, le dernier mot d'un vers est souvent tenu).
const sylls = (w) => { const m = w.match(/[aeiouy]+/g); return m ? m.length : Math.max(1, Math.round(w.length / 2.5)); };
function spread(toks, start, end) {
  const w = toks.map((x, k) => sylls(x) + 0.4 + (k === toks.length - 1 ? 0.8 : 0));
  const tot = w.reduce((a, b) => a + b, 0); let acc = 0;
  return w.map((x) => { const t = start + ((end - start) * acc) / tot; acc += x; return t; });
}

// lines : textes des vers (null pour les lignes vides / titres) ; lrc : [{t, end?, text, words?:[{w,t}]}]
// -> times[i] (début du vers), ends[i], words[i] (instant de chaque mot du vers), exact[i] (true si instants de mots connus)
export function alignLines(lines, lrc) {
  const n = lines.length;
  const times = new Array(n).fill(null), ends = new Array(n).fill(null), wt = new Array(n).fill(null), exact = new Array(n).fill(false);
  const src = new Array(n).fill(-1);
  const L = lrc.map((x) => ({ ...x, tk: words(x.text) }));
  // Appariement global qui respecte l'ordre : maximise la ressemblance totale (évite de confondre les refrains répétés)
  const gi = []; lines.forEach((text, i) => { if (text != null) { const w = words(text); if (w.length) gi.push({ i, w }); } });
  const N = gi.length, M = L.length;
  const sim = Array.from({ length: N }, () => new Float32Array(M));
  for (let a = 0; a < N; a++) for (let b = 0; b < M; b++) {
    const d = dice(gi[a].w, L[b].tk);
    sim[a][b] = d >= 0.45 ? d - 0.002 * Math.abs(b - (a * M) / Math.max(1, N)) : 0; // à ressemblance égale, on préfère la diagonale
  }
  const dp = Array.from({ length: N + 1 }, () => new Float32Array(M + 1));
  for (let a = 1; a <= N; a++) for (let b = 1; b <= M; b++) {
    dp[a][b] = Math.max(dp[a - 1][b], dp[a][b - 1], sim[a - 1][b - 1] > 0 ? dp[a - 1][b - 1] + sim[a - 1][b - 1] : 0);
  }
  for (let a = N, b = M; a > 0 && b > 0;) {
    if (sim[a - 1][b - 1] > 0 && Math.abs(dp[a][b] - (dp[a - 1][b - 1] + sim[a - 1][b - 1])) < 1e-6) { const i = gi[a - 1].i; times[i] = L[b - 1].t; src[i] = b - 1; a--; b--; }
    else if (dp[a - 1][b] >= dp[a][b - 1]) a--; else b--;
  }
  const idx = times.map((t, i) => (t != null ? i : -1)).filter((i) => i >= 0);
  // vers non reconnus : on répartit entre les voisins connus
  for (let k = 0; k < idx.length - 1; k++) {
    const a = idx[k], b = idx[k + 1];
    const mid = []; for (let i = a + 1; i < b; i++) if (lines[i] != null && words(lines[i]).length) mid.push(i);
    mid.forEach((i, m) => { times[i] = times[a] + ((times[b] - times[a]) * (m + 1)) / (mid.length + 1); });
  }
  // fin de chaque vers : fin connue, sinon début du suivant (borné par une durée vraisemblable)
  const order = times.map((t, i) => (t != null ? i : -1)).filter((i) => i >= 0);
  order.forEach((i, k) => {
    const nextT = k + 1 < order.length ? times[order[k + 1]] : Infinity;
    const chars = String(lines[i]).replace(/\s+/g, '').length;
    const cap = times[i] + Math.max(1.2, chars * 0.085 + 0.6);
    const known = src[i] >= 0 ? L[src[i]].end : null;
    ends[i] = Math.min(nextT - 0.05, known != null ? known : cap);
    if (ends[i] <= times[i]) ends[i] = times[i] + 0.8;
  });
  // instants des mots : exacts si la source les donne, sinon répartis dans le vers
  order.forEach((i) => {
    const gt = tokens(lines[i]); if (!gt.length) return;
    const lw = src[i] >= 0 ? L[src[i]].words : null;
    let out = null;
    if (lw && lw.length) {
      out = new Array(gt.length).fill(null); let p = 0, hit = 0;
      gt.forEach((g, k) => {
        for (let m = p; m < Math.min(lw.length, p + 4); m++) {
          const l = normTok(lw[m].w);
          if (l && (l === g || lev1(l, g) || (g.length >= 3 && l.length >= 3 && (l.startsWith(g) || g.startsWith(l))))) { out[k] = lw[m].t; p = m + 1; hit++; break; }
        }
      });
      if (hit >= Math.max(1, gt.length * 0.6)) {
        // mots non reconnus : entre leurs voisins connus
        for (let k = 0; k < out.length; k++) if (out[k] == null) {
          let a = k - 1; while (a >= 0 && out[a] == null) a--;
          let b = k + 1; while (b < out.length && out[b] == null) b++;
          const ta = a >= 0 ? out[a] : times[i], tb = b < out.length ? out[b] : ends[i];
          out[k] = ta + ((tb - ta) * (k - a)) / (b - a);
        }
        exact[i] = true;
      } else out = null;
    }
    wt[i] = out || spread(gt, times[i], ends[i]);
  });
  return { times, ends, words: wt, exact, matched: idx.length, exactLines: exact.filter(Boolean).length };
}

// Construit un minutage complet à partir des seuls débuts de vers (relevés à la main ou estimés)
export function buildFromTimes(lines, times) {
  const n = lines.length, ends = new Array(n).fill(null), wt = new Array(n).fill(null);
  const order = times.map((t, i) => (t != null ? i : -1)).filter((i) => i >= 0);
  order.forEach((i, k) => {
    const nextT = k + 1 < order.length ? times[order[k + 1]] : Infinity;
    const chars = String(lines[i]).replace(/\s+/g, '').length;
    ends[i] = Math.min(nextT - 0.05, times[i] + Math.max(1.2, chars * 0.085 + 0.6));
    if (ends[i] <= times[i]) ends[i] = times[i] + 0.8;
    const gt = tokens(lines[i]); if (gt.length) wt[i] = spread(gt, times[i], ends[i]);
  });
  return { times, ends, words: wt, exact: new Array(n).fill(false), matched: order.length, exactLines: 0 };
}

// instant -> { i : vers en cours, k : mot en cours, p : avancement du mot 0..1, line : avancement du vers }
export function locate(sync, pos) {
  const { times, ends, words: wt } = sync;
  let cur = -1;
  for (let i = 0; i < times.length; i++) if (times[i] != null && times[i] <= pos) cur = i;
  if (cur < 0) return { i: -1, k: -1, p: 0, line: 0 };
  if (pos > ends[cur] + 0.4) return { i: -1, k: -1, p: 0, line: 0, after: cur }; // pause instrumentale : plus de mot surligné
  const ws = wt[cur] || [];
  let k = -1; for (let m = 0; m < ws.length; m++) if (ws[m] <= pos) k = m;
  const wEnd = k >= 0 && k + 1 < ws.length ? ws[k + 1] : ends[cur];
  const wDur = Math.max(0.12, Math.min((wEnd - (ws[k] ?? times[cur])), 1.2));
  const p = k >= 0 ? Math.max(0, Math.min(1, (pos - ws[k]) / wDur)) : 0;
  return { i: cur, k, p, line: Math.max(0, Math.min(1, (pos - times[cur]) / Math.max(0.5, ends[cur] - times[cur]))) };
}

const loaded = {};
function loadScript(src) {
  return (loaded[src] ||= new Promise((resolve, reject) => {
    const el = document.createElement('script'); el.src = src; el.async = true;
    el.onload = resolve; el.onerror = () => { delete loaded[src]; reject(new Error('script')); };
    document.head.append(el);
  }));
}
const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

export const canSync = (provider) => ['Spotify', 'YouTube', 'SoundCloud'].includes(provider);

// Branche un lecteur déjà affiché (iframe) et appelle onTick(secondes, enLecture). Renvoie une fonction d'arrêt.
export async function attachPlayer(provider, iframe, onTick, onFail) {
  let stop = () => {}; let ctl = null;
  if (provider === 'YouTube') {
    await within(new Promise((resolve) => {
      if (window.YT?.Player) return resolve();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
      loadScript('https://www.youtube.com/iframe_api').catch(() => {});
    }), 8000);
    let timer = null;
    const player = new window.YT.Player(iframe, { events: { onError: (e) => { try { onFail && onFail(e.data); } catch {} }, onStateChange: (e) => {
      clearInterval(timer);
      const playing = e.data === 1;
      const push = () => { try { onTick(player.getCurrentTime(), playing, player.getDuration()); } catch {} };
      push(); if (playing) timer = setInterval(push, 250);
    } } });
    stop = () => { clearInterval(timer); try { player.destroy(); } catch {} };
    ctl = { play: () => player.playVideo(), pause: () => player.pauseVideo(), seek: (sec) => player.seekTo(Math.max(0, sec), true) };
  } else if (provider === 'SoundCloud') {
    await within(loadScript('https://w.soundcloud.com/player/api.js'), 8000);
    const w = window.SC.Widget(iframe);
    let dur = 0; w.bind(window.SC.Widget.Events.READY, () => w.getDuration((ms) => { dur = ms / 1000; }));
    w.bind(window.SC.Widget.Events.PLAY_PROGRESS, (e) => onTick(e.currentPosition / 1000, true, dur));
    w.bind(window.SC.Widget.Events.PAUSE, () => w.getPosition((ms) => onTick(ms / 1000, false)));
    w.bind(window.SC.Widget.Events.FINISH, () => onTick(0, false));
    ctl = { play: () => w.play(), pause: () => w.pause(), seek: (sec) => w.seekTo(Math.max(0, sec) * 1000) };
  }
  return { stop, ctl };
}

// Spotify : l'API officielle crée elle-même le lecteur (events playback_update avec la position en ms).
export async function attachSpotify(host, uri, onTick) {
  const api = await within(new Promise((resolve) => {
    if (window.__spApi) return resolve(window.__spApi);
    window.onSpotifyIframeApiReady = (a) => { window.__spApi = a; resolve(a); };
    loadScript('https://open.spotify.com/embed/iframe-api/v1').catch(() => {});
  }), 8000);
  return new Promise((resolve) => {
    api.createController(host, { uri, width: '100%', height: 80 }, (ctrl) => {
      ctrl.addListener('playback_update', (e) => onTick((e.data.position || 0) / 1000, !e.data.isPaused && !e.data.isBuffering, (e.data.duration || 0) / 1000));
      resolve({ stop: () => { try { ctrl.destroy(); } catch {} }, ctl: { play: () => ctrl.resume(), pause: () => ctrl.pause(), seek: (sec) => ctrl.seek(Math.max(0, sec)) } });
    });
  });
}
