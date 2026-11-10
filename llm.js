// Traduction contextuelle via l'API Gemini (offre gratuite Google AI Studio).
// La clé reste côté serveur (GEMINI_API_KEY dans .env), jamais envoyée au navigateur.

const BASE = () => process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-flash-latest';
let cooldownUntil = 0;

export const hasLLM = () => !!process.env.GEMINI_API_KEY && Date.now() >= cooldownUntil;
export const llmConfigured = () => !!process.env.GEMINI_API_KEY;
export const llmModel = MODEL;

// Modèles essayés dans l'ordre : celui configuré, puis ceux que Google déclare disponibles pour la clé.
const STATIC = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];
let modelCache = { at: 0, list: [] };

export async function listModels() {
  if (Date.now() - modelCache.at < 3600e3 && modelCache.list.length) return modelCache.list;
  try {
    const res = await fetch(`${BASE()}/v1beta/models?pageSize=200`, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    const bad = /(preview|exp|thinking|image|tts|audio|live|embed|robotics|computer|learnlm|gemma|native|vision|pro)/i;
    const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
    const names = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /^gemini-/.test(n) && /flash/.test(n) && !bad.test(n));
    const rank = (n) => (/lite/.test(n) ? 0 : 1000) + ver(n) * 10 + (/latest/.test(n) ? 5 : 0);
    const list = names.sort((x, y) => rank(y) - rank(x));
    if (list.length) modelCache = { at: Date.now(), list };
    return list;
  } catch { return []; }
}

