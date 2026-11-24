import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isGoogleConfigured } from '@/lib/env';
import { googleAuthUrl } from '@/lib/integrations/google-sheets/google';
import { createOAuthState } from '@/lib/services/oauth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.can('integrations.manage')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!isGoogleConfigured()) return NextResponse.redirect(new URL('/settings/integrations?error=integration_not_configured', req.url));
  const { state, challenge } = await createOAuthState('google', session.userId);
  return NextResponse.redirect(googleAuthUrl(state, challenge));
}
