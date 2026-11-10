// Lien copié depuis un lecteur (Spotify, YouTube, Apple Music, Deezer, SoundCloud) -> titre + artiste, pour chercher la chanson sur Genius.
// Seuls ces sites sont interrogés (pas de requête vers une adresse choisie par l'utilisateur).

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; LyricsLearn/1.0)', 'accept-language': 'en' };
const get = (u, opts = {}) => fetch(u, { headers: UA, signal: AbortSignal.timeout(8000), ...opts });
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const meta = (html, prop) => decode((html.match(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, 'i')) || html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${prop}"`, 'i')) || [])[1]);

// « Queen – Bohemian Rhapsody (Official Video Remastered) » -> { artist: 'Queen', title: 'Bohemian Rhapsody' }
const JUNK = /\s*[\(\[][^)\]]*(official|video|lyric|audio|visuali[sz]er|remaster|hd|4k|clip|live|mv|music)[^)\]]*[\)\]]/gi;
export function cleanYoutubeTitle(raw, channel) {
  let t = decode(raw).replace(JUNK, '').replace(/\s*\|.*$/, '').replace(/\s+/g, ' ').trim();
  const ch = decode(channel).replace(/\s*-\s*Topic$/i, '').replace(/\s*(VEVO|Official|Music)\s*$/i, '').trim();
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: ch, title: t };
}

export function streamingHost(input) {
  let u; try { u = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname.toLowerCase().replace(/^((www|m|music|open|embed|play)\.)+/, '');
  const kind = h === 'spotify.com' ? 'spotify' : (h === 'youtube.com' || h === 'youtu.be') ? 'youtube' : h === 'apple.com' ? 'apple' : h === 'deezer.com' ? 'deezer' : h === 'soundcloud.com' ? 'soundcloud' : '';
  return kind ? { kind, url: u } : null;
}

// « Au Revoir (feat. Sido) » / « Au Revoir ft. Sido » -> « Au Revoir » : Genius trouve mieux sans l'invité
const tidy = (r) => ({ title: String(r.title || '').replace(/\s*[\(\[]\s*(feat|ft|featuring)\b[^)\]]*[\)\]]/i, '').replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, '').trim(), artist: String(r.artist || '').trim() });
export async function resolveTrackLink(input) { return tidy(await resolveRaw(input)); }
async function resolveRaw(input) {
  const host = streamingHost(input); if (!host) throw new Error('Unsupported link');
  const { kind, url } = host, href = url.href;
  if (kind === 'spotify') {
    const m = url.pathname.match(/\/track\/([A-Za-z0-9]+)/); if (!m) throw new Error('Paste a Spotify track link');
    const html = await (await get(`https://open.spotify.com/track/${m[1]}`)).text();
    const title = meta(html, 'og:title'), artist = (meta(html, 'og:description').split('·')[0] || '').trim();
    if (!title) throw new Error('Track not found');
    return { title: title.replace(JUNK, '').trim(), artist: artist.split(',')[0].trim() };
  }
  if (kind === 'youtube') {
    const r = await get('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(href));
    if (!r.ok) throw new Error('Video not found');
    const d = await r.json(); return cleanYoutubeTitle(d.title, d.author_name);
  }
  if (kind === 'soundcloud') {
    const r = await get('https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent(href));
    if (!r.ok) throw new Error('Track not found');
    const d = await r.json(); const m = String(d.title || '').match(/^(.+) by (.+)$/);
    return m ? { title: decode(m[1]), artist: decode(m[2]) } : { title: decode(d.title), artist: decode(d.author_name) };
  }
  if (kind === 'deezer') {
    const m = url.pathname.match(/\/track\/(\d+)/); if (!m) throw new Error('Paste a Deezer track link');
    const d = await (await get(`https://api.deezer.com/track/${m[1]}`)).json();
    if (!d || !d.title) throw new Error('Track not found');
    return { title: String(d.title_short || d.title), artist: d.artist?.name || '' };
  }
  // Apple Music
  if (!/^\/[a-z]{2}\/(song|album)\//i.test(url.pathname)) throw new Error('Paste an Apple Music song link');
  const html = await (await get('https://music.apple.com' + url.pathname + (url.searchParams.get('i') ? `?i=${encodeURIComponent(url.searchParams.get('i'))}` : ''))).text();
  const t = meta(html, 'og:title').replace(/[\s ]+on[\s ]+Apple[\s ]+Music\s*$/i, ''); const m = t.match(/^(.+) by (.+)$/);
  if (!m) throw new Error('Track not found');
  return { title: m[1].replace(JUNK, '').trim(), artist: m[2].trim() };
}
