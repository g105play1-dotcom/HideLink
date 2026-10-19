'use client';

import { LoaderCircle, TriangleAlert, Wifi, WifiOff } from 'lucide-react';
import type { ComponentType } from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useAppStore, type ConnectionStatus } from '@/store/app-store';

interface Presentation {
  label: string;
  variant: 'default' | 'success' | 'warning' | 'destructive';
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  spinning: boolean;
}

const PRESENTATION: Record<ConnectionStatus, Presentation> = {
  booting: { label: 'Запуск…', variant: 'default', icon: LoaderCircle, spinning: true },
  connecting: { label: 'Подключение…', variant: 'default', icon: LoaderCircle, spinning: true },
  connected: { label: 'На связи', variant: 'success', icon: Wifi, spinning: false },
  reconnecting: {
    label: 'Переподключение…',
    variant: 'warning',
    icon: LoaderCircle,
    spinning: true,
  },
  offline: { label: 'Нет связи', variant: 'destructive', icon: WifiOff, spinning: false },
  rejected: {
    label: 'Доступ закрыт',
    variant: 'destructive',
    icon: TriangleAlert,
    spinning: false,
  },
};

/**
 * Live connection state.
 *
 * Announced through `aria-live` because a dropped connection silently swallowing
 * messages is exactly the kind of failure that must not be visual-only.
 */
export function ConnectionBadge({ className }: { className?: string }) {
  const connection = useAppStore((state) => state.connection);
  const presentation = PRESENTATION[connection];
  const Icon = presentation.icon;

  return (
    <Badge
      variant={presentation.variant}
      role="status"
      aria-live="polite"
      className={cn('shrink-0', className)}
    >
      <Icon
        className={cn('size-3.5', presentation.spinning && 'animate-spin')}
        aria-hidden="true"
      />
      {presentation.label}
    </Badge>
  );
}
