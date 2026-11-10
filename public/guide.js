// Aides visuelles et visite guidée : schémas, chanson d'exemple, bulles d'explication.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Chanson d'exemple, écrite pour l'application (aucun droit d'auteur à gérer) : permet d'essayer tout de suite.
export const SAMPLE_SONG = {
  title: 'Canción de ejemplo',
  artist: 'Lyrics Learn',
  lyrics: `[Verso 1]
Hoy me levanto con el sol
Camino despacio por la ciudad
Todo lo bueno viene de a poco
Y yo sigo aprendiendo a cantar

[Estribillo]
Cada palabra es una puerta
Cada canción es un camino
Aprendo un poquito cada día
Y mi voz se hace más fuerte`
};

// Icônes en trait (hérite de la couleur du texte)
const IC = {
  search: '<circle cx="17" cy="17" r="9"/><path d="M24 24l9 9"/><path d="M15.5 21v-7l5-1.2v6"/><circle cx="14" cy="21" r="1.5"/><circle cx="19" cy="19.8" r="1.5"/>',
  doc: '<path d="M11 5h13l7 7v23H11z"/><path d="M24 5v7h7"/><path d="M15 20h12M15 25h12M15 30h7"/>',
  click: '<path d="M7 12h22M7 19h12"/><path d="M23 19l11 7-5.5 1.6-2.2 5.6z"/>',
  save: '<path d="M11 5h18v31l-9-6.5L11 36z"/><path d="M15.5 17.5l3.5 3.5 6.5-7"/>'
};
const icon = (k) => `<svg viewBox="0 0 40 40" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[k]}</svg>`;

// « Comment ça marche » : 4 étapes illustrées, reliées par des flèches
export function howHtml(t) {
  const steps = [['search', 1], ['doc', 2], ['click', 3], ['save', 4]];
  return '<ol class="how">' + steps.map(([ic, n]) =>
    `<li><div class="how-ic">${icon(ic)}</div><span class="how-n">0${n}</span><h3>${esc(t(`how.${n}.t`))}</h3><p>${esc(t(`how.${n}.d`))}</p></li>`).join('') + '</ol>';
}

// Grille d'objectif annotée (1 = mot, 2 = appris, 3 = proposer d'autres mots)
export function goalDiagramHtml(t) {
  return `<div class="gd">
    <div class="gd-grid">
      <div class="gd-cell"><i class="gd-n">1</i><b dir="auto">אוהב</b><span>${esc(t('demo.def'))}</span></div>
      <div class="gd-cell on"><i class="gd-n">2</i><b dir="auto">היום</b><span>today</span></div>
      <div class="gd-cell cta"><i class="gd-n">3</i><em>+</em><small>${esc(t('goal.more'))}</small></div>
    </div>
    <ol class="gd-legend">
      <li><i>1</i>${esc(t('help.goal.1'))}</li>
      <li><i>2</i>${esc(t('help.goal.2'))}</li>
      <li><i>3</i>${esc(t('help.goal.3'))}</li>
    </ol></div>`;
}

// Bibliothèque vide : « cliquez un mot → enregistrez → il apparaît ici »
export function libEmptyHtml(t) {
  const box = (n, text) => `<div class="le-box"><i>${n}</i><span>${esc(text)}</span></div>`;
  return `<div class="le"><h3>${esc(t('libempty.t'))}</h3><div class="le-row">${box(1, t('libempty.1'))}<b aria-hidden="true">→</b>${box(2, t('libempty.2'))}<b aria-hidden="true">→</b>${box(3, t('libempty.3'))}</div></div>`;
}

// ---------- visite guidée (bulles qui pointent les éléments) ----------
let tour = null;

export function isTourOpen() { return !!tour; }

export function startTour({ t, steps, onClose }) {
  endTour();
  const narrow = matchMedia('(max-width: 960px)').matches;
  const list = steps.filter((s) => !(narrow && s.skipNarrow));
  if (!list.length) return;
  const veil = document.createElement('div'); veil.className = 'tour-veil';
  const spot = document.createElement('div'); spot.className = 'tour-spot';
  const card = document.createElement('div'); card.className = 'tour-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-live', 'polite');
  document.body.append(veil, spot, card);
  tour = { veil, spot, card, i: 0, list, t, onClose };

  const place = () => {
    if (!tour) return;
    const s = tour.list[tour.i];
    const el = document.querySelector(s.sel);
    const r = el && el.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) { spot.style.display = 'none'; card.style.left = '50%'; card.style.top = '30%'; card.style.transform = 'translateX(-50%)'; return; }
    const pad = 8;
    spot.style.display = 'block';
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const cw = Math.min(340, innerWidth - 24), ch = card.offsetHeight || 190;
    let left = Math.min(Math.max(12, r.left + r.width / 2 - cw / 2), innerWidth - cw - 12);
    let top = r.bottom + 16;
    if (top + ch > innerHeight - 12) top = r.top - ch - 16;           // pas la place dessous : au-dessus
    if (top < 12) top = Math.min(innerHeight - ch - 12, Math.max(12, r.top + 16)); // ni dessus : sur l'élément
    card.style.transform = 'none'; card.style.width = `${cw}px`; card.style.left = `${left}px`; card.style.top = `${top}px`;
  };

  const show = () => {
    const s = tour.list[tour.i], last = tour.i === tour.list.length - 1;
    if (s.before) s.before();
    card.innerHTML = `<div class="tour-step">${esc(t('tour.of', { n: tour.i + 1, total: tour.list.length }))}</div>
      <h3>${esc(t(s.title))}</h3><p>${esc(t(s.desc))}</p>
      <div class="tour-acts"><button type="button" class="link" data-tour="skip">${esc(t('tour.skip'))}</button><span class="pspace"></span>
        ${tour.i ? `<button type="button" class="btn" data-tour="back">${esc(t('tour.back'))}</button>` : ''}
        <button type="button" class="btn solid" data-tour="next">${esc(t(last ? 'tour.done' : 'tour.next'))}</button></div>`;
    const el = document.querySelector(s.sel);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(place, 60); setTimeout(place, 420);
    card.querySelector('[data-tour="next"]').focus({ preventScroll: true });
  };
  card.addEventListener('click', (e) => {
    const a = e.target.closest('[data-tour]'); if (!a || !tour) return;
    if (a.dataset.tour === 'skip') return endTour(true);
    if (a.dataset.tour === 'back') tour.i = Math.max(0, tour.i - 1);
    else if (tour.i >= tour.list.length - 1) return endTour(true);
    else tour.i += 1;
    show();
  });
  veil.addEventListener('click', () => endTour(true));
  tour.onKey = (e) => { if (e.key === 'Escape') endTour(true); };
  tour.onResize = () => place();
  document.addEventListener('keydown', tour.onKey);
  addEventListener('resize', tour.onResize); addEventListener('scroll', tour.onResize, true);
  show();
}

export function endTour(finished = false) {
  if (!tour) return;
  const { veil, spot, card, onKey, onResize, onClose } = tour;
  tour = null;
  document.removeEventListener('keydown', onKey); removeEventListener('resize', onResize); removeEventListener('scroll', onResize, true);
  veil.remove(); spot.remove(); card.remove();
  if (finished && onClose) onClose();
}
