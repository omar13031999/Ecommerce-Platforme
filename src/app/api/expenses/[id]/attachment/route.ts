import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/** Redirects to a 60-second signed URL after checking finance access via RLS. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !(session.can('finance.view') || session.can('expenses.manage'))) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from('expenses').select('attachment_path').eq('id', id).maybeSingle();
  if (!data?.attachment_path) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const { data: signed } = await createAdminClient().storage.from('expense-attachments').createSignedUrl(data.attachment_path, 60);
  if (!signed?.signedUrl) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.redirect(signed.signedUrl);
}
