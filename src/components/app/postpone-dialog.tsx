'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useAction } from '@/components/app/use-action';
import { postponeOrder } from '@/lib/actions/orders';

/** "YYYY-MM-DDTHH:mm" in the browser's local time (what <input type="datetime-local"> expects). */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function at(daysFromToday: number, hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** Postpone an order: the customer asked to be called back later; a notification fires when it is due. */
export function PostponeDialog({ orderId, version, beforeChange, size = 'default', iconOnly = false }: {
  orderId: string; version: number;
  /** Saves pending edits first; returns the new version, or null to abort. */
  beforeChange?: () => Promise<number | null>;
  size?: 'default' | 'sm' | 'icon'; iconOnly?: boolean;
}) {
  const t = useTranslations('orders');
  const { run, pending } = useAction();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() => toLocalInput(new Date(Date.now() + 2 * 3600_000)));
  const [note, setNote] = useState('');
  const presets: { label: string; date: () => Date }[] = [
    { label: t('postponeIn1h'), date: () => new Date(Date.now() + 3600_000) },
    { label: t('postponeTonight'), date: () => at(0, 18) },
    { label: t('postponeTomorrow'), date: () => at(1, 10) },
    { label: t('postponeIn2Days'), date: () => at(2, 10) },
  ];

  async function submit() {
    let v = version;
    if (beforeChange) {
      const saved = await beforeChange();
      if (saved === null) return;
      v = saved;
    }
    const until = new Date(value);
    run(() => postponeOrder({ orderId, until: until.toISOString(), note, version: v }), {
      success: t('postponedUntil', { date: until.toLocaleString() }),
      onSuccess: () => { setOpen(false); setNote(''); },
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size={iconOnly ? 'icon' : size} className={iconOnly ? 'size-8 shrink-0' : undefined} title={t('postpone')} aria-label={t('postpone')}>
          <CalendarClock />{iconOnly ? null : t('postpone')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('postpone')}</DialogTitle><DialogDescription>{t('postponeHelp')}</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => <Button key={p.label} type="button" size="sm" variant="secondary" onClick={() => setValue(toLocalInput(p.date()))}>{p.label}</Button>)}
          </div>
          <div className="grid gap-1.5"><Label>{t('postponeAt')}</Label>
            <Input type="datetime-local" dir="ltr" value={value} min={toLocalInput(new Date())} onChange={(e) => setValue(e.target.value)} /></div>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('statusNote')} maxLength={4000} />
        </div>
        <DialogFooter>
          <Button disabled={pending || !value} onClick={() => void submit()}><CalendarClock />{t('postpone')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
