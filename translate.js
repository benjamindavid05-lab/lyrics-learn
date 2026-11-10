// Traduction via l'endpoint public de Google Translate (sans clé), avec cache mémoire.


export const LANGUAGES = {
  fr: 'Français', en: 'English', es: 'Español', pt: 'Português', it: 'Italiano', de: 'Deutsch',
  nl: 'Nederlands', sv: 'Svenska', da: 'Dansk', no: 'Norsk', fi: 'Suomi', pl: 'Polski',
  cs: 'Čeština', sk: 'Slovenčina', hu: 'Magyar', ro: 'Română', bg: 'Български', el: 'Ελληνικά',
  ru: 'Русский', uk: 'Українська', tr: 'Türkçe', ar: 'العربية', he: 'עברית', fa: 'فارسی',
  hi: 'हिन्दी', bn: 'বাংলা', ur: 'اردو', ta: 'தமிழ்', th: 'ไทย', vi: 'Tiếng Việt',
  id: 'Bahasa Indonesia', ms: 'Bahasa Melayu', tl: 'Filipino', zh: '中文 (简体)', 'zh-TW': '中文 (繁體)',
  ja: '日本語', ko: '한국어', sw: 'Kiswahili', af: 'Afrikaans', ca: 'Català', hr: 'Hrvatski',
  sr: 'Српски', sl: 'Slovenščina', lt: 'Lietuvių', lv: 'Latviešu', et: 'Eesti', is: 'Íslenska',
  ga: 'Gaeilge', cy: 'Cymraeg', eu: 'Euskara', gl: 'Galego', la: 'Latina', eo: 'Esperanto'
};


// ---------- Google Translate (point d'accès public, gratuit) : il faut le ménager ----------
// Il refuse (429) les rafales. On passe donc par une file d'attente (2 requêtes à la fois, espacées), on regroupe les vers
// en une seule requête, on réessaie en patientant, et on mémorise tout ce qui a déjà été traduit.
const cache = new Map();
const inflight = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_PARALLEL = 2, SPACING_MS = 150;
const queue = []; let active = 0, lastStart = 0, blockedUntil = 0;

function schedule(job) {
  return new Promise((resolve, reject) => { queue.push({ job, resolve, reject }); pump(); });
}
function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const { job, resolve, reject } = queue.shift();
    active++;
    const wait = Math.max(0, lastStart + SPACING_MS - Date.now());
    lastStart = Date.now() + wait;
    setTimeout(() => job().then(resolve, reject).finally(() => { active--; pump(); }), wait);
  }
}

const BASE = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dt=rm&dj=0';
async function googleCall(target, source, text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (Date.now() < blockedUntil) throw new Error('Translation service busy (429)');
    const res = await fetch(`${BASE}&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'q=' + encodeURIComponent(text), signal: AbortSignal.timeout(12000)
    });
    if (res.status === 429 || res.status === 503) {
      const ra = Number(res.headers.get('retry-after')) || 1.2 * (attempt + 1);
      if (attempt === 2) { blockedUntil = Date.now() + 15000; throw new Error(`Translation service busy (${res.status})`); }
      await sleep(Math.min(ra, 4) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Translation unavailable (${res.status})`);
    return res.json();
  }
  throw new Error('Translation service busy (429)');
}

// ---------- MyMemory : service de secours pour les mots et courtes phrases (quota quotidien gratuit) ----------
async function myMemory(text, target, source) {
  const t = text.trim();
  if (!t || Buffer.byteLength(t) > 450) throw new Error('too long for fallback');
  const pair = `${source && source !== 'auto' ? source : 'Autodetect'}|${target}`;
  const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(t)}&langpair=${encodeURIComponent(pair)}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`fallback ${res.status}`);
  const d = await res.json();
  const out = String(d.responseData?.translatedText || '').trim();
  if (Number(d.responseStatus) !== 200 || !out || /MYMEMORY WARNING|INVALID/i.test(out)) throw new Error('fallback refused');
  return out;
}

export async function translate(text, target, source = 'auto') {
  if (!LANGUAGES[target]) throw new Error('Unsupported target language');
  const t = String(text).trim();
  if (!t) return { text: '', translit: '', source };
  const key = `${source}|${target}|${t}`;
  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key); // deux demandes identiques en même temps : une seule requête
  const p = (async () => {
    try {
      const data = await schedule(() => googleCall(target, source, t));
      const segs = data[0] || [];
      const out = { text: segs.map((x) => x[0] || '').join('').trim(), translit: segs.map((x) => x[3] || '').join(' ').trim(), source: data[2] || source };
      if (cache.size > 20000) cache.clear();
      cache.set(key, out);
      return out;
    } catch (e) {
      // Google refuse : on tente le service de secours (mots et courtes phrases uniquement)
      try {
        const alt = await myMemory(t, target, source);
        const out = { text: alt, translit: '', source: source === 'auto' ? '' : source };
        cache.set(key, out);
        return out;
      } catch { throw e; }
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

// Plusieurs vers en une seule requête ; si le découpage ne tombe pas juste, on retraduit ligne par ligne (en file d'attente).
async function translateGroup(lines, target, source) {
  const data = await schedule(() => googleCall(target, source, lines.join('\n')));
  const segs = data[0] || [];
  const joined = segs.filter((x) => x && x[0] != null).map((x) => x[0]).join('');
  const parts = joined.replace(/\n+$/, '').split('\n');
  const rm = segs.filter((x) => x && x[0] == null && x[2]).map((x) => x[2]);
  if (parts.length !== lines.length) return null;
  return parts.map((x, i) => ({ text: x.trim(), translit: rm.length === lines.length ? String(rm[i]).trim() : '', source: data[2] || source }));
}

export async function translateMany(lines, target, source = 'auto') {
  if (!LANGUAGES[target]) throw new Error('Unsupported target language');
  const results = new Array(lines.length);
  const pending = [];
  lines.forEach((l, i) => {
    const key = `${source}|${target}|${String(l).trim()}`;
    if (!String(l).trim()) results[i] = { text: '', translit: '', source };
    else if (cache.has(key)) results[i] = cache.get(key);
    else pending.push(i);
  });
  // groupes de 25 lignes (≈ 1500 caractères) : une requête au lieu de 25
  for (let k = 0; k < pending.length; k += 25) {
    const idx = pending.slice(k, k + 25);
    const texts = idx.map((i) => String(lines[i]).replace(/\s*\n+\s*/g, ' ').trim());
    let group = null;
    try { group = texts.join('\n').length <= 1800 ? await translateGroup(texts, target, source) : null; } catch { group = null; }
    if (group) {
      group.forEach((r, n) => { results[idx[n]] = r; if (cache.size > 20000) cache.clear(); cache.set(`${source}|${target}|${String(lines[idx[n]]).trim()}`, r); });
    } else {
      for (const i of idx) {
        try { results[i] = await translate(lines[i], target, source); }
        catch { results[i] = { text: '', translit: '', source, error: true }; }
      }
    }
  }
  return results;
}
