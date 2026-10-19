'use client';

import { Moon, Sun } from 'lucide-react';

import { useTheme } from '@/lib/theme';

/**
 * The light/dark switch.
 *
 * A single button rather than a three-way control: "follow the system" is the *initial*
 * state, not something most people want to go back to, and a third position would cost a
 * menu for a choice almost nobody revisits. The resolved state is announced in the label,
 * so it is clear what pressing it will do.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const dark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-label={dark ? 'Включить светлую тему' : 'Включить тёмную тему'}
      title={dark ? 'Светлая тема' : 'Тёмная тема'}
      className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {dark ? (
        <Sun className="size-4" aria-hidden="true" />
      ) : (
        <Moon className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}
