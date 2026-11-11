import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchGenius } from './genius.js';
import { translate, translateMany, LANGUAGES } from './translate.js';
import { deeplOn, deeplSupports, deeplTranslate, deeplCheck } from './deepl.js';
import { extractMedia } from './genius-media.js';
import { findTracks, spotifyCheck } from './find-track.js';
import { findSynced } from './synced.js';
import { resolveTrackLink } from './track-link.js';
import { hasLLM, llmConfigured, llmModel, translateLyrics, translateItems, suggestVocab, diagnose } from './llm.js';

try { // mini chargeur .env (GENIUS_TOKEN=...)
  const raw = await fs.readFile(new URL('./.env', import.meta.url), 'utf8');
  const found = [];
  for (const l of raw.split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !process.env[m[1]]) { process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); found.push(m[1]); }
  }
  console.log(`.env lu : ${found.length ? found.join(', ') : 'aucune clé trouvée'}`);
  if (/^\{\\rtf/.test(raw.trim())) console.log('⚠ .env est en « texte enrichi » (TextEdit) : Format > Convertir au format texte, puis enregistrez.');
} catch { console.log('No .env file: using environment variables.'); }
const mediaCache = new Map();
const trackCache = new Map();
const searchCache = new Map(); // évite de rappeler Genius pour la même recherche
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = process.env.PORT || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1e6) throw new Error('Corps trop volumineux'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

// Limites d'usage par personne (adresse IP) : actives dès que l'app est hébergée (RENDER) ou avec RATE_LIMIT=on.
const HOSTED = process.env.RATE_LIMIT !== 'off' && !!(process.env.RENDER || process.env.RATE_LIMIT === 'on');
const LIM = { hour: +process.env.LIMIT_PER_HOUR || 250, day: +process.env.LIMIT_PER_DAY || 1000, global: +process.env.LIMIT_GLOBAL_PER_DAY || 8000 };
const buckets = new Map();
let globalCount = { day: '', n: 0 };
const COUNTED = new Set(['/api/find-track', '/api/synced', '/api/track-link', '/api/song-media', '/api/translate-lines', '/api/translate-words', '/api/translate', '/api/suggest-words', '/api/search', '/api/lyrics']);
const clientIp = (req) => ((process.env.RENDER || process.env.TRUST_PROXY) ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'inconnu';
function rateLimit(req) {
  if (!HOSTED) return null;
  const now = Date.now(), today = new Date().toISOString().slice(0, 10);
  if (globalCount.day !== today) globalCount = { day: today, n: 0 };
  if (globalCount.n >= LIM.global) return 'The service has reached its daily limit. Please try again tomorrow.';
  const ip = clientIp(req);
  let b = buckets.get(ip);
  if (!b) { b = { hStart: now, h: 0, day: today, d: 0 }; buckets.set(ip, b); }
  if (now - b.hStart > 3600e3) { b.hStart = now; b.h = 0; }
  if (b.day !== today) { b.day = today; b.d = 0; }
  if (b.h >= LIM.hour) return `Hourly limit reached: try again in ${Math.max(1, Math.ceil((3600e3 - (now - b.hStart)) / 60e3))} min.`;
  if (b.d >= LIM.day) return 'Daily limit reached: try again tomorrow.';
  b.h++; b.d++; globalCount.n++;
  if (buckets.size > 5000) for (const [k, x] of buckets) if (now - x.hStart > 7200e3) buckets.delete(k);
  return null;
}

async function api(req, res, url) {
  if (COUNTED.has(url.pathname)) { const limited = rateLimit(req); if (limited) return json(res, 429, { error: limited }); }
  try {
    if (url.pathname === '/api/status') return json(res, 200, { gemini: llmConfigured(), deepl: deeplOn(), model: llmModel() });
    if (url.pathname === '/api/spotify-check') return json(res, 200, await spotifyCheck());
    if (url.pathname === '/api/find-track') {
      // Retrouve le morceau sur Deezer, Apple Music (et Spotify / YouTube si des clés sont configurées) pour les lecteurs intégrés
      const title = (url.searchParams.get('title') || '').trim().slice(0, 160), artist = (url.searchParams.get('artist') || '').trim().slice(0, 160);
      if (!title) return json(res, 200, { tracks: {} });
      const ck = `${title}|${artist}`.toLowerCase(), hit = trackCache.get(ck);
      if (hit && Date.now() - hit.at < (hit.any ? 3600e3 : 600e3)) return json(res, 200, { tracks: hit.tracks });
      const tracks = await findTracks({ title, artist });
      if (trackCache.size > 500) trackCache.clear();
      trackCache.set(ck, { at: Date.now(), tracks, any: Object.values(tracks).some(Boolean) });
      return json(res, 200, { tracks });
    }
    if (url.pathname === '/api/track-link') {
      // Lien Spotify / YouTube / Apple Music / Deezer / SoundCloud -> titre et artiste (pour retrouver la chanson sur Genius)
      try { return json(res, 200, await resolveTrackLink((url.searchParams.get('url') || '').trim().slice(0, 400))); }
      catch (e) { return json(res, 404, { error: String(e.message || 'Link not recognised').slice(0, 120) }); }
    }
    if (url.pathname === '/api/synced') {
      // Horodatage des vers pour suivre la musique (jamais bloquant : sans résultat, la lecture reste normale)
      const title = (url.searchParams.get('title') || '').trim().slice(0, 160), artist = (url.searchParams.get('artist') || '').trim().slice(0, 160);
      if (!title) return json(res, 200, { lines: [] });
      try { return json(res, 200, await findSynced({ title, artist, duration: Number(url.searchParams.get('d')) || 0 })); }
      catch { return json(res, 200, { lines: [] }); }
    }
    if (url.pathname === '/api/song-media') {
      // Liens d'écoute connus de Genius pour une chanson (jamais bloquant : sans lien, l'app propose des recherches)
      const token = process.env.GENIUS_TOKEN, id = String(url.searchParams.get('id') || '').replace(/\D/g, '').slice(0, 12);
      if (!token || !id) return json(res, 200, { media: {} });
      const hit = mediaCache.get(id);
      if (hit && Date.now() - hit.at < 3600e3) return json(res, 200, { media: hit.media });
      try {
        const r = await fetch(`https://api.genius.com/songs/${id}?text_format=plain`, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) return json(res, 200, { media: {} });
        const media = extractMedia((await r.json()).response?.song);
        if (mediaCache.size > 500) mediaCache.clear();
        mediaCache.set(id, { at: Date.now(), media });
        return json(res, 200, { media });
      } catch { return json(res, 200, { media: {} }); }
    }
    if (url.pathname === '/api/genius-check') {
      const token = process.env.GENIUS_TOKEN;
      if (!token) return json(res, 200, { configured: false });
      try {
        const r = await fetch('https://api.genius.com/search?q=test', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) });
        return json(res, 200, { configured: true, ok: r.ok, status: r.status, tokenLength: token.length,
          help: r.ok ? 'The token works.' : r.status === 401 ? 'Token rejected: generate a “Client Access Token” on genius.com/api-clients (not the Client ID or the Client Secret).' : 'Genius is not responding normally.' });
      } catch (e) { return json(res, 200, { configured: true, ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/deepl-check') return json(res, 200, await deeplCheck());
    if (url.pathname === '/api/gemini-check') return json(res, 200, await diagnose());
    if (url.pathname === '/api/languages') return json(res, 200, LANGUAGES);
    if (url.pathname === '/api/search') {
      const token = process.env.GENIUS_TOKEN;
      if (!token) return json(res, 200, { needsToken: true, hits: [] });
      const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
      const ck = q.toLowerCase(), hit = searchCache.get(ck);
      if (hit && Date.now() - hit.at < 60000) return json(res, 200, { hits: hit.hits });
      const r = await fetch('https://api.genius.com/search?per_page=8&q=' + encodeURIComponent(q), {
        headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) throw new Error(r.status === 401 ? 'Genius token rejected: use the “Client Access Token” (see /api/genius-check).' : `Genius search unavailable (${r.status})`);
      const data = await r.json();
      const hits = (data.response?.hits || []).filter((h) => h.type === 'song').map(({ result: x }) => ({
        id: x.id, title: x.title, artist: x.primary_artist?.name || '', url: x.url, thumb: x.song_art_image_thumbnail_url || ''
      }));
      if (searchCache.size > 200) searchCache.clear();
      searchCache.set(ck, { at: Date.now(), hits });
      return json(res, 200, { hits });
    }
    if (url.pathname === '/api/lyrics' && req.method === 'GET') {
      return json(res, 200, await fetchGenius(url.searchParams.get('url') || ''));
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (url.pathname === '/api/translate-lines') {
        const lines = Array.isArray(b.lines) ? b.lines.slice(0, 600).map(String) : [];
        const ctx = Array.isArray(b.context) ? b.context.slice(0, 600).map(String) : [];
        if (!LANGUAGES[b.target]) throw new Error('Unsupported target language');
        let warning = '';
        if (b.fast !== true && hasLLM()) {
          try {
            const r = await translateLyrics(lines, LANGUAGES[b.target], b.source || 'auto', ctx);
            return json(res, 200, { ...r, engine: 'gemini' });
          } catch (e) { warning = e.message; }
        }
        if (deeplSupports(b.target)) {
          try {
            const r = await deeplTranslate(lines, b.target, b.source || 'auto');
            return json(res, 200, { results: r.map((x) => ({ text: x.text, translit: '', source: x.source })), source: r[0]?.source || '', engine: 'deepl', warning });
          } catch (e) { warning = warning || e.message; }
        }
        const results = await translateMany(lines, b.target, b.source || 'auto');
        return json(res, 200, { results, source: results.find((r) => r.source)?.source || '', engine: 'google', warning });
      }
      if (url.pathname === '/api/suggest-words') {
        if (!LANGUAGES[b.target]) throw new Error('Unsupported target language');
        if (!hasLLM()) return json(res, 200, { words: null });
        try {
          const words = await suggestVocab(Array.isArray(b.lines) ? b.lines.slice(0, 400).map(String) : [], LANGUAGES[b.target], b.source || 'auto', Math.min(Number(b.n) || 8, 25), Array.isArray(b.exclude) ? b.exclude.slice(0, 100).map(String) : []);
          return json(res, 200, { words });
        } catch { return json(res, 200, { words: null }); }
      }
      if (url.pathname === '/api/translate-words') {
        const items = Array.isArray(b.items) ? b.items.slice(0, 60).map((x) => ({ text: String(x.text), context: String(x.context || '') })) : [];
        if (!LANGUAGES[b.target]) throw new Error('Unsupported target language');
        if (b.fast !== true && hasLLM()) {
          try { return json(res, 200, { results: await translateItems(items, LANGUAGES[b.target], b.source || 'auto', b.llmOnly ? 45000 : 6000), engine: 'gemini' }); } catch { /* repli */ }
        }
        if (b.llmOnly) throw new Error('Gemini indisponible');
        if (deeplSupports(b.target)) {
          try { const r = await deeplTranslate(items.map((x) => x.text), b.target, b.source || 'auto'); return json(res, 200, { results: r.map((x) => ({ text: x.text, translit: '', note: '' })), engine: 'deepl' }); } catch { /* repli */ }
        }
        return json(res, 200, { results: await translateMany(items.map((x) => x.text), b.target, b.source || 'auto'), engine: 'google' });
      }
      if (url.pathname === '/api/translate') {
        const text = b.text || '';
        if (b.fast !== true && hasLLM() && text.trim()) {
          try {
            const [r] = await translateItems([{ text, context: b.context || '' }], LANGUAGES[b.target], b.source || 'auto');
            return json(res, 200, { ...r, engine: 'gemini' });
          } catch { /* repli */ }
        }
        if (text.trim() && deeplSupports(b.target)) {
          try { const [r] = await deeplTranslate([text], b.target, b.source || 'auto', b.context || ''); return json(res, 200, { text: r.text, translit: '', note: '', source: r.source, engine: 'deepl' }); } catch { /* repli */ }
        }
        return json(res, 200, { ...(await translate(text, b.target, b.source || 'auto')), engine: 'google' });
      }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) { json(res, 502, { error: e.message }); }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok ' + String(process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7)); } // version en ligne
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  const rel = url.pathname === '/' ? 'index.html' : (url.pathname === '/confidentialite.html' ? 'privacy.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    let data = await fs.readFile(file);
    if (path.basename(file) === 'privacy.html') {
      const mail = String(process.env.CONTACT_EMAIL || '').replace(/[^A-Za-z0-9@._+-]/g, '');
      const link = mail ? `<a href="mailto:${mail}">${mail}</a>` : '';
      data = Buffer.from(data.toString()
        .replaceAll('{{CONTACT_EN}}', link || 'the site owner (contact details to be set with the CONTACT_EMAIL variable)')
        .replaceAll('{{CONTACT_FR}}', link || 'le propriétaire du site (coordonnées à renseigner par la variable CONTACT_EMAIL)'));
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(PORT, () => console.log(`Lyrio → http://localhost:${PORT}`));
