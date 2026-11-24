import { getLocale, getTranslations } from 'next-intl/server';
import { requirePage } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { Pagination } from '@/components/app/pagination';
import { Card } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDateTime, type AppLocale } from '@/lib/format';

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ page?: string; entity?: string }> }) {
  await requirePage('settings.manage');
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const t = await getTranslations('settings');
  const locale = (await getLocale()) as AppLocale;
  const supabase = await createClient();
  let q = supabase.from('audit_logs').select('id, actor_id, actor_label, action, entity_type, entity_id, before, after, created_at', { count: 'exact' })
    .order('created_at', { ascending: false }).range((page - 1) * 50, page * 50 - 1);
  if (sp.entity) q = q.eq('entity_type', sp.entity);
  const [{ data, count }, { data: staff }] = await Promise.all([q, supabase.from('staff_directory').select('id, full_name')]);
  const names = Object.fromEntries((staff ?? []).map((s) => [s.id, s.full_name]));
  return (
    <div>
      <PageHeader title={t('audit')} />
      <Card className="overflow-hidden">
        <Table>
          <THead><TR><TH>{t('action')}</TH><TH>{t('entity')}</TH><TH>{t('actor')}</TH><TH>Δ</TH><TH /></TR></THead>
          <TBody>
            {(data ?? []).map((r) => {
              const before = (r.before ?? {}) as Record<string, unknown>;
              const after = (r.after ?? {}) as Record<string, unknown>;
              const changed = Object.keys({ ...before, ...after }).filter((k) => k !== 'updated_at' && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
              return (
                <TR key={r.id}>
                  <TD className="font-medium">{r.action}</TD>
                  <TD className="text-xs">{r.entity_type}<div className="font-mono text-muted-foreground">{r.entity_id?.slice(0, 8)}</div></TD>
                  <TD className="text-xs">{r.actor_id ? names[r.actor_id] ?? r.actor_id.slice(0, 8) : r.actor_label}</TD>
                  <TD className="max-w-[420px] text-xs">
                    {changed.slice(0, 6).map((k) => (
                      <div key={k} className="truncate"><span className="text-muted-foreground">{k}:</span> {JSON.stringify(before[k] ?? null)} → {JSON.stringify(after[k] ?? null)}</div>
                    ))}
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(r.created_at, locale)}</TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>
      <Pagination page={page} pageSize={50} total={count ?? 0} searchParams={sp as Record<string, string | undefined>} />
    </div>
  );
}
