// Démonstration d'accueil : plusieurs paires de langues avec drapeaux, une par boucle d'animation.
import { flagOf, langName } from './langs.js';
import { getLang } from './i18n.js';

// Phrases courtes écrites pour la démo (ce ne sont pas des paroles de chansons).
const EXAMPLES = [
  { from: 'en', to: 'fr', words: ['We', 'dance', 'all night'], hit: 1, tr: 'Nous dansons toute la nuit', def: 'danser', faint: ['under', 'the', 'stars'] },
  { from: 'he', to: 'fr', words: ['אני', 'אוהב', 'אותך'], hit: 1, tr: 'Je t’aime', def: 'aimer', faint: ['כל', 'היום', 'שלי'] },
  { from: 'de', to: 'en', words: ['Ich', 'liebe', 'dich'], hit: 1, tr: 'I love you', def: 'to love', faint: ['für', 'immer', 'und ewig'] },
  { from: 'es', to: 'fr', words: ['Quiero', 'bailar', 'hoy'], hit: 1, tr: 'Je veux danser aujourd’hui', def: 'danser', faint: ['esta', 'noche'] }
];
const RTL = new Set(['he', 'ar', 'fa', 'ur', 'yi']);
let cur = -1;

export function setDemo(i) {
  const root = document.querySelector('.demo2'); if (!root) return;
  cur = ((i % EXAMPLES.length) + EXAMPLES.length) % EXAMPLES.length;
  const e = EXAMPLES[cur], ui = getLang();
  const rtl = RTL.has(e.from), dir = rtl ? 'rtl' : 'ltr';
  const span = (w, hit) => `<span${hit ? ' class="d-hit"' : ''} dir="auto">${w}</span>`;
  const [l1, l2] = root.querySelectorAll('.d-l');
  for (const [el, ws, h] of [[l1, e.words, e.hit], [l2, e.faint, -1]]) {
    el.style.direction = dir; el.style.textAlign = rtl ? 'right' : 'left';
    el.innerHTML = ws.map((w, k) => span(w, k === h)).join(' ');
  }
  root.querySelector('.d-t').textContent = e.tr;
  const pw = root.querySelector('.d-pw'); pw.textContent = e.words[e.hit]; pw.style.direction = dir;
  root.querySelector('.d-pd').textContent = e.def;
  root.querySelector('.d-pair').textContent = `${flagOf(e.from)} ${langName(e.from, ui)} → ${flagOf(e.to)} ${langName(e.to, ui)}`;
  const lyr = root.querySelector('.d-lyrics'); lyr.style.left = rtl ? '' : '5cqw';
}

export function initDemo() {
  const root = document.querySelector('.demo2'); if (!root) return;
  setDemo(0);
  const cursor = root.querySelector('.d-cursor');
  cursor.addEventListener('animationiteration', () => setDemo(cur + 1));
  window.__setDemo = setDemo;
  document.addEventListener('ll:lang', () => setDemo(cur));
}
