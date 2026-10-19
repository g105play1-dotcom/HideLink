'use client';

import { Input } from '@/components/ui/input';

/**
 * A text field with suggestions, but no restrictions.
 *
 * Implemented with the platform's `<datalist>` rather than a hand-written popover: it is
 * keyboard- and screen-reader-friendly in every browser, needs no state, no outside-click
 * handling and no dependency (the project pins its dependencies deliberately), and it
 * cannot change what the field accepts — which matters here, because the product treats a
 * place as free text the two users have to spell the same way, not as a value from a
 * vocabulary (`normalizePlace` in `@anonlink/shared`).
 *
 * The same component serves the city and the region fields; the only difference is the
 * list.
 */
export function Combobox({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
  maxLength,
  disabled,
  'aria-invalid': ariaInvalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  placeholder?: string;
  hint?: string;
  maxLength?: number;
  disabled?: boolean;
  'aria-invalid'?: boolean;
}) {
  const listId = `${id}-suggestions`;

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>

      <Input
        id={id}
        list={listId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...(placeholder ? { placeholder } : {})}
        maxLength={maxLength}
        disabled={disabled}
        aria-invalid={ariaInvalid}
        autoComplete="off"
      />

      <datalist id={listId}>
        {options.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>

      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
