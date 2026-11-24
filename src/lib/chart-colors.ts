/** Shared chart palette (usable from server and client components). */
const PALETTE = ['hsl(158 64% 36%)', 'hsl(217 80% 55%)', 'hsl(0 72% 55%)', 'hsl(38 92% 50%)', 'hsl(270 60% 55%)'];
export const chartColor = (i: number) => PALETTE[i % PALETTE.length]!;
