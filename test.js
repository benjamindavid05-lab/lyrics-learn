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
console.log('ok');
