'use client';

import { RefreshCw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Route-level error boundary.
 *
 * Without this, a rendering bug would leave the user on a blank page with no way
 * forward. It deliberately shows nothing about the error itself: the details belong in
 * the browser console, not in the interface.
 */
export default function ErrorBoundary({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl items-center p-4 sm:p-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TriangleAlert className="size-4 text-destructive" aria-hidden="true" />
            Интерфейс дал сбой
          </CardTitle>
          <CardDescription>
            Это ошибка на нашей стороне. Ваш User ID и текущие чаты не потеряны.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={reset}>
            <RefreshCw className="size-4" aria-hidden="true" />
            Попробовать снова
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
