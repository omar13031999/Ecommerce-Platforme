import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isMetaConfigured } from '@/lib/env';
import { metaAuthUrl } from '@/lib/integrations/meta/meta';
import { createOAuthState } from '@/lib/services/oauth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.can('integrations.manage')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!isMetaConfigured()) return NextResponse.redirect(new URL('/settings/integrations?error=integration_not_configured', req.url));
  const { state } = await createOAuthState('meta', session.userId);
  return NextResponse.redirect(metaAuthUrl(state));
}
