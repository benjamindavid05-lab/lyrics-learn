// Logique pure du jeu « Se tester » (sans DOM) : choix des mots, questions, correction, progression par boîtes (Leitner).

const strip = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
export const normAns = (s) => strip(s).replace(/^(to|the|a|an|le|la|les|l|un|une|des|du|de|el|los|las|der|die|das|ein|eine)\s+/, '');

export const usable = (lib) => lib.filter((e) => e && e.text && e.tr && String(e.tr).trim());
export const masteredCount = (lib) => usable(lib).filter((e) => (e.box || 0) >= 3).length;

/** Les mots les moins maîtrisés (et les moins récemment vus) d'abord, avec un peu de hasard. */
export function pickWords(lib, n = 10, rnd = Math.random) {
  const now = Date.now();
  const scored = usable(lib).map((e) => {
    const days = e.last ? Math.min(30, (now - e.last) / 864e5) : 30;
    return { e, s: (4 - (e.box || 0)) * 2 + days * 0.15 + rnd() * 2.2 };
  });
  return scored.sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.e);
}

/** Question à 4 choix : sens → mot (le plus souvent) ou mot → sens. null si pas assez de mots différents. */
export function makeChoice(word, lib, rnd = Math.random) {
  const pool = usable(lib).filter((e) => e !== word);
  const rev = rnd() < 0.3;
  const key = (e) => normAns(rev ? e.text : e.tr);
  const answerText = rev ? word.text : word.tr;
  const seen = new Set([key(word)]);
  const wrong = [];
  for (const e of pool.sort(() => rnd() - 0.5)) { const k = key(e); if (!k || seen.has(k)) continue; seen.add(k); wrong.push(rev ? e.text : e.tr); if (wrong.length === 3) break; }
  if (wrong.length < 3) return null;
  const choices = [answerText, ...wrong].sort(() => rnd() - 0.5);
  return { rev, prompt: rev ? word.tr : word.text, answer: answerText, choices, correct: choices.indexOf(answerText) };
}

/** Réponse écrite : on accepte une variante (séparateurs , ; /), sans accents ni article, avec 1 faute de frappe tolérée sur les mots longs. */
export function checkTyped(input, answer) {
  const given = normAns(input); if (!given) return false;
  const variants = String(answer).split(/[,;/]|\bor\b|\bou\b/).map(normAns).filter(Boolean);
  variants.push(normAns(answer));
  return variants.some((v) => {
    if (v === given) return true;
    if (v.length >= 5 && Math.abs(v.length - given.length) <= 1) { let d = 0, i = 0, j = 0; while (i < v.length && j < given.length) { if (v[i] === given[j]) { i++; j++; } else { if (++d > 1) return false; if (v.length > given.length) i++; else if (v.length < given.length) j++; else { i++; j++; } } } return d + (v.length - i) + (given.length - j) <= 1; }
    return false;
  });
}

/** Progression : bonne réponse = boîte +1 (max 4), erreur = retour à 0. */
export function review(entry, ok) {
  entry.seen = (entry.seen || 0) + 1; entry.last = Date.now();
  if (ok) { entry.ok = (entry.ok || 0) + 1; entry.box = Math.min(4, (entry.box || 0) + 1); }
  else { entry.ko = (entry.ko || 0) + 1; entry.box = 0; }
  return entry.box;
}

export const XP_PER_OK = 2, XP_PERFECT = 5;
