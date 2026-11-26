import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function StatCard({
  label, value, hint, icon, href, tone = 'default',
}: {
  label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; href?: string;
  tone?: 'default' | 'positive' | 'negative' | 'warning' | 'muted';
}) {
  const chip = {
    default: 'bg-primary/10 text-primary',
    positive: 'bg-success/10 text-success',
    negative: 'bg-destructive/10 text-destructive',
    warning: 'bg-warning/15 text-warning',
    muted: 'bg-muted text-muted-foreground',
  }[tone];
  const body = (
    <div className={cn(
      'group flex h-full flex-col gap-2 rounded-xl border border-border/70 bg-card p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_16px_-6px_rgb(0_0_0/0.06)] transition-all',
      href && 'hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_10px_30px_-12px_hsl(var(--primary)/0.35)]',
    )}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        {icon ? <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4', chip)}>{icon}</span> : null}
      </div>
      <div
        className={cn(
          'tabular text-[1.7rem] font-bold leading-none tracking-tight',
          tone === 'positive' && 'text-success',
          tone === 'negative' && 'text-destructive',
          tone === 'warning' && 'text-warning',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {value}
      </div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}
