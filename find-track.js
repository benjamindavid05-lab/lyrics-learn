// Retrouve, sur chaque service, le morceau qui correspond à (titre, artiste), pour l'afficher dans un lecteur intégré.
// Deezer et Apple Music (iTunes) : API publiques sans clé. Spotify et YouTube : facultatifs, avec clé (variables d'environnement).

const UA = 'LyricsLearn/1.0 (+https://github.com/benjamindavid05-lab/lyrics-learn)';

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const tokens = (s) => new Set(norm(s).split(' ').filter(Boolean));

// « Eden Derso - עדן דרסו » -> ["Eden Derso - עדן דרסו", "Eden Derso", "עדן דרסו"] (graphie latine ET d'origine)
export function variants(s) {
  const raw = String(s || '').trim();
  const clean = (x) => x.replace(/\(.*?\)|\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
  const parts = raw.split(/\s[-–—]\s/).map(clean).filter(Boolean);
  return [...new Set((parts.length > 1 ? parts : [clean(raw)]).filter(Boolean))];
}

export function sim(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  const na = norm(a), nb = norm(b);
  if (na === nb) return 1;
  if (na.length >= 3 && nb.length >= 3 && (` ${nb} `.includes(` ${na} `) || ` ${na} `.includes(` ${nb} `))) return 0.9;
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}

// Choisit le meilleur candidat { title, artist, ... } ; refuse s'il ne ressemble pas assez.
export function best(cands, wantTitles, wantArtists) {
  let top = null, topScore = 0;
  for (const c of cands) {
    const ts = Math.max(0, ...wantTitles.map((w) => sim(c.title, w)));
    const as = wantArtists.length ? Math.max(0, ...wantArtists.map((w) => sim(c.artist, w))) : 1;
    if (ts < 0.6 || as < 0.34) continue;
    const score = ts + as;
    if (score > topScore) { top = c; topScore = score; }
  }
  return top;
}

export function cleanApple(u) {
  try {
    const x = new URL(u);
    if (!/(^|\.)apple\.com$/.test(x.hostname)) return '';
    const path = x.pathname.replace(/[^A-Za-z0-9/_%.\-]/g, '');
    const i = x.searchParams.get('i');
    if (!/^\/[a-z]{2}\/(album|song)\//i.test(path)) return '';
    return `https://music.apple.com${path}${i && /^\d+$/.test(i) ? `?i=${i}` : ''}`;
  } catch { return ''; }
}

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
const q = encodeURIComponent;
const firstN = (arr, n) => arr.slice(0, n);

async function deezer(wt, wa) {
  // Deezer range souvent le titre en graphie d'origine et l'artiste en lettres latines : on croise toutes les graphies.
  const queries = [];
  for (const a of firstN(wa.length ? wa : [''], 2)) for (const t of firstN(wt, 2)) queries.push(`${a} ${t}`.trim());
  for (const a of firstN(wa, 2)) for (const t of firstN(wt, 2)) queries.push(`artist:"${a}" track:"${t}"`);
  for (const query of [...new Set(queries)]) {
    const d = await getJson(`https://api.deezer.com/search/track?limit=6&q=${q(query)}`);
    const m = best((d.data || []).map((x) => ({ title: x.title, artist: x.artist?.name, id: x.id })), wt, wa);
    if (m && /^\d+$/.test(String(m.id))) return `https://www.deezer.com/track/${m.id}`;
  }
  return '';
}

async function apple(wt, wa) {
  for (const country of ['us', 'il', 'fr']) {
    const terms = [`${wa[0] || ''} ${wt[0]}`.trim(), `${wa[wa.length - 1] || ''} ${wt[wt.length - 1]}`.trim()];
    for (const term of [...new Set(terms)]) {
      const d = await getJson(`https://itunes.apple.com/search?media=music&entity=song&limit=8&country=${country}&term=${q(term)}`);
      const m = best((d.results || []).map((x) => ({ title: x.trackName, artist: x.artistName, url: x.trackViewUrl })), wt, wa);
      const u = m && cleanApple(m.url);
      if (u) return u;
    }
  }
  return '';
}

let spotifyToken = { v: '', exp: 0 };
async function spotify(wt, wa) {
  const id = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return '';
  if (Date.now() > spotifyToken.exp) {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    if (!r.ok) throw new Error('spotify auth ' + r.status);
    const j = await r.json(); spotifyToken = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  }
  for (const a of firstN(wa, 2)) for (const t of firstN(wt, 2)) {
    const d = await getJson(`https://api.spotify.com/v1/search?type=track&limit=6&q=${q(`track:${t} artist:${a}`)}`, { authorization: 'Bearer ' + spotifyToken.v });
    const m = best((d.tracks?.items || []).map((x) => ({ title: x.name, artist: (x.artists || []).map((y) => y.name).join(' '), id: x.id })), wt, wa);
    if (m && /^[A-Za-z0-9]{10,30}$/.test(m.id)) return `https://open.spotify.com/track/${m.id}`;
  }
  return '';
}

async function youtube(wt, wa) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return '';
  const d = await getJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${q(`${wa[0] || ''} ${wt[0]}`.trim())}&key=${q(key)}`);
  for (const it of d.items || []) {
    const title = it.snippet?.title || '', chan = it.snippet?.channelTitle || '';
    const okTitle = wt.some((w) => sim(title, w) >= 0.5), okArtist = !wa.length || wa.some((w) => sim(`${title} ${chan}`, w) >= 0.34);
    if (okTitle && okArtist && /^[A-Za-z0-9_-]{6,15}$/.test(it.id?.videoId || '')) return `https://www.youtube.com/watch?v=${it.id.videoId}`;
  }
  return '';
}

const ok = (r) => (r.status === 'fulfilled' ? r.value || '' : '');

export async function findTracks({ title, artist }) {
  const wt = variants(title), wa = variants(artist);
  if (!wt.length) return { deezer: '', apple: '', spotify: '', youtube: '' };
  const [dz, ap, sp, yt] = await Promise.allSettled([deezer(wt, wa), apple(wt, wa), spotify(wt, wa), youtube(wt, wa)]);
  return { deezer: ok(dz), apple: ok(ap), spotify: ok(sp), youtube: ok(yt) };
}

// Vérifie que les identifiants Spotify fonctionnent (sans jamais les afficher).
export async function spotifyCheck() {
  const id = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return { configured: false, help: 'Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the environment variables.' };
  const sizes = { clientIdLength: id.length, clientSecretLength: secret.length };
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    if (!r.ok) return { configured: true, ok: false, step: 'token', status: r.status, ...sizes, help: r.status === 400 || r.status === 401 ? 'Spotify rejected the Client ID / Client secret: copy both again from the app Settings page (each is 32 characters).' : 'Spotify did not respond normally.' };
    const j = await r.json();
    const s = await fetch(`https://api.spotify.com/v1/search?type=track&limit=1&q=${q('track:Never Gonna Give You Up artist:Rick Astley')}`, { headers: { authorization: 'Bearer ' + j.access_token }, signal: AbortSignal.timeout(8000) });
    const body = s.ok ? await s.json() : null;
    return { configured: true, ok: s.ok, step: 'search', status: s.status, ...sizes, found: body?.tracks?.items?.[0]?.name || '', help: s.ok ? 'Spotify search works.' : 'Token accepted, but the search was refused: Spotify may be restricting this app.' };
  } catch (e) { return { configured: true, ok: false, error: e.message, ...sizes }; }
}
