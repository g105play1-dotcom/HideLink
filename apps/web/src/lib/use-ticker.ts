'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * A single, shared wall clock for countdowns.
 *
 * Three panels need "now": the waiting timer, the outgoing-request countdown and the
 * incoming-request expiry. Each of them used to run its own `setInterval` that wrote
 * into React state, which meant one interval per component and a cascading render on
 * activation — React 19 flags that, correctly: the value is already current on the
 * render that sets the interval up.
 *
 * Here the clock lives *outside* React, as the external system it actually is, and
 * components subscribe to it with `useSyncExternalStore`. That gives three properties
 * worth having:
 *  - `Date.now()` is never called during render, so render stays pure (the React
 *    compiler enforces this, and it is right to);
 *  - there is one timer for the whole page instead of one per countdown;
 *  - the timer stops when nothing is listening, so an idle tab does no work.
 *
 * A subscriber may see a value up to one interval old; React re-reads the snapshot
 * immediately after subscribing, so an activating panel does not display a stale time.
 */

const INTERVAL_MS = 1_000;

let currentNow = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function stop(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  if (timer === null) {
    // Coming back from idle: start from a fresh reading rather than a frozen one.
    currentNow = Date.now();
    timer = setInterval(() => {
      currentNow = Date.now();
      // Copied first: a listener may unsubscribe while being notified.
      for (const current of [...listeners]) current();
    }, INTERVAL_MS);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

function getSnapshot(): number {
  return currentNow;
}

/** The current time, re-read once per second while `active`. */
export function useTicker(active: boolean): number {
  const subscribeIfActive = useCallback(
    (listener: () => void) => (active ? subscribe(listener) : () => {}),
    [active],
  );

  return useSyncExternalStore(subscribeIfActive, getSnapshot, getSnapshot);
}
