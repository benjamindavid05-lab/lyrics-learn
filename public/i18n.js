// Interface bilingue : anglais (par défaut) et français.
const EN = {
  'nav.home': 'Home', 'nav.read': 'Reading', 'nav.library': 'Library', 'nav.add': '+ Song',
  'lang.translateTo': 'Translate to',
  'home.kicker': 'Learn through music',
  'home.title': 'Learn a language with your favorite songs.',
  'home.lead': 'Import the lyrics, read them with their translation, pick the words to remember, and find each one again with the line it came from.',
  'home.add': 'Add a song', 'home.resume': 'Resume reading', 'home.songs': 'My songs', 'home.how': 'How it works',
  'home.s1': 'Add a song: the lyrics are imported, then translated line by line.',
  'home.s2': 'Click a word, or select an expression, to translate and save it.',
  'home.s3': 'Set a word goal: those words are highlighted in the lyrics.',
  'home.s4': 'Find your words in the library, with the line of the song they come from.',
  'read.kicker': 'Reading', 'read.none': 'No song open.',
  'toggle.tr': 'Translation',
  'tip.first': 'Click a word to translate it. Select several words for an expression.',
  'goal.title': 'Goal', 'goal.count': 'Number of words', 'goal.quiz': 'Review mode: hide translations',
  'lib.kicker': 'Library', 'lib.title': 'Your words.', 'lib.search': 'Search a word, a translation, a song…',
  'lib.export': 'Export CSV (Anki)', 'lib.hint': 'Hover a word to see the line of the song it comes from.',
  'lib.empty': 'No saved words yet. Open a song, click a word, then “Save”.',
  'foot.priv': 'Privacy',
  'foot.text': ' · Lyrics Learn is not affiliated with Genius. Lyrics belong to their authors and are shown for learning purposes. Genius is a trademark of Genius Media Group Inc.',
  'dlg.add': 'Add', 'dlg.new': 'New song', 'dlg.via': 'Lyrics via', 'dlg.q': 'Title, artist… or Genius link', 'dlg.search': 'Search',
  'dlg.manual': 'Paste lyrics manually', 'dlg.title': 'Title', 'dlg.artist': 'Artist', 'dlg.lyrics': 'Lyrics…', 'dlg.use': 'Use these lyrics', 'dlg.mine': 'My songs',
  'common.close': 'Close', 'common.remove': 'Remove', 'common.delete': 'Delete', 'common.error': 'Error', 'common.untitled': 'Untitled', 'common.song': 'Song',
  'engine.name': 'the translation engine',
  'kicker.now': 'Now reading',
  'engine.simplified': 'Simplified translation: the main engine is temporarily unavailable.',
  'src.lyricsOn': 'Lyrics on',
  'goal.suggest': 'Suggest', 'goal.more': 'More words', 'goal.suggestAria': 'Suggest words',
  'songs.empty': 'No songs yet.',
  'stat.song': 'Song', 'stat.songs': 'Songs', 'stat.saved': 'Saved words', 'stat.learned': 'Learned words',
  'card.progress': '{done} / {tot} words learned', 'card.nogoal': 'No goal', 'card.current': 'Reading', 'card.new': 'New song',
  'listen.on': 'Listen on',
  'player.listen': 'Listen · {p}', 'player.change': 'Change', 'player.remove': 'Remove',
  'player.note': 'Depending on the service, full playback requires being signed in to your account in this browser; otherwise a preview plays.',
  'player.ph': 'Spotify, Apple Music, Deezer, YouTube or SoundCloud link', 'player.addBtn': 'Add', 'player.cancel': 'Cancel',
  'player.add': '＋ Add a player', 'player.title': 'Player', 'player.listenLabel': 'Listen', 'player.finding': 'Looking for players…', 'player.notFound': 'Not found for this song', 'player.none': 'No player found for this song. Paste a link to add one.', 'player.link': '＋ Add a link',
  'player.err': 'Link not recognized. Paste a share link for a track (Spotify, Apple Music, Deezer, YouTube, SoundCloud).',
  'panel.title': 'Translation', 'panel.placeholder': 'Click a word in the lyrics, or select several words, to see its translation here.',
  'panel.note': 'Note', 'panel.saved': 'Saved ✓', 'panel.save': 'Save', 'panel.goalRemove': 'Remove from goal', 'panel.goalAdd': 'Add to goal',
  'imp.nothing': 'Nothing to import: copy the lyrics first.',
  'search.searching': 'Searching…', 'search.none': 'No results.',
  'search.notConfigured': 'Search is not configured: add GENIUS_TOKEN (see README). You can paste a Genius link instead.',
  'search.fallback': ' In the meantime, you can paste a Genius link directly in this field.',
  'imp.sub': 'Import the lyrics in 3 steps', 'imp.openGenius': 'Open the Genius page', 'imp.openOn': 'Open on Genius',
  'imp.openNote': 'It opens in a small window next to the app, which stays open.',
  'imp.step2': 'In the Genius window: click the text, then', 'imp.then': 'then', 'imp.copied': 'Copied ✓',
  'imp.step3': 'Come back to the app: the copied lyrics are detected automatically.', 'imp.paste': '📋 Paste copied lyrics',
  'imp.found': 'Lyrics found, importing…',
  'imp.noLyrics': 'The clipboard does not contain the lyrics. Select all and copy again in the Genius window.',
  'imp.denied': 'Clipboard access denied: allow it, or use “Paste lyrics manually”.',
  'imp.blockedPre': 'Window blocked: ', 'imp.blockedLink': 'open Genius in a tab', 'imp.blockedPost': ', then come back here.',
  'manual.empty': 'Paste some lyrics first.',
  'csv.name': 'word-library.csv'
};

