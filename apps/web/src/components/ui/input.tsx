import type { ComponentPropsWithRef } from 'react';

import { cn } from '@/lib/utils';

export function Input({ className, ...props }: ComponentPropsWithRef<'input'>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground',
        'placeholder:text-muted-foreground disabled:opacity-50',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
