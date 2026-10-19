'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

import { client } from '@/lib/anonymous-client';

/**
 * Client-side providers and the application's single boot point.
 *
 * Server state that the server owns (the block list, a User ID lookup, settings) is
 * cached by TanStack Query; the live conversation is not — Socket.IO pushes it, so
 * caching it would only create a second source of truth.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The API returns precise errors, so retrying silently would only delay
            // showing the user what actually went wrong.
            retry: false,
            refetchOnWindowFocus: false,
            staleTime: 30_000,
          },
        },
      }),
  );

  useEffect(() => {
    // Booting only makes sense in a browser: the anonymous identity is an `HttpOnly`
    // cookie, which requires a real request to be created or read.
    void client.boot();
  }, []);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