const FR = {
  'nav.home': 'Accueil', 'nav.read': 'Lecture', 'nav.library': 'Bibliothèque', 'nav.add': '+ Chanson',
  'lang.translateTo': 'Traduire en',
  'home.kicker': 'Apprendre par la chanson',
  'home.title': 'Apprenez une langue avec vos chansons.',
  'home.lead': 'Importez les paroles, lisez-les avec leur traduction, choisissez les mots à retenir, et retrouvez chacun avec la phrase d’où il vient.',
  'home.add': 'Ajouter une chanson', 'home.resume': 'Reprendre la lecture', 'home.songs': 'Mes chansons', 'home.how': 'Comment ça marche',
  'home.s1': 'Ajoutez une chanson : les paroles sont importées puis traduites ligne par ligne.',
  'home.s2': 'Cliquez un mot, ou sélectionnez une expression, pour la traduire et l’enregistrer.',
  'home.s3': 'Fixez un objectif de mots : ils sont mis en relief dans les paroles.',
  'home.s4': 'Retrouvez vos mots dans la bibliothèque, avec la phrase de la chanson dont ils viennent.',
  'read.kicker': 'Lecture', 'read.none': 'Aucune chanson ouverte.',
  'toggle.tr': 'Traduction',
  'tip.first': 'Cliquez un mot pour le traduire. Sélectionnez plusieurs mots pour une expression.',
  'goal.title': 'Objectif', 'goal.count': 'Nombre de mots', 'goal.quiz': 'Mode révision : masquer les traductions',
  'lib.kicker': 'Bibliothèque', 'lib.title': 'Vos mots.', 'lib.search': 'Rechercher un mot, une traduction, une chanson…',
  'lib.export': 'Exporter CSV (Anki)', 'lib.hint': 'Survolez un mot pour voir la phrase de la chanson dont il est tiré.',
  'lib.empty': 'Aucun mot enregistré. Ouvrez une chanson, cliquez sur un mot puis « Enregistrer ».',
  'foot.priv': 'Confidentialité',
  'foot.text': ' · Lyrics Learn n’est pas affilié à Genius. Les paroles appartiennent à leurs auteurs et sont affichées pour l’apprentissage. Genius est une marque de Genius Media Group Inc.',
  'dlg.add': 'Ajouter', 'dlg.new': 'Nouvelle chanson', 'dlg.via': 'Paroles via', 'dlg.q': 'Titre, artiste… ou lien Genius', 'dlg.search': 'Rechercher',
  'dlg.manual': 'Coller des paroles à la main', 'dlg.title': 'Titre', 'dlg.artist': 'Artiste', 'dlg.lyrics': 'Paroles…', 'dlg.use': 'Utiliser ces paroles', 'dlg.mine': 'Mes chansons',
  'common.close': 'Fermer', 'common.remove': 'Retirer', 'common.delete': 'Supprimer', 'common.error': 'Erreur', 'common.untitled': 'Sans titre', 'common.song': 'Chanson',
  'engine.name': 'le moteur de traduction',
  'kicker.now': 'En cours',
  'engine.simplified': 'Traduction simplifiée : le moteur principal est momentanément indisponible.',
  'src.lyricsOn': 'Paroles sur',
  'goal.suggest': 'Suggérer', 'goal.more': 'Autres mots', 'goal.suggestAria': 'Suggérer des mots',
  'songs.empty': 'Aucune chanson pour l’instant.',
  'stat.song': 'Chanson', 'stat.songs': 'Chansons', 'stat.saved': 'Mots enregistrés', 'stat.learned': 'Mots appris',
  'card.progress': '{done} / {tot} mots appris', 'card.nogoal': 'Pas d’objectif', 'card.current': 'En cours', 'card.new': 'Nouvelle chanson',
  'listen.on': 'Écouter sur',
  'player.listen': 'Écouter · {p}', 'player.change': 'Changer', 'player.remove': 'Retirer',
  'player.note': 'Selon le service, l’écoute complète demande d’être connecté à votre compte dans ce navigateur ; sinon un extrait est joué.',
  'player.ph': 'Lien Spotify, Apple Music, Deezer, YouTube ou SoundCloud', 'player.addBtn': 'Ajouter', 'player.cancel': 'Annuler',
  'player.add': '＋ Ajouter un lecteur', 'player.title': 'Lecteur', 'player.listenLabel': 'Écouter', 'player.finding': 'Recherche des lecteurs…', 'player.notFound': 'Introuvable pour cette chanson', 'player.none': 'Aucun lecteur trouvé pour cette chanson. Collez un lien pour en ajouter un.', 'player.link': '＋ Ajouter un lien',
  'player.err': 'Lien non reconnu. Collez le lien de partage d’un titre (Spotify, Apple Music, Deezer, YouTube, SoundCloud).',
  'panel.title': 'Traduction', 'panel.placeholder': 'Cliquez un mot dans les paroles, ou sélectionnez plusieurs mots, pour voir sa traduction ici.',
  'panel.note': 'Note', 'panel.saved': 'Enregistré ✓', 'panel.save': 'Enregistrer', 'panel.goalRemove': 'Retirer de l’objectif', 'panel.goalAdd': 'Ajouter à l’objectif',
  'imp.nothing': 'Rien à importer : copiez d’abord les paroles.',
  'search.searching': 'Recherche…', 'search.none': 'Aucun résultat.',
  'search.notConfigured': 'Recherche non configurée : ajoutez GENIUS_TOKEN (voir README). Vous pouvez coller un lien Genius à la place.',
  'search.fallback': ' En attendant, vous pouvez coller directement un lien Genius dans ce champ.',
  'imp.sub': 'Importer les paroles en 3 gestes', 'imp.openGenius': 'Ouvrir la page Genius', 'imp.openOn': 'Ouvrir sur Genius',
  'imp.openNote': 'Elle s’ouvre dans une petite fenêtre à côté de l’app, qui reste ouverte.',
  'imp.step2': 'Dans la fenêtre Genius : cliquez sur le texte, puis', 'imp.then': 'puis', 'imp.copied': 'Copié ✓',
  'imp.step3': 'Revenez dans l’app : les paroles copiées sont détectées automatiquement.', 'imp.paste': '📋 Coller les paroles copiées',
  'imp.found': 'Paroles trouvées, import en cours…',
  'imp.noLyrics': 'Le presse-papiers ne contient pas les paroles. Refaites tout sélectionner puis copier dans la fenêtre Genius.',
  'imp.denied': 'Accès au presse-papiers refusé : autorisez-le, ou collez dans « Coller à la main ».',
  'imp.blockedPre': 'Fenêtre bloquée : ', 'imp.blockedLink': 'ouvrir Genius dans un onglet', 'imp.blockedPost': ', puis revenez ici.',
  'manual.empty': 'Collez des paroles d’abord.',
  'csv.name': 'bibliotheque-mots.csv'
};

const DICT = { en: EN, fr: FR };
let lang = 'en';
try { const s = localStorage.getItem('ll_ui'); if (s === 'fr' || s === 'en') lang = s; } catch {}
document.documentElement.lang = lang;

export const getLang = () => lang;
export function t(key, vars) {
  let s = DICT[lang][key] ?? EN[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}
export function setLang(l) {
  lang = l === 'fr' ? 'fr' : 'en';
  try { localStorage.setItem('ll_ui', lang); } catch {}
  document.documentElement.lang = lang;
  applyStatic();
}
// Applique la langue aux textes fixes de la page (attributs data-i18n*).
export function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.title = lang === 'fr' ? 'Lyrics Learn · apprendre une langue avec les paroles' : 'Lyrics Learn · learn a language with lyrics';
  document.querySelectorAll('[data-lang]').forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
}
