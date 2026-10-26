// Autenticación con Spotify: Authorization Code + PKCE (100 % en el navegador).
import { SPOTIFY_CLIENT_ID, REDIRECT_URI, SCOPES } from './config.js';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const KEY_TOKENS = 'ipod.auth';
const KEY_VERIFIER = 'ipod.pkce';
const KEY_STATE = 'ipod.state';

const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function randomString(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

function readTokens() {
  try {
    return JSON.parse(localStorage.getItem(KEY_TOKENS));
  } catch {
    return null;
  }
}

function saveTokens(data) {
  const prev = readTokens();
  localStorage.setItem(
    KEY_TOKENS,
    JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token || prev?.refresh_token,
      expires_at: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000,
    }),
  );
}

export const isConfigured = () =>
  Boolean(SPOTIFY_CLIENT_ID) && !SPOTIFY_CLIENT_ID.startsWith('PEGA_AQUI');

export const isLoggedIn = () => Boolean(readTokens()?.access_token);

export function logout() {
  localStorage.removeItem(KEY_TOKENS);
}

export async function login() {
  const verifier = randomString(64);
  const state = randomString(16);
  localStorage.setItem(KEY_VERIFIER, verifier);
  localStorage.setItem(KEY_STATE, state);

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: base64url(await sha256(verifier)),
    scope: SCOPES,
    state,
  });
  window.location.assign(`${AUTH_URL}?${params}`);
}

/** Procesa la vuelta desde Spotify (?code=…). Devuelve { error } si algo falla. */
export async function handleRedirect() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return {};

  // Limpia la URL para no reutilizar el código.
  window.history.replaceState(null, '', url.pathname);

  const expectedState = localStorage.getItem(KEY_STATE);
  const verifier = localStorage.getItem(KEY_VERIFIER);
  localStorage.removeItem(KEY_STATE);
  localStorage.removeItem(KEY_VERIFIER);

  if (error) return { error: error === 'access_denied' ? 'Conexión cancelada' : `Spotify: ${error}` };
  if (!verifier || url.searchParams.get('state') !== expectedState) {
    return { error: 'Inicio de sesión inválido, intenta de nuevo' };
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error_description || 'No se pudo iniciar sesión' };
  saveTokens(data);
  return {};
}

let refreshing = null;

export function refreshToken() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const tokens = readTokens();
    if (!tokens?.refresh_token) {
      logout();
      return null;
    }
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SPOTIFY_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      }),
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) logout();
      return null;
    }
    const data = await res.json();
    saveTokens(data);
    return data.access_token;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function getAccessToken() {
  const tokens = readTokens();
  if (!tokens) return null;
  if (Date.now() < tokens.expires_at) return tokens.access_token;
  return refreshToken();
}
