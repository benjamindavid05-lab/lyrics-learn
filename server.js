import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchGenius } from './genius.js';
import { translate, translateMany, LANGUAGES } from './translate.js';

try { // mini chargeur .env (GENIUS_TOKEN=...)
  for (const l of (await fs.readFile(new URL('./.env', import.meta.url), 'utf8')).split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
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

async function api(req, res, url) {
  try {
    if (url.pathname === '/api/languages') return json(res, 200, LANGUAGES);
    if (url.pathname === '/api/search') {
      const token = process.env.GENIUS_TOKEN;
      if (!token) return json(res, 200, { needsToken: true, hits: [] });
      const r = await fetch('https://api.genius.com/search?per_page=8&q=' + encodeURIComponent(url.searchParams.get('q') || ''), {
        headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) throw new Error(r.status === 401 ? 'Jeton Genius invalide' : `Recherche Genius indisponible (${r.status})`);
      const data = await r.json();
      const hits = (data.response?.hits || []).filter((h) => h.type === 'song').map(({ result: x }) => ({
        title: x.title, artist: x.primary_artist?.name || '', url: x.url, thumb: x.song_art_image_thumbnail_url || ''
      }));
      return json(res, 200, { hits });
    }
    if (url.pathname === '/api/lyrics' && req.method === 'GET') {
      return json(res, 200, await fetchGenius(url.searchParams.get('url') || ''));
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (url.pathname === '/api/translate-lines') {
        const lines = Array.isArray(b.lines) ? b.lines.slice(0, 600).map(String) : [];
        return json(res, 200, { results: await translateMany(lines, b.target, b.source || 'auto') });
      }
      if (url.pathname === '/api/translate') {
        return json(res, 200, await translate(b.text || '', b.target, b.source || 'auto'));
      }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) { json(res, 502, { error: e.message }); }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(PORT, () => console.log(`Lyrics Learn → http://localhost:${PORT}`));