async function chain() {
  const found = await listModels();
  return [...new Set([process.env.GEMINI_MODEL, ...found.slice(0, 5), ...(found.length ? [] : STATIC)].filter(Boolean))];
}
let sticky = ''; // dernier modèle qui a fonctionné
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callModel(model, prompt, schema, thinking) {
  const res = await fetch(`${BASE()}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.3, ...(thinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}) }
    }),
    signal: AbortSignal.timeout(40000)
  });
  // Certains modèles n'acceptent pas le réglage de réflexion : on réessaie sans.
  if (res.status === 400 && thinking) return callModel(model, prompt, schema, false);
  return res;
}

const errText = async (res) => {
  try { return ((await res.json())?.error?.message || '').replace(/\s+/g, ' ').slice(0, 160); } catch { return ''; }
};

async function generate(prompt, schema) {
  const started = Date.now();
  const base = await chain();
  const order = sticky && base.includes(sticky) ? [sticky, ...base.filter((m) => m !== sticky)] : base;
  const tried = [];
  let lastStatus = 0, lastMsg = '', all429 = true;
  for (const model of order) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - started > 60000) break;
      let res;
      try { res = await callModel(model, prompt, schema, true); } catch (e) { lastStatus = 0; lastMsg = e.message; all429 = false; await sleep(500); continue; }
      lastStatus = res.status;
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
        try { const out = JSON.parse(text); sticky = model; return out; } catch { all429 = false; break; } // réponse illisible : autre modèle
      }
      lastMsg = await errText(res);
      if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error(`Gemini a refusé la requête (${res.status}) : ${lastMsg || 'vérifiez GEMINI_API_KEY'}`);
      if (res.status !== 429) all429 = false;
      if (res.status === 429 || res.status === 404) break;   // quota ou modèle inconnu : modèle suivant
      await sleep(700 * (attempt + 1));                       // 500/503… : on patiente un peu puis on réessaie
    }
    tried.push(model);
  }
  if (all429 && lastStatus === 429) cooldownUntil = Date.now() + 60000;
  throw new Error(`Gemini indisponible (${lastStatus || 'réseau'}${lastMsg ? ' : ' + lastMsg : ''}) — modèles essayés : ${tried.join(', ') || 'aucun'}`);
}

// Diagnostic : /api/gemini-check
export async function diagnose() {
  if (!llmConfigured()) return { configured: false };
  const models = await listModels();
  try {
    const r = await generate('Reply with {"ok":"yes"}', { type: 'OBJECT', properties: { ok: { type: 'STRING' } }, required: ['ok'] });
    return { configured: true, ok: true, model: sticky, availableModels: models.slice(0, 8), reply: r };
  } catch (e) { return { configured: true, ok: false, error: e.message, availableModels: models.slice(0, 8) }; }
}

const S = 'STRING';

// Traduit un lot de lignes ; `context` = toute la chanson (pour le sens), facultatif.
export async function translateLyrics(lines, targetName, sourceCode, context = []) {
  const withCtx = context.length > lines.length;
  const prompt = `You are an expert literary translator of song lyrics for language learners.
Translate the lines below into ${targetName}${sourceCode && sourceCode !== 'auto' ? ` (source language code: ${sourceCode})` : ''}.
Rules:
- Translate for meaning and emotion, not word for word. Render idioms, slang and metaphors naturally in ${targetName}.
- Keep a poetic, singable register. Be concise: output the translation only.
- Output EXACTLY ${lines.length} items, in the same order, one per input line. Never merge, split or skip lines.
- "t" is the translation of that line. "rm" is a romanization of the ORIGINAL line only when its script is not Latin (otherwise empty string).
- "source_language_code" is the ISO 639-1 code of the original language.
${withCtx ? `\nFULL SONG (context only, who speaks, to whom, tone; do NOT translate all of it):\n${context.join('\n')}\n` : ''}
LINES TO TRANSLATE (JSON array):
${JSON.stringify(lines)}`;
  const r = await generate(prompt, {
    type: 'OBJECT',
    properties: {
      source_language_code: { type: S },
      lines: { type: 'ARRAY', items: { type: 'OBJECT', properties: { t: { type: S }, rm: { type: S } }, required: ['t', 'rm'] } }
    },
    required: ['source_language_code', 'lines']
  });
  if (!Array.isArray(r.lines) || r.lines.length !== lines.length) throw new Error('Alignement des lignes incorrect');
  return {
    results: r.lines.map((l) => ({ text: String(l.t || '').trim(), translit: String(l.rm || '').trim() })),
    source: r.source_language_code || ''
  };
}

// Traduit des mots / expressions en tenant compte de leur phrase d'origine.
export async function translateItems(items, targetName, sourceCode) {
  const prompt = `You help language learners. For each item, give its meaning in ${targetName} AS USED in its sentence (not a generic dictionary entry).
${sourceCode && sourceCode !== 'auto' ? `Source language code: ${sourceCode}.\n` : ''}Rules:
- "t": short translation (1-4 words, or the natural equivalent for an expression).
- "rm": romanization of the item if its script is not Latin, else empty string.
- "note": a very short hint (max 12 words) ONLY if it is an idiom, slang, pun or has a surprising nuance; otherwise empty string.
- Output EXACTLY ${items.length} objects in the same order.

ITEMS (JSON array of {text, sentence}):
${JSON.stringify(items.map((x) => ({ text: x.text, sentence: x.context || '' })))}`;
  const r = await generate(prompt, {
    type: 'OBJECT',
    properties: { items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { t: { type: S }, rm: { type: S }, note: { type: S } }, required: ['t', 'rm', 'note'] } } },
    required: ['items']
  });
  if (!Array.isArray(r.items) || r.items.length !== items.length) throw new Error('Alignement des mots incorrect');
  return r.items.map((x) => ({ text: String(x.t || '').trim(), translit: String(x.rm || '').trim(), note: String(x.note || '').trim() }));
}

// Choisit les mots les plus utiles à apprendre (pas de mots-outils), renvoie la forme exacte des paroles.
export async function suggestVocab(lines, targetName, sourceCode, n, exclude = []) {
  const prompt = `You help language learners pick vocabulary from a song.
From the lyrics below, choose exactly ${n} words worth learning for a beginner/intermediate learner.
Rules:
- Pick meaningful content words (nouns, verbs, adjectives, adverbs) that matter in this song. Prefer varied, useful, reusable vocabulary.
- AVOID pronouns, articles, prepositions, conjunctions, very common function words (like "I", "you", "like", "my", "of"), proper names, interjections, and any word in EXCLUDE.
- "w": the word EXACTLY as written in the lyrics (same script and letters, no punctuation, one word only).
- "t": its meaning in ${targetName} AS USED in the song (1-3 words). "note": max 12 words, only for idioms/slang/surprising nuance, else empty string.
${sourceCode && sourceCode !== 'auto' ? `Source language code: ${sourceCode}.\n` : ''}EXCLUDE: ${JSON.stringify(exclude)}

LYRICS:
${lines.join('\n')}`;
  const r = await generate(prompt, {
    type: 'OBJECT',
    properties: { words: { type: 'ARRAY', items: { type: 'OBJECT', properties: { w: { type: 'STRING' }, t: { type: 'STRING' }, note: { type: 'STRING' } }, required: ['w', 't', 'note'] } } },
    required: ['words']
  });
  return (r.words || []).map((x) => ({ word: String(x.w || '').trim(), tr: String(x.t || '').trim(), note: String(x.note || '').trim() }));
}
