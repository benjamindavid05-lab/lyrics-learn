// Extrait de la fiche d'une chanson Genius les liens d'écoute (Spotify, YouTube, SoundCloud).
export function extractMedia(song) {
  const out = { spotify: '', youtube: '', soundcloud: '' };
  for (const m of Array.isArray(song?.media) ? song.media : []) {
    const p = String(m?.provider || '').toLowerCase(), u = String(m?.url || '');
    if (!/^https?:\/\//i.test(u)) continue;
    if (p === 'spotify' && !out.spotify) out.spotify = u;
    else if (p === 'youtube' && !out.youtube) out.youtube = u;
    else if (p === 'soundcloud' && !out.soundcloud) out.soundcloud = u;
  }
  return out;
}
