// Traduction contextuelle via l'API Gemini (offre gratuite Google AI Studio).
// La clé reste côté serveur (GEMINI_API_KEY dans .env), jamais envoyée au navigateur.

const BASE = () => process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-flash-latest';
let cooldownUntil = 0;

export const hasLLM = () => !!process.env.GEMINI_API_KEY && Date.now() >= cooldownUntil;
export const llmConfigured = () => !!process.env.GEMINI_API_KEY;
export const llmModel = MODEL;

async function generate(prompt, schema) {
  const res = await fetch(`${BASE()}/v1beta/models/${MODEL()}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.3 }
    }),
    signal: AbortSignal.timeout(90000)
  });
  if (res.status === 429) { cooldownUntil = Date.now() + 60000; throw new Error('Quota Gemini atteint, repli sur Google Translate'); }
  if (res.status === 400 || res.status === 403) throw new Error(`Gemini a refusé la requête (${res.status}) : vérifiez GEMINI_API_KEY`);
  if (!res.ok) throw new Error(`Gemini indisponible (${res.status})`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  try { return JSON.parse(text); } catch { throw new Error('Réponse Gemini illisible'); }
}

const S = 'STRING';

// Traduit toute la chanson d'un coup (avec contexte). Renvoie autant de lignes que l'entrée.
export async function translateLyrics(lines, targetName, sourceCode) {
  const out = [];
  let source = '';
  const CHUNK = 160;
  for (let i = 0; i < lines.length; i += CHUNK) {
    const part = lines.slice(i, i + CHUNK);
    const prompt = `You are an expert literary translator of song lyrics for language learners.
Translate the lyrics below into ${targetName}${sourceCode && sourceCode !== 'auto' ? ` (source language code: ${sourceCode})` : ''}.
Rules:
- Translate for meaning and emotion, not word for word. Render idioms, slang and metaphors naturally in ${targetName}.
- Use the whole song as context (who speaks, to whom, tense, tone). Keep a poetic, singable register.
- Output EXACTLY ${part.length} items, in the same order, one per input line. Never merge, split or skip lines.
- "t" is the translation of that line. "rm" is a romanization/transliteration of the ORIGINAL line only when its script is not Latin (otherwise empty string).
- "source_language_code" is the ISO 639-1 code of the original language.
${i > 0 ? '- This is a continuation of the same song.\n' : ''}${i === 0 && lines.length > CHUNK ? `- The song is long; this is part 1.\n` : ''}
LINES (JSON array):
${JSON.stringify(part)}`;
    const r = await generate(prompt, {
      type: 'OBJECT',
      properties: {
        source_language_code: { type: S },
        lines: { type: 'ARRAY', items: { type: 'OBJECT', properties: { t: { type: S }, rm: { type: S } }, required: ['t', 'rm'] } }
      },
      required: ['source_language_code', 'lines']
    });
    if (!Array.isArray(r.lines) || r.lines.length !== part.length) throw new Error('Alignement des lignes incorrect');
    source = source || r.source_language_code || '';
    r.lines.forEach((l) => out.push({ text: String(l.t || '').trim(), translit: String(l.rm || '').trim() }));
  }
  return { results: out, source };
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
