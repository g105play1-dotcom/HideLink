import type { ComponentPropsWithRef } from 'react';

import { cn } from '@/lib/utils';

/**
 * `ComponentPropsWithRef` rather than `TextareaHTMLAttributes`: React 19 forwards
 * `ref` as an ordinary prop, and the chat composer needs to focus the textarea after
 * sending.
 */
export function Textarea({ className, ...props }: ComponentPropsWithRef<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full resize-none rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground',
        'placeholder:text-muted-foreground disabled:opacity-50',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
