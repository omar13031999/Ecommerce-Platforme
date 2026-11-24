import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await getSession())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const supabase = await createClient();
  const [{ data: items }, { count }] = await Promise.all([
    supabase.from('notifications').select('id, type, params, link, read_at, created_at').order('created_at', { ascending: false }).limit(20),
    supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
  ]);
  return NextResponse.json({ items: items ?? [], unread: count ?? 0 });
}

export async function POST() {
  if (!(await getSession())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const supabase = await createClient();
  await supabase.rpc('mark_notifications_read', { p_ids: null });
  return NextResponse.json({ ok: true });
}
