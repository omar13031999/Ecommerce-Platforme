'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';

export function Providers({ children, dir }: { children: ReactNode; dir: 'ltr' | 'rtl' }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } }));
  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster richColors position={dir === 'rtl' ? 'top-left' : 'top-right'} dir={dir} />
    </QueryClientProvider>
  );
}
