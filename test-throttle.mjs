// Tests de la file d'attente de traduction : lancer avec `node test-throttle.mjs`
import assert from 'node:assert/strict';
import { translate, translateMany } from './translate.js';
import { translateItems } from './llm.js';

const realFetch = globalThis.fetch;
let calls = [];
let mode = 'ok';          // ok | 429-once | 429-always | short
let mmCalls = 0;

const bodyText = (init) => decodeURIComponent(String(init?.body || '').replace(/^q=/, '').replace(/\+/g, ' '));
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('translate.googleapis.com')) {
    calls.push(u);
    if (mode === '429-always') return { ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), json: async () => ({}) };
    if (mode === '429-once' && calls.length === 1) return { ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), json: async () => ({}) };
    const lines = bodyText(init).split('\n');
    const out = mode === 'short' && lines.length > 1 ? lines.slice(0, lines.length - 1) : lines; // Google « avale » une ligne
    const segs = out.map((l, i) => [`(fr) ${l}${i < out.length - 1 ? '\n' : ''}`, `${l}${i < out.length - 1 ? '\n' : ''}`, null, null, 1]);
    out.forEach((l, i) => segs.push([null, null, `rm${i}`]));
    return { ok: true, status: 200, headers: new Headers(), json: async () => [segs, null, 'he'] };
  }
  if (u.includes('mymemory.translated.net')) {
    mmCalls++;
    return { ok: true, status: 200, json: async () => ({ responseStatus: 200, responseData: { translatedText: 'secours' } }) };
  }
  throw new Error('réseau inattendu: ' + u);
};

const lines = Array.from({ length: 60 }, (_, i) => `ligne ${i}`);

// 1) 60 vers = 3 requêtes (au lieu de 60), dans le bon ordre, avec la romanisation
calls = []; mode = 'ok';
let r = await translateMany(lines, 'fr', 'he');
assert.equal(calls.length, 3, `3 requêtes attendues, reçu ${calls.length}`);
assert.equal(r.length, 60);
assert.equal(r[0].text, '(fr) ligne 0'); assert.equal(r[59].text, '(fr) ligne 59'); assert.equal(r[7].translit, 'rm7');
console.log('1) 60 vers →', calls.length, 'requêtes, ordre et romanisation OK');

// 2) tout est maintenant en mémoire : aucune nouvelle requête
calls = [];
r = await translateMany(lines, 'fr', 'he');
assert.equal(calls.length, 0); assert.equal(r[30].text, '(fr) ligne 30');
console.log('2) deuxième demande identique → 0 requête (mémoire)');

// 3) découpage faux (une ligne avalée) : repli ligne par ligne, résultat quand même correct
calls = []; mode = 'short';
const other = Array.from({ length: 6 }, (_, i) => `autre ${i}`);
r = await translateMany(other, 'fr', 'he');
assert.equal(r.filter((x) => x.error).length, 0); assert.equal(r[2].text, '(fr) autre 2');
console.log('3) découpage incorrect → repli ligne par ligne,', calls.length, 'requêtes, aucune erreur');

// 4) un 429 isolé : on patiente puis on réussit
calls = []; mode = '429-once';
let t0 = Date.now();
const one = await translate('מילה ראשונה', 'fr', 'he');
assert.equal(one.text, '(fr) מילה ראשונה'); assert.ok(calls.length >= 2);
console.log('4) un 429 puis succès →', calls.length, 'requêtes en', Date.now() - t0, 'ms');

// 5) Google refuse tout : un mot passe par le service de secours, pas d'erreur
calls = []; mode = '429-always'; mmCalls = 0;
const w = await translate('שלום', 'fr', 'he');
assert.equal(w.text, 'secours'); assert.equal(mmCalls, 1);
console.log('5) Google bloqué → service de secours utilisé pour un mot :', w.text);

// 6) pendant le blocage, les requêtes suivantes n'insistent pas auprès de Google
calls = [];
const w2 = await translate('בית', 'fr', 'he');
assert.equal(w2.text, 'secours'); assert.equal(calls.length, 0);
console.log('6) pendant le blocage → 0 requête inutile vers Google');

// 7) cinq demandes identiques simultanées = une seule requête
mode = 'ok'; calls = [];
await new Promise((res) => setTimeout(res, 16000)); // fin du blocage de 15 s
const same = await Promise.all(Array.from({ length: 5 }, () => translate('חתול', 'fr', 'he')));
assert.equal(calls.length, 1); assert.ok(same.every((x) => x.text === '(fr) חתול'));
console.log('7) 5 demandes simultanées identiques →', calls.length, 'requête');

// 8) service principal : plafond de requêtes par minute (ici 1) ; la deuxième demande patiente trop longtemps -> refus propre
process.env.GEMINI_API_KEY = 'test'; process.env.GEMINI_RPM = '1'; process.env.GEMINI_MODEL = 'm1';
let geminiCalls = 0;
const inner = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/v1beta/models?')) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'models/m1', supportedGenerationMethods: ['generateContent'] }] }) };
  if (u.includes(':generateContent')) { geminiCalls++; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [{ t: 'x', rm: '', note: '' }] }) }] } }] }) }; }
  return inner(url, init);
};
const g1 = await translateItems([{ text: 'a', context: '' }], 'French', 'he', 200);
assert.equal(g1[0].text, 'x');
await assert.rejects(() => translateItems([{ text: 'b', context: '' }], 'French', 'he', 200), /unavailable/);
assert.equal(geminiCalls, 1);
console.log('8) plafond Gemini : 1 appel autorisé, le suivant refusé sans appel réseau (', geminiCalls, 'appel )');

globalThis.fetch = realFetch;
console.log('ok');
