// Uwierzytelnianie Cognito (USER_PASSWORD_AUTH) — bez zależności, przez REST IDP.
// Rola przez grupę 'admin' (claim cognito:groups w ID tokenie).
const REGION = (import.meta.env.VITE_COGNITO_REGION as string) || 'eu-central-1';
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
const IDP = `https://cognito-idp.${REGION}.amazonaws.com/`;
const KEY = 'maxai_session';

export type Session = { idToken: string; groups: string[]; username: string; exp: number };

function parseJwt(token: string): Record<string, unknown> {
  const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(p));
}

function toSession(idToken: string, fallbackUser: string): Session {
  const c = parseJwt(idToken);
  const g = c['cognito:groups'];
  const groups = Array.isArray(g) ? (g as string[]) : g ? [String(g)] : [];
  return {
    idToken,
    groups,
    username: String(c['cognito:username'] ?? c['email'] ?? fallbackUser),
    exp: Number(c['exp'] ?? 0),
  };
}

export async function login(username: string, password: string): Promise<Session> {
  if (!CLIENT_ID) throw new Error('Brak VITE_COGNITO_CLIENT_ID w konfiguracji frontendu.');
  const r = await fetch(IDP, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body: JSON.stringify({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || 'Logowanie nieudane.');
  if (j.ChallengeName) {
    throw new Error('Konto wymaga zmiany hasła — ustaw stałe hasło (admin-set-user-password --permanent).');
  }
  const session = toSession(j.AuthenticationResult.IdToken as string, username);
  localStorage.setItem(KEY, JSON.stringify(session));
  return session;
}

export function loadSession(): Session | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    if (!s.exp || s.exp * 1000 < Date.now()) {
      localStorage.removeItem(KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function logout() {
  localStorage.removeItem(KEY);
}

export const isAdmin = (s: Session | null) => !!s && s.groups.includes('admin');
