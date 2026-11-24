'use client';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useLocale } from 'next-intl';

type Series = { key: string; label: string; color: string };

const PALETTE = ['hsl(158 64% 36%)', 'hsl(217 80% 55%)', 'hsl(0 72% 55%)', 'hsl(38 92% 50%)', 'hsl(270 60% 55%)'];
export const chartColor = (i: number) => PALETTE[i % PALETTE.length]!;

function shortDate(d: string, locale: string) {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-DZ-u-nu-latn' : 'fr-DZ', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
}

export function TrendChart({ data, series, kind = 'area', height = 260 }: { data: Record<string, number | string>[]; series: Series[]; kind?: 'area' | 'bar'; height?: number }) {
  const locale = useLocale();
  const rtl = locale === 'ar';
  const fmt = new Intl.NumberFormat(rtl ? 'ar-DZ-u-nu-latn' : 'fr-DZ', { notation: 'compact' });
  const common = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
      <XAxis dataKey="day" tickFormatter={(d: string) => shortDate(d, locale)} reversed={rtl} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
      <YAxis orientation={rtl ? 'right' : 'left'} tickFormatter={(v: number) => fmt.format(v)} tick={{ fontSize: 11 }} width={48} stroke="hsl(var(--muted-foreground))" />
      <Tooltip
        labelFormatter={(d) => shortDate(String(d), locale)}
        contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
      />
      <Legend wrapperStyle={{ fontSize: 12 }} />
    </>
  );
  return (
    <div style={{ height }} dir="ltr">
      <ResponsiveContainer width="100%" height="100%">
        {kind === 'area' ? (
          <AreaChart data={data}>
            {common}
            {series.map((s) => (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} fill={s.color} fillOpacity={0.12} strokeWidth={2} />
            ))}
          </AreaChart>
        ) : (
          <BarChart data={data}>
            {common}
            {series.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[3, 3, 0, 0]} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
