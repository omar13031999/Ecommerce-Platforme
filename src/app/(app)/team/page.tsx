import { getLocale, getTranslations } from 'next-intl/server';
import { requirePage } from '@/lib/auth/session';
import { resolveRange } from '@/lib/dates';
import { createClient } from '@/lib/supabase/server';
import { rpc } from '@/lib/queries';
import { PageHeader } from '@/components/app/page-header';
import { DateRangeFilter } from '@/components/app/date-range-filter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatNumber, formatPercent, type AppLocale } from '@/lib/format';
import { CreateMemberDialog, EditMemberDialog } from './team-client';

type Perf = { agent_id: string; current_workload: number; assigned: number; confirmed: number; cancelled: number; no_answer: number; status_changes: number; confirmation_rate: number | null; avg_minutes_to_confirm: number | null };

export default async function TeamPage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const session = await requirePage('team.view');
  const range = resolveRange(await searchParams, 'last7');
  const t = await getTranslations();
  const locale = (await getLocale()) as AppLocale;
  const supabase = await createClient();
  const [{ data: members }, perf] = await Promise.all([
    supabase.from('profiles').select('id, full_name, email, phone, role, permissions, is_active, max_active_orders, accepts_assignments').order('role').order('full_name'),
    rpc<Perf[]>('agent_performance', { p_from: range.from, p_to: range.to }),
  ]);
  const perfBy = Object.fromEntries(perf.map((p) => [p.agent_id, p]));
  const isOwner = session.profile.role === 'admin';
  const canManage = session.can('team.manage');

  return (
    <div className="grid gap-5">
      <PageHeader title={t('team.title')} actions={<><DateRangeFilter range={range} />{canManage ? <CreateMemberDialog isOwner={isOwner} /> : null}</>} />
      <Card className="overflow-hidden">
        <Table>
          <THead><TR>
            <TH>{t('team.fullName')}</TH><TH>{t('team.role')}</TH><TH>{t('common.status')}</TH><TH>{t('team.workload')}</TH>
            <TH>{t('team.assigned')}</TH><TH>{t('team.confirmed')}</TH><TH>{t('team.cancelled')}</TH><TH>{t('team.noAnswer')}</TH>
            <TH>{t('team.rate')}</TH><TH>{t('team.avgTime')}</TH><TH />
          </TR></THead>
          <TBody>
            {(members ?? []).map((m) => {
              const p = perfBy[m.id];
              const canEdit = canManage && (isOwner || m.role === 'agent');
              return (
                <TR key={m.id} className={m.is_active ? '' : 'opacity-60'}>
                  <TD><div className="font-medium">{m.full_name}</div><div className="text-xs text-muted-foreground" dir="ltr">{m.email}</div></TD>
                  <TD>
                    <span className="text-sm">{t(`team.role_${m.role}`)}</span>
                    {m.permissions?.length ? <div className="mt-0.5 flex flex-wrap gap-1">{(m.permissions as string[]).map((x) => <Badge key={x} className="bg-accent text-accent-foreground ring-primary/20">{t(`permissions.${x.replace('.', '_')}` as 'permissions.finance_view')}</Badge>)}</div> : null}
                  </TD>
                  <TD>{m.is_active ? <Badge className="bg-green-50 text-green-700 ring-green-200">{t('common.active')}</Badge> : <Badge className="bg-zinc-100 text-zinc-600 ring-zinc-200">{t('common.inactive')}</Badge>}{m.role === 'agent' && !m.accepts_assignments ? <div className="text-[11px] text-warning">⏸</div> : null}</TD>
                  <TD className="tabular">{m.role === 'agent' ? `${p?.current_workload ?? 0} / ${m.max_active_orders}` : '—'}</TD>
                  <TD className="tabular">{p ? formatNumber(p.assigned, locale) : '—'}</TD>
                  <TD className="tabular">{p ? formatNumber(p.confirmed, locale) : '—'}</TD>
                  <TD className="tabular">{p ? formatNumber(p.cancelled, locale) : '—'}</TD>
                  <TD className="tabular">{p ? formatNumber(p.no_answer, locale) : '—'}</TD>
                  <TD className="tabular">{p ? formatPercent(p.confirmation_rate, locale) : '—'}</TD>
                  <TD className="tabular">{p?.avg_minutes_to_confirm != null ? `${formatNumber(p.avg_minutes_to_confirm, locale, 0)} min` : '—'}</TD>
                  <TD>{canEdit && m.id !== session.userId ? <EditMemberDialog isOwner={isOwner} member={{ ...m, permissions: (m.permissions ?? []) as string[] }} /> : null}</TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('team.permissions')}</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">{t('team.sensitiveHint')}</CardContent>
      </Card>
    </div>
  );
}
