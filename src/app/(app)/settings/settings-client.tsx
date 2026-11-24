'use client';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAction } from '@/components/app/use-action';
import { saveSetting, type SettingKey } from '@/lib/actions/settings';
import { CONFIRMATION_STATUSES } from '@/lib/domain/statuses';

type V = Record<string, Record<string, unknown>>;

function Section({ title, description, children, onSave, pending }: { title: string; description?: string; children: ReactNode; onSave: () => void; pending: boolean }) {
  const t = useTranslations('common');
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle>{description ? <CardDescription>{description}</CardDescription> : null}</CardHeader>
      <CardContent className="grid gap-4">
        {children}
        <div><Button onClick={onSave} disabled={pending}>{t('save')}</Button></div>
      </CardContent>
    </Card>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="flex items-center gap-2 text-sm"><Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
}

export function SettingsForms({ values, providers }: { values: V; providers: { id: string; name: string }[] }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [a, setA] = useState(values.assignment as { auto_assign_enabled: boolean; workload_statuses: string[]; redistribution_enabled: boolean; redistribution_threshold: number; max_redistributions: number; final_no_answer_status: string; final_action: string });
  const [d, setD] = useState(values.delivery as { auto_submit_enabled: boolean; default_provider_id: string | null });
  const [o, setO] = useState(values.operational_costs as Record<'confirmation_cost' | 'packaging_cost' | 'storage_cost' | 'other_cost', number>);
  const [f, setF] = useState(values.finance as { include_customer_delivery_fee_in_revenue: boolean; product_recovered_on_return: boolean });
  const [ad, setAd] = useState(values.ads_allocation as { use_attribution: boolean; fallback_method: string });
  const save = (key: SettingKey, value: unknown) => run(() => saveSetting(key, value), { success: t('common.saved') });

  return (
    <div className="grid gap-5">
      <Section title={t('settings.assignment')} onSave={() => save('assignment', a)} pending={pending}>
        <Toggle label={t('settings.autoAssign')} checked={a.auto_assign_enabled} onChange={(v) => setA({ ...a, auto_assign_enabled: v })} />
        <div className="grid gap-1.5">
          <Label>{t('settings.workloadStatuses')}</Label>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
            {CONFIRMATION_STATUSES.map((s) => (
              <Toggle key={s} label={t(`confirmation.${s}`)} checked={a.workload_statuses.includes(s)}
                onChange={(v) => setA({ ...a, workload_statuses: v ? [...a.workload_statuses, s] : a.workload_statuses.filter((x) => x !== s) })} />
            ))}
          </div>
        </div>
        <div className="grid gap-3 rounded-md border p-3">
          <Toggle label={t('settings.redistribution')} checked={a.redistribution_enabled} onChange={(v) => setA({ ...a, redistribution_enabled: v })} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>{t('settings.threshold')}</Label>
              <Select value={a.redistribution_threshold} onChange={(e) => setA({ ...a, redistribution_threshold: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{t(`confirmation.no_answer_${n}` as 'confirmation.no_answer_1')}</option>)}
              </Select>
              <p className="text-xs text-muted-foreground">{t('settings.thresholdHelp')}</p>
            </div>
            <div className="grid gap-1.5"><Label>{t('settings.maxRedistributions')}</Label><Input type="number" min={0} max={20} value={a.max_redistributions} onChange={(e) => setA({ ...a, max_redistributions: Number(e.target.value) })} /></div>
            <div className="grid gap-1.5">
              <Label>{t('settings.finalStatus')}</Label>
              <Select value={a.final_no_answer_status} onChange={(e) => setA({ ...a, final_no_answer_status: e.target.value })}>
                {[3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={`no_answer_${n}`}>{t(`confirmation.no_answer_${n}` as 'confirmation.no_answer_9')}</option>)}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>{t('settings.finalAction')}</Label>
              <Select value={a.final_action} onChange={(e) => setA({ ...a, final_action: e.target.value })}>
                <option value="review">{t('settings.finalReview')}</option><option value="cancel">{t('settings.finalCancel')}</option>
              </Select>
            </div>
          </div>
        </div>
      </Section>

      <Section title={t('settings.deliverySettings')} onSave={() => save('delivery', d)} pending={pending}>
        <div className="grid gap-1.5 sm:max-w-sm">
          <Label>{t('settings.defaultProvider')}</Label>
          <Select value={d.default_provider_id ?? ''} onChange={(e) => setD({ ...d, default_provider_id: e.target.value || null })}>
            <option value="">—</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        <Toggle label={t('settings.autoSubmit')} checked={d.auto_submit_enabled} onChange={(v) => setD({ ...d, auto_submit_enabled: v })} />
      </Section>

      <Section title={t('settings.operationalCosts')} onSave={() => save('operational_costs', o)} pending={pending}>
        <div className="grid gap-3 sm:grid-cols-4">
          {(['confirmation_cost', 'packaging_cost', 'storage_cost', 'other_cost'] as const).map((k) => (
            <div key={k} className="grid gap-1.5">
              <Label>{t(`settings.${k === 'confirmation_cost' ? 'confirmationCost' : k === 'packaging_cost' ? 'packagingCost' : k === 'storage_cost' ? 'storageCost' : 'otherCost'}`)}</Label>
              <Input type="number" min={0} value={o[k]} onChange={(e) => setO({ ...o, [k]: Number(e.target.value) })} />
            </div>
          ))}
        </div>
      </Section>

      <Section title={t('settings.financeSettings')} description={t('finance.formula')} onSave={() => save('finance', f)} pending={pending}>
        <Toggle label={t('settings.includeFee')} checked={f.include_customer_delivery_fee_in_revenue} onChange={(v) => setF({ ...f, include_customer_delivery_fee_in_revenue: v })} />
        <Toggle label={t('settings.productRecovered')} checked={f.product_recovered_on_return} onChange={(v) => setF({ ...f, product_recovered_on_return: v })} />
      </Section>

      <Section title={t('settings.adsAllocation')} description={t('analytics.allocationNote')} onSave={() => save('ads_allocation', ad)} pending={pending}>
        <Toggle label={t('settings.useAttribution')} checked={ad.use_attribution} onChange={(v) => setAd({ ...ad, use_attribution: v })} />
        <div className="grid gap-1.5 sm:max-w-sm">
          <Label>{t('settings.fallbackMethod')}</Label>
          <Select value={ad.fallback_method} onChange={(e) => setAd({ ...ad, fallback_method: e.target.value })}>
            {(['equal', 'distributed', 'revenue', 'manual'] as const).map((m) => <option key={m} value={m}>{t(`analytics.method_${m}`)}</option>)}
          </Select>
        </div>
      </Section>
    </div>
  );
}
