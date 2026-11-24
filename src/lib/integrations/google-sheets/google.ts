import 'server-only';
import { serverEnv } from '@/lib/env';
import { httpJson, ProviderError } from '@/lib/integrations/http';

/** Official Google OAuth 2.0 + Sheets API v4 endpoints. */
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/spreadsheets.readonly'];

export type GoogleTokens = { access_token: string; refresh_token?: string; expires_at: number; scope?: string };

function redirectUri() {
  return `${serverEnv().APP_URL}/api/oauth/google/callback`;
}

export function googleAuthUrl(state: string, codeChallenge: string) {
  const env = serverEnv();
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID ?? '');
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number; scope?: string };

export async function exchangeGoogleCode(code: string, codeVerifier: string): Promise<GoogleTokens> {
  const env = serverEnv();
  const { data } = await httpJson<TokenResponse>({
    url: TOKEN_URL,
    method: 'POST',
    form: {
      code, code_verifier: codeVerifier, client_id: env.GOOGLE_CLIENT_ID ?? '', client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: redirectUri(), grant_type: 'authorization_code',
    },
  });
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000, scope: data.scope };
}

export async function refreshGoogleToken(tokens: GoogleTokens): Promise<GoogleTokens> {
  if (tokens.expires_at - Date.now() > 120_000) return tokens;
  if (!tokens.refresh_token) throw new ProviderError('auth', 'google_refresh_token_missing');
  const env = serverEnv();
  const { data } = await httpJson<TokenResponse>({
    url: TOKEN_URL,
    method: 'POST',
    form: { client_id: env.GOOGLE_CLIENT_ID ?? '', client_secret: env.GOOGLE_CLIENT_SECRET ?? '', refresh_token: tokens.refresh_token, grant_type: 'refresh_token' },
  }).catch((e) => {
    // invalid_grant = revoked / expired consent
    if (e instanceof ProviderError && e.kind === 'validation') throw new ProviderError('auth', 'google_token_revoked', e.status, e.body);
    throw e;
  });
  return { ...tokens, access_token: data.access_token, expires_at: Date.now() + data.expires_in * 1000 };
}

export async function googleUserEmail(accessToken: string): Promise<string | null> {
  const { data } = await httpJson<{ email?: string }>({ url: USERINFO_URL, headers: { Authorization: `Bearer ${accessToken}` } });
  return data.email ?? null;
}

export async function listWorksheets(accessToken: string, spreadsheetId: string) {
  const { data } = await httpJson<{ properties: { title: string }; sheets: { properties: { title: string; sheetId: number; gridProperties?: { rowCount: number } } }[] }>({
    url: `${SHEETS_URL}/${encodeURIComponent(spreadsheetId)}`,
    query: { fields: 'properties.title,sheets.properties(title,sheetId,gridProperties.rowCount)' },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return { title: data.properties.title, sheets: data.sheets.map((s) => s.properties.title) };
}

/** Reads header row + data rows as formatted strings. */
export async function readSheet(accessToken: string, spreadsheetId: string, worksheet: string, headerRow: number) {
  const range = `'${worksheet.replace(/'/g, "''")}'!A${headerRow}:ZZ`;
  const { data } = await httpJson<{ values?: string[][] }>({
    url: `${SHEETS_URL}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    query: { valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS' },
    headers: { Authorization: `Bearer ${accessToken}` },
    timeoutMs: 45000,
  });
  const values = data.values ?? [];
  return { header: values[0] ?? [], rows: values.slice(1) };
}
