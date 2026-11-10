// Traduction via l'endpoint public de Google Translate (sans clé), avec cache mémoire.

const cache = new Map();

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

export async function translate(text, target, source = 'auto') {
  if (!LANGUAGES[target]) throw new Error('Langue cible non supportée');
  const t = String(text).trim();
  if (!t) return { text: '', translit: '', source: source };
  const key = `${source}|${target}|${t}`;
  if (cache.has(key)) return cache.get(key);

  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dt=rm&dj=0'
    + `&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(t)}`;
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`Traduction indisponible (${res.status})`);
      const data = await res.json();
      const segs = data[0] || [];
      const out = {
        text: segs.map((s) => s[0] || '').join('').trim(),
        translit: segs.map((s) => s[3] || '').join(' ').trim(),
        source: data[2] || source
      };
      if (cache.size > 20000) cache.clear();
      cache.set(key, out);
      return out;
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  throw lastErr;
}

export async function translateMany(lines, target, source = 'auto', concurrency = 6) {
  const results = new Array(lines.length);
  let next = 0;
  async function worker() {
    while (next < lines.length) {
      const i = next++;
      try { results[i] = await translate(lines[i], target, source); }
      catch { results[i] = { text: '', translit: '', source, error: true }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, lines.length) }, worker));
  return results;
}
