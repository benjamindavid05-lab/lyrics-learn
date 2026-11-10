// Traduction via l'API DeepL (clé gratuite « :fx » ou Pro). Clé dans DEEPL_API_KEY (.env).

const TARGETS = {
  fr: 'FR', en: 'EN-GB', es: 'ES', pt: 'PT-PT', it: 'IT', de: 'DE', nl: 'NL', sv: 'SV', da: 'DA', no: 'NB', fi: 'FI',
  pl: 'PL', cs: 'CS', sk: 'SK', hu: 'HU', ro: 'RO', bg: 'BG', el: 'EL', ru: 'RU', uk: 'UK', tr: 'TR', ar: 'AR',
  he: 'HE', id: 'ID', ja: 'JA', ko: 'KO', zh: 'ZH', 'zh-TW': 'ZH-HANT', sl: 'SL', lt: 'LT', lv: 'LV', et: 'ET'
};
const SOURCES = new Set(['AR', 'BG', 'CS', 'DA', 'DE', 'EL', 'EN', 'ES', 'ET', 'FI', 'FR', 'HE', 'HU', 'ID', 'IT', 'JA', 'KO', 'LT', 'LV', 'NB', 'NL', 'PL', 'PT', 'RO', 'RU', 'SK', 'SL', 'SV', 'TR', 'UK', 'ZH']);

export const deeplOn = () => !!process.env.DEEPL_API_KEY;
export const deeplSupports = (target) => deeplOn() && !!TARGETS[target];
const host = () => process.env.DEEPL_BASE_URL || (process.env.DEEPL_API_KEY.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com');
const headers = () => ({ authorization: `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`, 'content-type': 'application/json' });

function srcCode(c) {
  if (!c || c === 'auto') return '';
  const u = ({ iw: 'HE', no: 'NB', 'zh-TW': 'ZH' }[c] || c).toUpperCase().split('-')[0];
  return SOURCES.has(u) ? u : '';
}

async function post(body) {
  const res = await fetch(`${host()}/v2/translate`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (res.status === 403) throw new Error('DeepL : clé refusée (403)');
  if (res.status === 456) throw new Error('DeepL : quota mensuel atteint (456)');
  if (res.status === 429) throw new Error('DeepL : trop de requêtes (429)');
  if (!res.ok) { const e = new Error(`DeepL indisponible (${res.status})`); e.status = res.status; throw e; }
  return res.json();
}

// Renvoie [{ text, source }] dans le même ordre que `texts`.
export async function deeplTranslate(texts, target, source = 'auto', context = '') {
  if (!deeplSupports(target)) throw new Error('Langue non prise en charge par DeepL');
  const out = [];
  for (let i = 0; i < texts.length; i += 50) {
    const part = texts.slice(i, i + 50);
    const body = { text: part, target_lang: TARGETS[target], split_sentences: '0', preserve_formatting: true };
    const s = srcCode(source); if (s) body.source_lang = s;
    if (context) body.context = context.slice(0, 500);
    let data;
    try { data = await post(body); } catch (e) { if (context && e.status === 400) { delete body.context; data = await post(body); } else throw e; }
    if (!Array.isArray(data.translations) || data.translations.length !== part.length) throw new Error('Réponse DeepL inattendue');
    data.translations.forEach((t) => out.push({ text: String(t.text || '').trim(), source: String(t.detected_source_language || '').toLowerCase() }));
  }
  return out;
}

export async function deeplCheck() {
  if (!deeplOn()) return { configured: false };
  try {
    const res = await fetch(`${host()}/v2/usage`, { headers: headers(), signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { configured: true, ok: false, error: `DeepL a répondu ${res.status}` };
    const u = await res.json();
    return { configured: true, ok: true, used: u.character_count, limit: u.character_limit };
  } catch (e) { return { configured: true, ok: false, error: e.message }; }
}
