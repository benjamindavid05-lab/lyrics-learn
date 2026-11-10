// Horodatage des paroles : LRCLIB (base ouverte, sans clé) fournit « [mm:ss.xx] ligne ».
// On ne s'en sert que pour savoir À QUEL MOMENT chaque vers est chanté ; le texte affiché reste celui de Genius.

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function parseLrc(lrc) {
  const out = [];
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const m = raw.match(/^((?:\[\d+:\d+(?:[.:]\d+)?\])+)\s*(.*)$/);
    if (!m) continue;
    const text = m[2].trim();
    for (const tm of m[1].matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)) {
      const frac = tm[3] ? Number(`0.${tm[3]}`) : 0;
      out.push({ t: Number(tm[1]) * 60 + Number(tm[2]) + frac, text });
    }
  }
  return out.filter((x) => x.text).sort((a, b) => a.t - b.t);
}

const cache = new Map();

export async function findSynced({ title, artist, duration = 0 }) {
  const key = `${title}|${artist}|${Math.round(duration)}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.v;
  const q = new URLSearchParams({ track_name: title, artist_name: artist || '' });
  const res = await fetch('https://lrclib.net/api/search?' + q, { headers: { 'user-agent': 'LyricsLearn/1.0' }, signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`Synced lyrics unavailable (${res.status})`);
  const list = (await res.json()).filter((x) => x && x.syncedLyrics);
  const nt = norm(title), na = norm(artist);
  let best = null, bestScore = -1;
  for (const x of list) {
    let sc = 0;
    if (norm(x.trackName) === nt) sc += 4; else if (norm(x.trackName).includes(nt) || nt.includes(norm(x.trackName))) sc += 2;
    if (na && (norm(x.artistName).includes(na) || na.includes(norm(x.artistName)))) sc += 3;
    if (duration && x.duration) sc += Math.max(0, 3 - Math.abs(x.duration - duration) / 4);
    if (sc > bestScore) { best = x; bestScore = sc; }
  }
  const lines = best && bestScore >= 4 ? parseLrc(best.syncedLyrics) : [];
  const v = { lines, duration: best?.duration || 0 };
  if (cache.size > 300) cache.clear();
  cache.set(key, { at: Date.now(), v });
  return v;
}
