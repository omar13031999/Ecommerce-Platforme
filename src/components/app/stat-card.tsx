import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function StatCard({
  label, value, hint, icon, href, tone = 'default',
}: {
  label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; href?: string;
  tone?: 'default' | 'positive' | 'negative' | 'warning' | 'muted';
}) {
  const body = (
    <div className={cn('flex h-full flex-col gap-1 rounded-lg border bg-card p-4 shadow-sm transition-colors', href && 'hover:border-primary/40 hover:bg-accent/30')}>
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>{label}</span>
        {icon ? <span className="text-muted-foreground/70 [&_svg]:size-4">{icon}</span> : null}
      </div>
      <div
        className={cn(
          'tabular text-2xl font-semibold',
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
