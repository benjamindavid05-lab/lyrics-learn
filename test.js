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
console.log('ok');
