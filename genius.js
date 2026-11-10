// Extraction des paroles depuis une page Genius (HTML) — sans dépendance.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Renvoie le HTML interne du <div> ouvert en `start` (équilibrage des <div>).
function balancedDiv(html, start) {
  const open = html.indexOf('>', start) + 1;
  const re = /<(\/?)div\b[^>]*>/gi;
  re.lastIndex = open;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { inner: html.slice(open, m.index), end: re.lastIndex };
  }
  return { inner: html.slice(open), end: html.length };
}

function stripExcluded(inner) {
  let out = inner;
  for (;;) {
    const i = out.search(/<div\b[^>]*data-exclude-from-selection="true"/i);
    if (i < 0) return out;
    const { end } = balancedDiv(out, i);
    out = out.slice(0, i) + out.slice(end);
  }
}

export function parseGenius(html) {
  const blocks = [];
  const re = /<div\b[^>]*data-lyrics-container="true"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const { inner, end } = balancedDiv(html, m.index);
    blocks.push(stripExcluded(inner));
    re.lastIndex = end;
  }
  if (!blocks.length) return null;

  const text = decodeEntities(
    blocks.join('\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const meta = (p) => {
    const r = html.match(new RegExp(`<meta[^>]+property="${p}"[^>]+content="([^"]*)"`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="${p}"`, 'i'));
    return r ? decodeEntities(r[1]) : '';
  };
  let title = meta('og:title').replace(/\s*(Lyrics\s*)?\|\s*Genius.*$/i, '').replace(/\s+Lyrics$/i, '').trim();
  let artist = '';
  const sep = title.split(/\s[–—-]\s/);
  if (sep.length >= 2) { artist = sep[0].trim(); title = sep.slice(1).join(' - ').trim(); }
  return { title: title || 'Sans titre', artist, lyrics: text };
}

export function isGeniusUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && /(^|\.)genius\.com$/i.test(url.hostname);
  } catch { return false; }
}

export async function fetchGenius(u) {
  if (!isGeniusUrl(u)) throw new Error('Invalid link: a genius.com URL is required');
  const res = await fetch(u, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
      accept: 'text/html,application/xhtml+xml'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Genius responded ${res.status}. Paste the lyrics manually.`);
  const song = parseGenius(await res.text());
  if (!song) throw new Error('Lyrics not found on this page. Paste them manually.');
  return song;
}
