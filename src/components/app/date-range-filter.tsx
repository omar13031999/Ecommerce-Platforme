'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Input, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { RANGE_PRESETS, type DateRange } from '@/lib/dates';

export function DateRangeFilter({ range }: { range: DateRange }) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);

  function push(next: Record<string, string | null>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) (v === null ? sp.delete(k) : sp.set(k, v));
    sp.delete('page');
    router.push(`${pathname}?${sp.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label={t('common.period')}
        className="w-44"
        value={range.preset}
        onChange={(e) => (e.target.value === 'custom' ? push({ range: 'custom', from, to }) : push({ range: e.target.value, from: null, to: null }))}
      >
        {RANGE_PRESETS.map((p) => (
          <option key={p} value={p}>{t(`range.${p}`)}</option>
        ))}
      </Select>
      {range.preset === 'custom' ? (
        <>
          <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t('common.from')} />
          <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t('common.to')} />
          <Button size="sm" variant="outline" onClick={() => push({ range: 'custom', from, to })}>{t('common.apply')}</Button>
        </>
      ) : null}
    </div>
  );
}
