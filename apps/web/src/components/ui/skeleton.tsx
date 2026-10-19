import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

/**
 * Loading placeholder.
 *
 * `aria-hidden` because a skeleton conveys nothing to a screen reader — the region it
 * stands in for carries the `aria-busy`/label instead.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}
