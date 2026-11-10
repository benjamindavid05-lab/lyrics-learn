import assert from 'node:assert/strict';
import { parseGenius, isGeniusUrl } from './genius.js';

const html = `<html><head><meta property="og:title" content="Eden Derso – Ra’o Tov Lyrics | Genius Lyrics"></head><body>
<div data-lyrics-container="true" class="Lyrics__Container"><div class="LyricsHeader__Container" data-exclude-from-selection="true"><div>Contributors</div></div>[Verse 1]<br/>אני <a href="#"><span>אוהב</span></a><br/>It&#x27;s &amp; fine<br/><br/>[Chorus]<br/>לה לה</div>
<div data-lyrics-container="true">Second<br>block</div></body></html>`;
const r = parseGenius(html);
assert.equal(r.artist, 'Eden Derso');
assert.equal(r.title, 'Ra’o Tov');
assert.equal(r.lyrics, "[Verse 1]\nאני אוהב\nIt's & fine\n\n[Chorus]\nלה לה\nSecond\nblock");
assert.equal(parseGenius('<html></html>'), null);
assert.ok(isGeniusUrl('https://genius.com/Eden-derso-ra-o-tov-lyrics'));
assert.ok(!isGeniusUrl('https://evil.com/?genius.com'));
assert.ok(!isGeniusUrl('http://genius.com/x'));
import { extractMedia } from './genius-media.js';
const media = extractMedia({ media: [
  { provider: 'youtube', type: 'video', url: 'http://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  { provider: 'spotify', type: 'audio', url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' },
  { provider: 'spotify', url: 'https://open.spotify.com/track/DOUBLON' },
  { provider: 'soundcloud', url: 'javascript:alert(1)' },
  { provider: 'inconnu', url: 'https://exemple.com' }
] });
assert.equal(media.spotify, 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
assert.equal(media.youtube, 'http://www.youtube.com/watch?v=dQw4w9WgXcQ');
assert.equal(media.soundcloud, '');
assert.deepEqual(extractMedia(undefined), { spotify: '', youtube: '', soundcloud: '' });
import { variants, best, cleanApple, findTracks } from './find-track.js';
// titres/artistes Genius : graphie latine + graphie d'origine
assert.deepEqual(variants('Eden Derso - עדן דרסו'), ['Eden Derso', 'עדן דרסו']);
assert.deepEqual(variants('Otobussim - אוטובוסים (Live)'), ['Otobussim', 'אוטובוסים']);
const cands = [
  { title: 'Autre chanson', artist: 'Quelqu\'un', id: 1 },
  { title: 'אוטובוסים', artist: 'עדן דרסו', id: 2 },
  { title: 'אוטובוסים', artist: 'Un Autre Artiste', id: 3 }
];
assert.equal(best(cands, ['Otobussim', 'אוטובוסים'], ['Eden Derso', 'עדן דרסו']).id, 2);
assert.equal(best([{ title: 'Amen', artist: 'Eden Derso & DJ Mesh' }], ['Amen'], ['Eden Derso']).title, 'Amen');
assert.equal(best([{ title: 'Totalement différent', artist: 'Eden Derso' }], ['Amen'], ['Eden Derso']), null);
assert.equal(cleanApple('https://itunes.apple.com/us/album/x/123?i=456&uo=4'), 'https://music.apple.com/us/album/x/123?i=456');
assert.equal(cleanApple('https://evil.example.com/us/album/x/1?i=2'), '');
assert.equal(cleanApple('javascript:alert(1)'), '');
// recherche complète avec un faux réseau
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  if (u.includes('api.deezer.com')) return json({ data: [{ id: 3135556, title: 'אוטובוסים', artist: { name: 'עדן דרסו' } }, { id: 9, title: 'Zzz', artist: { name: 'Nobody' } }] });
  if (u.includes('itunes.apple.com')) return json({ results: [{ trackName: 'אוטובוסים', artistName: 'עדן דרסו', trackViewUrl: 'https://music.apple.com/us/album/otobussim/1558533900?i=1558534271&uo=4' }] });
  throw new Error('réseau inattendu: ' + u);
};
const found = await findTracks({ title: 'Otobussim - אוטובוסים', artist: 'Eden Derso - עדן דרסו' });
globalThis.fetch = realFetch;
assert.equal(found.deezer, 'https://www.deezer.com/track/3135556');
assert.equal(found.apple, 'https://music.apple.com/us/album/otobussim/1558533900?i=1558534271');
assert.equal(found.spotify, ''); assert.equal(found.youtube, '');
import { parseEmbedCode, embedSrcdoc, cleanEmbedText } from './public/embed.js';
// le code « Embed » tel que Genius le donne
const snippet = `<div id='rg_embed_link_4494161' class='rg_embed_link' data-song-id='4494161'>Read <a href='https://genius.com/Makala-big-boy-lyrics'>“Big Boy” by Makala</a> on Genius</div> <script crossorigin src='//genius.com/songs/4494161/embed.js'></script>`;
assert.deepEqual(parseEmbedCode(snippet), { id: '4494161', url: 'https://genius.com/Makala-big-boy-lyrics', title: 'Big Boy', artist: 'Makala' });
assert.equal(parseEmbedCode('//genius.com/songs/123/embed.js').id, '123');
assert.equal(parseEmbedCode('eden derso'), null);
assert.equal(parseEmbedCode("<div id='rg_embed_link_12a'>"), null);
assert.equal(parseEmbedCode("<div id='rg_embed_link_5'><a href='https://evil.example.com/x'>T by A</a>").url, '');
assert.throws(() => embedSrcdoc('1"><script>alert(1)</script>'));
assert.ok(embedSrcdoc('4494161').includes('https://genius.com/songs/4494161/embed.js'));
assert.equal(cleanEmbedText('Big Boy Lyrics\n[Verse 1]\nligne un\nligne deux\n\n\n\n[Chorus]\nlà\nRead the full lyrics on Genius\nautre'), '[Verse 1]\nligne un\nligne deux\n\n[Chorus]\nlà');
assert.equal(cleanEmbedText('sans balise\nvers 2'), 'sans balise\nvers 2');
import { normLang, guessScript, flagOf, langName } from './public/langs.js';
assert.equal(normLang('iw'), 'he'); assert.equal(normLang('HE'), 'he'); assert.equal(normLang('zh-TW'), 'zh');
assert.equal(normLang('auto'), ''); assert.equal(normLang(''), ''); assert.equal(normLang(undefined), ''); assert.equal(normLang('nb'), 'no'); assert.equal(normLang('EN-GB'), 'en');
assert.equal(guessScript('אוהב'), 'he'); assert.equal(guessScript('привет'), 'ru'); assert.equal(guessScript('こんにちは'), 'ja');
assert.equal(guessScript('안녕'), 'ko'); assert.equal(guessScript('你好'), 'zh'); assert.equal(guessScript('مرحبا'), 'ar'); assert.equal(guessScript('hola'), '');
assert.equal(flagOf('he'), '🇮🇱'); assert.equal(flagOf('iw'), '🇮🇱'); assert.equal(flagOf('es'), '🇪🇸'); assert.equal(flagOf('fr'), '🇫🇷'); assert.equal(flagOf('ca'), '🌐'); assert.equal(flagOf(''), '🌐');
assert.equal(langName('he', 'en'), 'Hebrew'); assert.equal(langName('he', 'fr'), 'Hébreu'); assert.equal(langName('es', 'fr'), 'Espagnol');
assert.equal(langName('', 'en'), 'Unknown language'); assert.equal(langName('', 'fr'), 'Langue inconnue');
console.log('ok');
