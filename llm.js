// Traduction contextuelle via l'API Gemini (offre gratuite Google AI Studio).
// La clé reste côté serveur (GEMINI_API_KEY dans .env), jamais envoyée au navigateur.

const BASE = () => process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-flash-latest';
let cooldownUntil = 0;

export const hasLLM = () => !!process.env.GEMINI_API_KEY && Date.now() >= cooldownUntil;
export const llmConfigured = () => !!process.env.GEMINI_API_KEY;
export const llmModel = MODEL;

async function generate(prompt, schema, thinking = true) {
  const res = await fetch(`${BASE()}/v1beta/models/${MODEL()}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.3, ...(thinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}) }
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (res.status === 429) { cooldownUntil = Date.now() + 60000; throw new Error('Quota Gemini atteint, repli sur Google Translate'); }
  // Certains modèles n'acceptent pas le réglage de réflexion : on réessaie sans.
  if (res.status === 400 && thinking) return generate(prompt, schema, false);
  if (res.status === 400 || res.status === 403) throw new Error(`Gemini a refusé la requête (${res.status}) : vérifiez GEMINI_API_KEY`);
  if (!res.ok) throw new Error(`Gemini indisponible (${res.status})`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  try { return JSON.parse(text); } catch { throw new Error('Réponse Gemini illisible'); }
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
