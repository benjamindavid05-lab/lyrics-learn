// Connexion Spotify SANS quitter Lyrio : OAuth (PKCE) dans une petite fenêtre, puis lecture complète via le Web Playback SDK.
// Comptes Premium uniquement (limite de Spotify). Aucun secret côté navigateur : PKCE n'en a pas besoin.

const SCOPES = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';
const LS = 'll_sp';

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function pkceChallenge(verifier) { return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))); }
export function randomVerifier(len = 48) { const a = new Uint8Array(len); crypto.getRandomValues(a); return b64url(a); }
export const redirectUri = () => location.origin + '/spotify-callback.html';

function load() { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch { return null; } }
function store(t) { try { localStorage.setItem(LS, JSON.stringify(t)); } catch { /* stockage indisponible */ } }
export const isConnected = () => !!(load() && load().refresh);
export function disconnect() { try { localStorage.removeItem(LS); } catch { /* rien */ } }

async function tokenRequest(body) {
  const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  if (!r.ok) throw new Error('token ' + r.status);
  const j = await r.json(); const old = load();
  return { access: j.access_token, refresh: j.refresh_token || (old && old.refresh), exp: Date.now() + (j.expires_in - 60) * 1000 };
}
export async function token() {
  const t = load(); if (!t) throw new Error('not connected');
  if (Date.now() < t.exp) return t.access;
  const n = await tokenRequest({ client_id: t.clientId, grant_type: 'refresh_token', refresh_token: t.refresh });
  store({ ...n, clientId: t.clientId }); return n.access;
}

/** Ouvre la fenêtre de connexion Spotify (le site reste ouvert) et mémorise les jetons. */
export async function connect(clientId) {
  const verifier = randomVerifier(), challenge = await pkceChallenge(verifier), state = randomVerifier(12);
  const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri(), code_challenge_method: 'S256', code_challenge: challenge, state, scope: SCOPES });
  const w = window.open(url, 'lyrio-spotify', 'width=480,height=720');
  if (!w) throw new Error('popup');
  const code = await new Promise((resolve, reject) => {
    const done = () => { clearInterval(timer); removeEventListener('message', onMsg); };
    const onMsg = (e) => {
      if (e.origin !== location.origin || !e.data || !e.data.llSpotify) return;
      done(); const m = e.data.llSpotify;
      if (m.error || m.state !== state) reject(new Error(m.error || 'state')); else resolve(m.code);
    };
    addEventListener('message', onMsg);
    const timer = setInterval(() => { if (w.closed) { done(); reject(new Error('closed')); } }, 600);
  });
  const t = await tokenRequest({ client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
  store({ ...t, clientId }); return true;
}

let sdk = null;
function loadSdk() {
  return (sdk ||= new Promise((resolve, reject) => {
    if (window.Spotify && window.Spotify.Player) return resolve();
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const s = document.createElement('script'); s.src = 'https://sdk.scdn.co/spotify-player.js'; s.async = true;
    s.onerror = () => { sdk = null; reject(new Error('sdk')); };
    document.head.append(s); setTimeout(() => reject(new Error('timeout')), 12000);
  }));
}

let current = null;
/** Lecteur Spotify intégré à la page (un seul pour toute la session). handlers = { onState(state), onError(kind) } */
export async function startPlayer(handlers) {
  if (current) { current.handlers = handlers; return current; }
  await loadSdk();
  const player = new window.Spotify.Player({ name: 'Lyrio', getOAuthToken: (cb) => token().then(cb).catch(() => cb('')), volume: 0.85 });
  const box = { handlers, player, deviceId: '' };
  const ready = new Promise((resolve, reject) => {
    player.addListener('ready', ({ device_id }) => resolve(device_id));
    for (const ev of ['initialization_error', 'authentication_error']) player.addListener(ev, (e) => { box.handlers.onError && box.handlers.onError('auth'); reject(new Error(e.message)); });
    player.addListener('account_error', () => { box.handlers.onError && box.handlers.onError('premium'); reject(new Error('premium')); });
    setTimeout(() => reject(new Error('timeout')), 12000);
  });
  player.addListener('player_state_changed', (st) => { if (st) box.handlers.onState(st); });
  if (!(await player.connect())) throw new Error('connect');
  box.deviceId = await ready;
  box.playTrack = async (uri) => {
    if (player.activateElement) player.activateElement();
    const tk = await token();
    const r = await fetch('https://api.spotify.com/v1/me/player/play?device_id=' + box.deviceId, { method: 'PUT', headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' }, body: JSON.stringify({ uris: [uri] }) });
    if (!r.ok && r.status !== 204) throw new Error('play ' + r.status);
  };
  box.pause = () => player.pause(); box.resume = () => player.resume(); box.seek = (sec) => player.seek(Math.max(0, sec) * 1000);
  box.stop = () => { try { player.disconnect(); } catch { /* rien */ } current = null; };
  current = box; return box;
}
