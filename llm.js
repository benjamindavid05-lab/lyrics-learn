// Traduction contextuelle via l'API Gemini (offre gratuite Google AI Studio).
// La clé reste côté serveur (GEMINI_API_KEY dans .env), jamais envoyée au navigateur.

const BASE = () => process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-flash-latest';
let cooldownUntil = 0;

export const hasLLM = () => !!process.env.GEMINI_API_KEY && Date.now() >= cooldownUntil;
export const llmConfigured = () => !!process.env.GEMINI_API_KEY;
export const llmModel = MODEL;

// Modèles essayés dans l'ordre : le premier configuré, puis des alternatives (quotas séparés).
const CHAIN = () => [...new Set([MODEL(), 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'])];
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

async function generate(prompt, schema) {
  const started = Date.now();
  const order = sticky ? [sticky, ...CHAIN().filter((m) => m !== sticky)] : CHAIN();
  const tried = [];
  let lastStatus = 0, all429 = true;
  for (const model of order) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - started > 60000) break;
      let res;
      try { res = await callModel(model, prompt, schema, true); } catch { lastStatus = 0; all429 = false; await sleep(500); continue; }
      lastStatus = res.status;
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
        try { const out = JSON.parse(text); sticky = model; return out; } catch { all429 = false; break; } // réponse illisible : autre modèle
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error(`Gemini a refusé la requête (${res.status}) : vérifiez GEMINI_API_KEY`);
      if (res.status !== 429) all429 = false;
      if (res.status === 429 || res.status === 404) break;   // quota ou modèle inconnu : modèle suivant
      await sleep(700 * (attempt + 1));                       // 500/503… : on patiente un peu puis on réessaie
    }
    tried.push(model);
  }
  if (all429 && lastStatus === 429) cooldownUntil = Date.now() + 60000;
  throw new Error(`Gemini indisponible (${lastStatus || 'réseau'}) après ${tried.join(', ')}`);
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
