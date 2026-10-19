'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  /** Called when the user dismisses the dialog (Esc, backdrop, close button). */
  onClose?: () => void;
  /** Set to `false` for prompts that must be answered. */
  dismissible?: boolean;
  className?: string;
}

/**
 * Modal dialog built on the native `<dialog>` element.
 *
 * Using the platform element rather than a hand-written overlay is a real
 * accessibility win, not a shortcut: `showModal()` gives focus trapping, `Esc`
 * handling, inert background content and correct screen-reader semantics for free —
 * all things a bespoke `<div>` would have to reimplement and would probably get
 * subtly wrong.
 */
export function Dialog({
  open,
  title,
  description,
  children,
  onClose,
  dismissible = true,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const handleCancel = (event: Event) => {
      if (!dismissible) {
        event.preventDefault();
        return;
      }
      onClose?.();
    };

    element.addEventListener('cancel', handleCancel);
    return () => element.removeEventListener('cancel', handleCancel);
  }, [dismissible, onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      {...(description ? { 'aria-describedby': descriptionId } : {})}
      onClick={(event) => {
        // Clicks on the backdrop target the dialog element itself; clicks inside the
        // panel target a descendant.
        if (dismissible && event.target === ref.current) onClose?.();
      }}
      className={cn(
        'm-auto w-[calc(100%-2rem)] max-w-md rounded-card border border-border bg-card p-0',
        'text-card-foreground shadow-xl backdrop:bg-black/55',
        className,
      )}
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {children}
      </div>
    </dialog>
  );
}
