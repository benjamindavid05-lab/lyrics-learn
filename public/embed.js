// Aperçu des paroles via l'« Embed » officiel de Genius : analyse du code d'intégration, document de l'aperçu, nettoyage du texte.

const decode = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos);/gi, (m, e) => {
  if (e[0] === '#') { const c = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) ? String.fromCodePoint(c) : m; }
  return { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" }[e.toLowerCase()] || m;
});

// Reconnaît le code « Embed » de Genius collé tel quel (ou son adresse embed.js) et en tire l'identifiant, le titre et l'artiste.
export function parseEmbedCode(input) {
  const s = String(input || '');
  const m = s.match(/rg_embed_link_(\d{1,12})(?![A-Za-z0-9_])/) || s.match(/songs\/(\d{1,12})\/embed\.js/) || s.match(/data-song-id=['"](\d{1,12})['"]/);
  if (!m) return null;
  const href = (s.match(/<a\s[^>]*href=['"](https?:\/\/genius\.com\/[^'"\s]+)['"]/i) || [])[1] || '';
  const label = decode((s.match(/<a\s[^>]*>([^<]{1,200})<\/a>/i) || [])[1] || '');
  const mm = label.match(/^\s*[“"']?(.+?)[”"']?\s+by\s+(.+?)\s*$/i); // « “Big Boy” by Makala »
  return { id: m[1], url: href, title: mm ? mm[1].trim() : '', artist: mm ? mm[2].trim() : '' };
}

// Document de l'aperçu : il charge le script officiel de Genius, puis renvoie le texte affiché à l'app.
// Il est affiché dans un cadre isolé (sans accès à vos données) ; seul l'identifiant numérique est accepté.
export function embedSrcdoc(id) {
  if (!/^\d{1,12}$/.test(String(id))) throw new Error('identifiant invalide');
  const S = 'scr' + 'ipt';
  return '<!doctype html><meta charset="utf-8"><base target="_blank">'
    + "<style>body{margin:0;padding:14px 16px;font:15px/1.6 Georgia,'Times New Roman',serif;color:#111;background:#fff}a{color:#111}</style>"
    + `<div id="rg_embed_link_${id}" class="rg_embed_link" data-song-id="${id}"></div>`
    + `<${S} src="https://genius.com/songs/${id}/embed.js"></${S}>`
    + `<${S}>addEventListener('load',function(){setTimeout(function(){parent.postMessage({llEmbed:true,id:'${id}',text:document.body.innerText||''},'*')},400)})</${S}>`;
}

// Garde les paroles : on commence à la première balise [Couplet], on s'arrête aux lignes de pied de page de l'aperçu.
export function cleanEmbedText(text) {
  const L = String(text || '').replace(/\r/g, '').split('\n').map((x) => x.replace(/\s+$/, ''));
  let start = L.findIndex((x) => /^\[.+\]$/.test(x.trim()));
  if (start < 0) start = 0;
  const FOOT = /^(read (more|the full)|view (the )?(full )?lyrics|lyrics? (powered|provided) by|see .{0,40} on genius|embed|share)\b/i;
  let end = L.findIndex((x, i) => i > start && x.trim().length < 80 && FOOT.test(x.trim()));
  if (end < 0) end = L.length;
  return L.slice(start, end).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
