// Langues : normalisation des codes, détection par alphabet, noms et drapeaux.

// Les services de traduction n'écrivent pas tous les codes pareil (Google : « iw », DeepL : « HE », Gemini : « he »…).
export function normLang(code) {
  let c = String(code || '').toLowerCase().trim().split(/[-_]/)[0];
  if (!c || c === 'auto' || c === 'und') return '';
  const alias = { iw: 'he', nb: 'no', nn: 'no', jw: 'jv', in: 'id', ji: 'yi', tl: 'tl', fil: 'tl' };
  return alias[c] || c;
}

// Devine la langue d'après l'alphabet (utile quand on ne connaît pas la langue détectée). Les alphabets latins restent « inconnus ».
export function guessScript(text) {
  const s = String(text || '');
  const tests = [
    ['he', /[֐-׿]/], ['ar', /[؀-ۿݐ-ݿ]/], ['ko', /[가-힯ᄀ-ᇿ]/],
    ['ja', /[぀-ヿ]/], ['zh', /[㐀-鿿]/], ['ru', /[Ѐ-ӿ]/],
    ['el', /[Ͱ-Ͽ]/], ['th', /[฀-๿]/], ['hi', /[ऀ-ॿ]/], ['bn', /[ঀ-৿]/], ['ta', /[஀-௿]/]
  ];
  for (const [l, re] of tests) if (re.test(s)) return l;
  return '';
}

// Un drapeau représente un pays, pas une langue : l'anglais, l'espagnol ou l'arabe se parlent dans bien d'autres pays.
// Pour les langues sans pays évident (catalan, basque, latin…), on met un globe.
const COUNTRY = {
  he: 'IL', en: 'GB', es: 'ES', fr: 'FR', de: 'DE', it: 'IT', pt: 'PT', nl: 'NL', sv: 'SE', da: 'DK', no: 'NO', fi: 'FI',
  pl: 'PL', cs: 'CZ', sk: 'SK', hu: 'HU', ro: 'RO', bg: 'BG', el: 'GR', ru: 'RU', uk: 'UA', tr: 'TR', ar: 'SA', fa: 'IR',
  hi: 'IN', bn: 'BD', ur: 'PK', ta: 'IN', th: 'TH', vi: 'VN', id: 'ID', ms: 'MY', tl: 'PH', zh: 'CN', ja: 'JP', ko: 'KR',
  sw: 'KE', af: 'ZA', hr: 'HR', sr: 'RS', sl: 'SI', lt: 'LT', lv: 'LV', et: 'EE', is: 'IS', ga: 'IE', yi: 'IL'
};
export function flagOf(code) {
  const cc = COUNTRY[normLang(code)];
  if (!cc) return '🌐';
  return String.fromCodePoint(...[...cc].map((ch) => 0x1F1E6 + ch.charCodeAt(0) - 65));
}

// Nom de la langue dans la langue de l'interface (« hébreu », « Hebrew »…).
const names = {};
export function langName(code, ui = 'en') {
  const c = normLang(code);
  if (!c) return ui === 'fr' ? 'Langue inconnue' : 'Unknown language';
  try {
    names[ui] ??= new Intl.DisplayNames([ui], { type: 'language' });
    const n = names[ui].of(c);
    return n && n !== c ? n.charAt(0).toUpperCase() + n.slice(1) : c.toUpperCase();
  } catch { return c.toUpperCase(); }
}
