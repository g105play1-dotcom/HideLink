'use client';

import { Mic, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { MEDIA_VOICE_MAX_DURATION_MS } from '@anonlink/shared';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { formatDuration } from '@/lib/format';

type RecorderPhase = 'idle' | 'requesting' | 'recording';

/**
 * Records one voice message.
 *
 * The microphone stream is opened only when the button is pressed and is always closed
 * when the recording ends, is cancelled, or the component unmounts — a live microphone
 * left behind by a closed chat is both a privacy problem and a visible OS indicator the
 * user cannot get rid of.
 *
 * The browser knows how long it recorded, so the duration is sent with the upload and
 * the receiving side can show the length before the audio is fetched. The cap is
 * enforced here (and again by the API) because a recording that exceeds it would be
 * rejected only after a long upload.
 */
export function VoiceRecorder({
  disabled,
  onRecorded,
  onError,
}: {
  disabled: boolean;
  onRecorded: (blob: Blob, durationMs: number) => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);

  const release = useCallback((): void => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }, []);

  useEffect(() => {
    // The cleanup closes the stream directly; it must not touch React state, which is
    // what happens if a recorder that is still running is stopped from here.
    return () => {
      cancelledRef.current = true;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      release();
    };
  }, [release]);

  async function start(): Promise<void> {
    if (disabled || phase !== 'idle') return;

    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      onError(t('Запись голоса не поддерживается этим браузером.'));
      return;
    }

    setPhase('requesting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPhase('idle');
      onError(
        t('Нет доступа к микрофону. Разрешите запись в настройках браузера и попробуйте снова.'),
      );
      return;
    }

    // The user may have left the chat while the permission prompt was open.
    if (cancelledRef.current) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      for (const track of stream.getTracks()) track.stop();
      setPhase('idle');
      onError(t('Не удалось начать запись. Попробуйте ещё раз.'));
      return;
    }

    streamRef.current = stream;
    recorderRef.current = recorder;
    chunksRef.current = [];
    cancelledRef.current = false;
    startedAtRef.current = Date.now();
    setElapsedMs(0);

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    });

    recorder.addEventListener('stop', () => {
      const durationMs = Math.max(
        1,
        Math.min(Date.now() - startedAtRef.current, MEDIA_VOICE_MAX_DURATION_MS),
      );
      const chunks = chunksRef.current;
      chunksRef.current = [];
      recorderRef.current = null;
      release();
      setPhase('idle');
      setElapsedMs(0);

      if (cancelledRef.current) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      if (blob.size === 0) {
        onError(t('Запись получилась пустой. Попробуйте ещё раз.'));
        return;
      }
      onRecorded(blob, durationMs);
    });

    recorder.start();
    setPhase('recording');

    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      // Stopping from the interval rather than a second timeout keeps one source of
      // truth for the length that is displayed and the length that is sent.
      if (elapsed >= MEDIA_VOICE_MAX_DURATION_MS && recorder.state !== 'inactive') {
        recorder.stop();
      }
    }, 200);
  }

  function stop(): void {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function cancel(): void {
    cancelledRef.current = true;
    stop();
  }

  if (phase === 'idle') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-10 shrink-0"
        disabled={disabled}
        onClick={() => void start()}
        aria-label={t('Записать голосовое сообщение')}
        title={t('Записать голосовое сообщение')}
      >
        <Mic className="size-4" aria-hidden="true" />
      </Button>
    );
  }

  if (phase === 'requesting') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-10 shrink-0"
        disabled
        aria-label={t('Запрос доступа к микрофону…')}
      >
        <Mic className="size-4 animate-pulse" aria-hidden="true" />
      </Button>
    );
  }

  return (
    <div
      className="flex h-10 shrink-0 items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2"
      role="status"
      aria-live="polite"
    >
      <span className="size-2 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
      <span className="font-mono text-xs tabular-nums">{formatDuration(elapsedMs)}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={stop}
        aria-label={t('Остановить запись и отправить')}
        title={t('Остановить запись и отправить')}
      >
        <Square className="size-3.5 fill-current" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={cancel}
        aria-label={t('Отменить запись')}
        title={t('Отменить запись')}
      >
        <X className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}

/**
 * Picks a container the browser can actually record and the API can sniff.
 *
 * WebM/Opus is the default everywhere it exists; Safari records MP4/AAC. Returning an
 * empty string lets `MediaRecorder` choose, and the resulting blob's own `type` is then
 * sent, so the declared content type still matches the bytes.
 */
function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) ?? '';
}
