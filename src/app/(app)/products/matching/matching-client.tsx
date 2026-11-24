'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { useAction } from '@/components/app/use-action';
import { deleteAlias, matchLabel } from '@/lib/actions/products';

export function MatchRow({ itemId, products }: { itemId: string; products: { id: string; name: string; sku: string | null }[] }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [pid, setPid] = useState('');
  return (
    <div className="flex gap-2">
      <Select className="h-8 w-64" value={pid} onChange={(e) => setPid(e.target.value)} aria-label={t('products.matchTo')}>
        <option value="">{t('orders.selectProduct')}</option>
        {products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ''}</option>)}
      </Select>
      <Button size="sm" disabled={!pid || pending} onClick={() => run(() => matchLabel({ itemId, productId: pid }), { success: t('common.saved') })}>{t('common.apply')}</Button>
    </div>
  );
}

export function AliasDelete({ id }: { id: string }) {
  const t = useTranslations('common');
  const { run, pending } = useAction();
  return <Button size="icon" variant="ghost" aria-label={t('delete')} disabled={pending} onClick={() => run(() => deleteAlias(id))}><Trash2 /></Button>;
}
