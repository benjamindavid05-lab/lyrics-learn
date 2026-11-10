// Suivi de la musique : associe chaque vers à un instant, puis lit la position du lecteur (Spotify, YouTube, SoundCloud).

const words = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const dice = (a, b) => {
  if (!a.length || !b.length) return 0;
  const m = new Map(); a.forEach((w) => m.set(w, (m.get(w) || 0) + 1));
  let hit = 0; b.forEach((w) => { if (m.get(w) > 0) { hit++; m.set(w, m.get(w) - 1); } });
  return (2 * hit) / (a.length + b.length);
};

// lines : textes des vers (null pour les lignes vides / titres de section) ; lrc : [{t, text}] -> temps (secondes) par vers, ou null
export function alignLines(lines, lrc) {
  const times = new Array(lines.length).fill(null);
  const L = lrc.map((x) => ({ t: x.t, w: words(x.text) }));
  let cursor = 0;
  lines.forEach((text, i) => {
    if (text == null) return;
    const w = words(text); if (!w.length) return;
    let best = -1, bs = 0;
    for (let j = cursor; j < Math.min(L.length, cursor + 10); j++) {
      const s = dice(w, L[j].w) - (j - cursor) * 0.01; // préfère la suite immédiate
      if (s > bs) { bs = s; best = j; }
    }
    if (best >= 0 && bs >= 0.45) { times[i] = L[best].t; cursor = best + 1; }
  });
  // vers non reconnus : on répartit entre les voisins connus
  const idx = times.map((t, i) => (t != null ? i : -1)).filter((i) => i >= 0);
  for (let k = 0; k < idx.length - 1; k++) {
    const a = idx[k], b = idx[k + 1];
    const mid = []; for (let i = a + 1; i < b; i++) if (lines[i] != null && words(lines[i]).length) mid.push(i);
    mid.forEach((i, n) => { times[i] = times[a] + ((times[b] - times[a]) * (n + 1)) / (mid.length + 1); });
  }
  return { times, matched: idx.length };
}

// instant -> { i : vers en cours, p : avancement 0..1 dans ce vers }
export function locate(times, pos) {
  let cur = -1;
  for (let i = 0; i < times.length; i++) if (times[i] != null && times[i] <= pos) cur = i;
  if (cur < 0) return { i: -1, p: 0 };
  let next = null;
  for (let i = cur + 1; i < times.length; i++) if (times[i] != null) { next = times[i]; break; }
  const end = next != null ? next : times[cur] + 5;
  const dur = Math.max(0.5, Math.min(end - times[cur], 8));
  return { i: cur, p: Math.max(0, Math.min(1, (pos - times[cur]) / dur)) };
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
export async function attachPlayer(provider, iframe, onTick) {
  let stop = () => {};
  if (provider === 'YouTube') {
    await within(new Promise((resolve) => {
      if (window.YT?.Player) return resolve();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
      loadScript('https://www.youtube.com/iframe_api').catch(() => {});
    }), 8000);
    let timer = null;
    const player = new window.YT.Player(iframe, { events: { onStateChange: (e) => {
      clearInterval(timer);
      const playing = e.data === 1;
      const push = () => { try { onTick(player.getCurrentTime(), playing); } catch {} };
      push(); if (playing) timer = setInterval(push, 250);
    } } });
    stop = () => { clearInterval(timer); try { player.destroy(); } catch {} };
  } else if (provider === 'SoundCloud') {
    await within(loadScript('https://w.soundcloud.com/player/api.js'), 8000);
    const w = window.SC.Widget(iframe);
    w.bind(window.SC.Widget.Events.PLAY_PROGRESS, (e) => onTick(e.currentPosition / 1000, true));
    w.bind(window.SC.Widget.Events.PAUSE, () => w.getPosition((ms) => onTick(ms / 1000, false)));
    w.bind(window.SC.Widget.Events.FINISH, () => onTick(0, false));
  }
  return stop;
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
      ctrl.addListener('playback_update', (e) => onTick((e.data.position || 0) / 1000, !e.data.isPaused && !e.data.isBuffering));
      resolve(() => { try { ctrl.destroy(); } catch {} });
    });
  });
}
