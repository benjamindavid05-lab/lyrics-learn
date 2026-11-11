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

// Sans clé : résultats publics de recherche YouTube (on ne garde que des vidéos intégrables dont le titre ressemble au morceau)
const BAD = /\b(live|cover|karaoke|acoustic|session|remix|reaction|instrumental|slowed|sped|nightcore|8d|tutorial|lesson|piano|guitar|fernsehgarten|translation|traduction|subtitulado)\b/i;
export function parseYoutubeResults(html) {
  const out = [];
  const un = (x) => x.replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  for (const c of String(html).split('"videoRenderer":{"videoId":"').slice(1)) {
    const id = c.slice(0, 11);
    const t = c.match(/"title":\{"runs":\[\{"text":"(.*?)"\}/), o = c.match(/"ownerText":\{"runs":\[\{"text":"(.*?)"/), l = c.match(/"lengthText":\{.{0,240}?"simpleText":"([0-9:]+)"/);
    if (!/^[A-Za-z0-9_-]{11}$/.test(id) || !t) continue;
    const secs = l ? l[1].split(':').reduce((acc, x) => acc * 60 + Number(x), 0) : 0; // durée affichée (mm:ss ou h:mm:ss)
    out.push({ id, title: un(t[1]), channel: o ? un(o[1]) : '', secs });
    if (out.length >= 14) break;
  }
  return out;
}
async function youtubeScrape(wt, wa) {
  const r = await fetch('https://www.youtube.com/results?search_query=' + q(`${wa[0] || ''} ${wt[0]} official video`.trim()), {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; LyricsLearn/1.0)', 'accept-language': 'en', cookie: 'CONSENT=YES+1' }, signal: AbortSignal.timeout(9000)
  });
  if (!r.ok) return [];
  const cands = parseYoutubeResults(await r.text()).map((c) => {
    let sc = 0;
    if (!wt.some((w) => sim(c.title, w) >= 0.4 || norm(c.title).includes(norm(w)))) return { ...c, sc: -1 };
    if (BAD.test(c.title)) return { ...c, sc: -1 };
    if (wa.length && wa.some((a) => sim(c.channel, a) >= 0.5 || norm(c.channel).includes(norm(a)))) sc += 3;
    if (wa.length && wa.some((a) => norm(c.title).includes(norm(a)))) sc += 2;
    if (/official/i.test(c.title)) sc += 2; if (/lyric|audio/i.test(c.title)) sc += 1;
    return { ...c, sc };
  }).filter((c) => c.sc >= 2).sort((a, b) => b.sc - a.sc);
  const found = []; found.secs = {}; // durée de chaque vidéo : sert à choisir celle dont le montage correspond au minutage des paroles
  for (const c of cands.slice(0, 8)) {
    // oEmbed refuse (401) les vidéos dont l'intégration est interdite
    try { const o = await fetch('https://www.youtube.com/oembed?format=json&url=' + q('https://www.youtube.com/watch?v=' + c.id), { signal: AbortSignal.timeout(6000) }); if (o.ok) { const u = `https://www.youtube.com/watch?v=${c.id}`; found.push(u); found.secs[u] = c.secs; } } catch { /* suivant */ }
    if (found.length >= 6) break;
  }
  return found;
}

async function youtube(wt, wa) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return youtubeScrape(wt, wa); // liste de candidats
  const d = await getJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${q(`${wa[0] || ''} ${wt[0]}`.trim())}&key=${q(key)}`);
  const out = [];
  for (const it of d.items || []) {
    const title = it.snippet?.title || '', chan = it.snippet?.channelTitle || '';
    const okTitle = wt.some((w) => sim(title, w) >= 0.5), okArtist = !wa.length || wa.some((w) => sim(`${title} ${chan}`, w) >= 0.34);
    if (okTitle && okArtist && /^[A-Za-z0-9_-]{6,15}$/.test(it.id?.videoId || '')) out.push(`https://www.youtube.com/watch?v=${it.id.videoId}`);
  }
  return out;
}

const ok = (r) => (r.status === 'fulfilled' ? r.value || '' : '');

export async function findTracks({ title, artist }) {
  const wt = variants(title), wa = variants(artist);
  if (!wt.length) return { deezer: '', apple: '', spotify: '', youtube: '', youtubeAlts: [] };
  const [dz, ap, sp, yt] = await Promise.allSettled([deezer(wt, wa), apple(wt, wa), spotify(wt, wa), youtube(wt, wa)]);
  const yts = yt.status === 'fulfilled' && Array.isArray(yt.value) ? yt.value : [];
  return { deezer: ok(dz), apple: ok(ap), spotify: ok(sp), youtube: yts[0] || '', youtubeAlts: yts.slice(1), youtubeSecs: yts.secs || {} };
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
