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

// Fichier « lyricsfile » de LRCLIB (YAML) : vers avec, quand il existe, l'instant de chaque mot.
function unq(v) {
  v = String(v ?? '').trim();
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  return v;
}
export function parseLyricsFile(yaml) {
  const lines = []; let L = null, W = null;
  for (const raw of String(yaml || '').split(/\r?\n/)) {
    let m;
    if ((m = raw.match(/^- text:\s?(.*)$/))) { L = { t: 0, text: unq(m[1]).trim(), words: [] }; W = null; lines.push(L); }
    else if (!L) continue;
    else if ((m = raw.match(/^  - text:\s?(.*)$/))) { W = { w: unq(m[1]).trim(), t: null }; L.words.push(W); }
    else if ((m = raw.match(/^    start_ms:\s*(\d+)/)) && W) W.t = Number(m[1]) / 1000;
    else if ((m = raw.match(/^  start_ms:\s*(\d+)/))) L.t = Number(m[1]) / 1000;
    else if ((m = raw.match(/^  end_ms:\s*(\d+)/))) L.end = Number(m[1]) / 1000;
  }
  return lines.filter((l) => l.text).map((l) => {
    const ws = l.words.filter((w) => w.w && w.t != null);
    const out = { t: l.t, text: l.text };
    if (l.end != null) out.end = l.end;
    if (ws.length >= 2) out.words = ws;
    return out;
  });
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
  let lines = [], wordSync = false;
  if (best && bestScore >= 4) {
    // préférence pour une version avec minutage mot à mot, à durée comparable
    const ws = list.filter((x) => x.hasWordSync && x.lyricsfile && norm(x.trackName) === norm(best.trackName) && (!best.duration || !x.duration || Math.abs(x.duration - best.duration) <= 3));
    for (const x of ws) {
      const parsed = parseLyricsFile(x.lyricsfile);
      if (parsed.filter((l) => l.words).length >= Math.max(3, parsed.length * 0.5)) { lines = parsed; wordSync = true; best = x; break; }
    }
    if (!wordSync) lines = parseLrc(best.syncedLyrics);
  }
  const v = { lines, duration: best?.duration || 0, wordSync };
  if (cache.size > 300) cache.clear();
  cache.set(key, { at: Date.now(), v });
  return v;
}
