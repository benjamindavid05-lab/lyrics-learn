// Lyrio, l'oiseau : mascotte qui évolue avec la progression (œuf → poussin → moineau → perroquet → aigle).
// Même style que le site : aplats colorés, contour épais, formes rondes.

export const BIRD_STAGES = [
  { id: 'egg', at: 0 },
  { id: 'chick', at: 10 },
  { id: 'sparrow', at: 50 },
  { id: 'parrot', at: 150 },
  { id: 'eagle', at: 400 }
];

const INK = '#0a0a0a';
const S = (w = 5) => `stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
const eye = (x, y, r = 4) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${INK}"/><circle cx="${x + r * 0.35}" cy="${y - r * 0.35}" r="${r * 0.3}" fill="#fff"/>`;

const PARTS = {
  egg: () => `
    <ellipse cx="50" cy="58" rx="27" ry="33" fill="#fff3d6" ${S()}/>
    <path d="M24 50l9-9 9 9 8-9 8 9 9-9 8 9" fill="none" ${S(4)}/>
    <circle cx="40" cy="72" r="4.5" fill="#ff9f8a"/><circle cx="60" cy="76" r="3.5" fill="#b9a6ff"/><circle cx="57" cy="62" r="3" fill="#7ee0c3"/>`,

  chick: () => `
    <path d="M44 86v8M56 86v8M40 95h8M52 95h8" fill="none" ${S(4)}/>
    <circle cx="50" cy="60" r="27" fill="#ffe27a" ${S()}/>
    <path d="M44 34c-2-7 1-11 5-12 0 5-1 9-3 12" fill="#ffe27a" ${S(4)}/>
    <ellipse cx="38" cy="66" rx="9" ry="7" fill="#ffd35c" ${S(4)}/>
    <path d="M74 54l12 5-12 6z" fill="#ff9f8a" ${S(4)}/>
    ${eye(61, 52, 4)}`,

  sparrow: () => `
    <path d="M42 84v10M58 84v10M37 95h10M53 95h10" fill="none" ${S(4)}/>
    <path d="M22 66L6 72l16 5z" fill="#e8745e" ${S(4)}/>
    <circle cx="48" cy="58" r="30" fill="#ff9f8a" ${S()}/>
    <path d="M30 64c4 14 22 20 34 10-8 2-14-2-18-8z" fill="#ffd9cf" ${S(0)}/>
    <path d="M26 60c2 14 14 22 28 18-14-2-22-8-28-18z" fill="#e8745e" ${S(4)}/>
    <path d="M76 52l14 6-14 7z" fill="#ffe27a" ${S(4)}/>
    ${eye(61, 50, 4.2)}`,

  parrot: (o = {}) => `
    ${o.tail === false ? '' : `<g fill="none" stroke-linecap="round"><path d="M24 70L8 86M28 74L16 94M32 76L26 98" stroke="${INK}" stroke-width="13"/><path d="M24 70L8 86" stroke="#ff9f8a" stroke-width="7"/><path d="M28 74L16 94" stroke="#ffe27a" stroke-width="7"/><path d="M32 76L26 98" stroke="#7ee0c3" stroke-width="7"/></g>`}
    ${o.legs === false ? '' : `<path d="M42 86v8M56 86v8" fill="none" ${S(4)}/>`}
    <path d="M30 28c-2-9 2-16 8-18 1 6 0 11-2 15M40 24c0-8 5-13 11-13-1 6-3 10-6 14" fill="#b9a6ff" ${S(4.5)}/>
    <circle cx="46" cy="58" r="32" fill="#b9a6ff" ${S(6)}/>
    <path d="M20 66c4 14 18 18 28 12" fill="none" ${S(5)}/>
    <path d="M74 48l20 8-20 10z" fill="#ffe27a" ${S(5)}/>
    <circle cx="58" cy="50" r="5" fill="${INK}"/><circle cx="59.6" cy="48.4" r="1.6" fill="#fff"/>
    ${o.phones ? `<path d="M38 52C30 8 80 4 80 40" fill="none" stroke="${INK}" stroke-width="11" stroke-linecap="round"/><path d="M38 52C30 8 80 4 80 40" fill="none" stroke="#ffe27a" stroke-width="5" stroke-linecap="round"/>
    <circle cx="38" cy="62" r="15" fill="#ff9f8a" ${S(5)}/><circle cx="38" cy="62" r="6.5" fill="#ffe27a" stroke="${INK}" stroke-width="3.5"/>` : ''}`,

  eagle: () => `
    <path d="M32 56C20 50 8 52 2 62c6 0 9 3 8 7 5-1 9 2 9 6 5-1 9 2 9 6 3 3 7 3 10 1z" fill="#6a55d8" ${S(4.5)}/>
    <path d="M68 56c12-6 24-4 30 6-6 0-9 3-8 7-5-1-9 2-9 6-5-1-9 2-9 6-3 3-7 3-10 1z" fill="#6a55d8" ${S(4.5)}/>
    <path d="M38 84L34 99l11-6 5 7 5-7 11 6-4-15z" fill="#ffc24a" ${S(4.5)}/>
    <ellipse cx="50" cy="66" rx="22" ry="25" fill="#3b2f5e" ${S(5)}/>
    <ellipse cx="50" cy="72" rx="11" ry="14" fill="#8a76d8"/>
    <circle cx="50" cy="34" r="20" fill="#fff" ${S(5)}/>
    <path d="M60 31C76 29 87 36 84 50 77 44 69 44 61 46z" fill="#ffc24a" ${S(4.5)}/>
    <circle cx="55" cy="33" r="4" fill="${INK}"/><circle cx="56.4" cy="31.6" r="1.3" fill="#fff"/>
    <path d="M45 22l17 6" fill="none" ${S(5)}/>`
};

/** SVG d'un oiseau : stage = 0..4 (œuf, poussin, moineau, perroquet, aigle). */
export function birdSvg(stage = 3, size = 96, opts = {}) {
  const id = BIRD_STAGES[Math.max(0, Math.min(4, stage))].id;
  return `<svg class="bird bird-${id}" width="${size}" height="${size}" viewBox="0 0 100 100" role="img" aria-hidden="true">${PARTS[id](opts)}</svg>`;
}

/** Points d'expérience : tout se déduit de ce que l'utilisateur a déjà fait (aucune donnée en plus à stocker). */
export function birdXp(state) {
  const songs = Object.values(state.songs || {});
  const learned = songs.reduce((n, s) => n + ((s.goal && s.goal.words) || []).filter((w) => w.done).length, 0);
  return songs.length * 10 + (state.library || []).length * 3 + learned * 5 + (state.lookups || 0) + (state.quizXp || 0);
}

/** { stage, next, progress 0..1, xp, need } */
export function birdLevel(xp) {
  let stage = 0;
  BIRD_STAGES.forEach((b, i) => { if (xp >= b.at) stage = i; });
  const cur = BIRD_STAGES[stage], next = BIRD_STAGES[stage + 1];
  return { stage, xp, next: next ? stage + 1 : null, need: next ? next.at - xp : 0, progress: next ? (xp - cur.at) / (next.at - cur.at) : 1 };
}
