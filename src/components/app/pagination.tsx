import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function Pagination({ page, pageSize, total, searchParams }: { page: number; pageSize: number; total: number; searchParams: Record<string, string | undefined> }) {
  const t = useTranslations('common');
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => {
    const sp = new URLSearchParams(Object.entries(searchParams).filter(([, v]) => v !== undefined) as [string, string][]);
    sp.set('page', String(p));
    return `?${sp.toString()}`;
  };
  return (
    <div className="flex items-center justify-between gap-2 px-1 py-3 text-sm text-muted-foreground">
      <span className="tabular">{t('total')}: {total}</span>
      <div className="flex items-center gap-2">
        <Link aria-disabled={page <= 1} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), page <= 1 && 'pointer-events-none opacity-50')} href={href(page - 1)}>
          <ChevronLeft className="rtl:rotate-180" />{t('previous')}
        </Link>
        <span className="tabular">{t('pageOf', { page, pages })}</span>
        <Link aria-disabled={page >= pages} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), page >= pages && 'pointer-events-none opacity-50')} href={href(page + 1)}>
          {t('next')}<ChevronRight className="rtl:rotate-180" />
        </Link>
      </div>
    </div>
  );
}
