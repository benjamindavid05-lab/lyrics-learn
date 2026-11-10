import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchGenius } from './genius.js';
import { translate, translateMany, LANGUAGES } from './translate.js';
import { deeplOn, deeplSupports, deeplTranslate, deeplCheck } from './deepl.js';
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
} catch { console.log('.env introuvable : copiez .env.example en .env'); }
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
    if (url.pathname === '/api/status') return json(res, 200, { gemini: llmConfigured(), deepl: deeplOn(), model: llmModel() });
    if (url.pathname === '/api/deepl-check') return json(res, 200, await deeplCheck());
    if (url.pathname === '/api/gemini-check') return json(res, 200, await diagnose());
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
        const ctx = Array.isArray(b.context) ? b.context.slice(0, 600).map(String) : [];
        if (!LANGUAGES[b.target]) throw new Error('Langue cible non supportée');
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
        if (!LANGUAGES[b.target]) throw new Error('Langue cible non supportée');
        if (!hasLLM()) return json(res, 200, { words: null });
        try {
          const words = await suggestVocab(Array.isArray(b.lines) ? b.lines.slice(0, 400).map(String) : [], LANGUAGES[b.target], b.source || 'auto', Math.min(Number(b.n) || 8, 25), Array.isArray(b.exclude) ? b.exclude.slice(0, 100).map(String) : []);
          return json(res, 200, { words });
        } catch { return json(res, 200, { words: null }); }
      }
      if (url.pathname === '/api/translate-words') {
        const items = Array.isArray(b.items) ? b.items.slice(0, 60).map((x) => ({ text: String(x.text), context: String(x.context || '') })) : [];
        if (!LANGUAGES[b.target]) throw new Error('Langue cible non supportée');
        if (b.fast !== true && hasLLM()) {
          try { return json(res, 200, { results: await translateItems(items, LANGUAGES[b.target], b.source || 'auto'), engine: 'gemini' }); } catch { /* repli */ }
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
