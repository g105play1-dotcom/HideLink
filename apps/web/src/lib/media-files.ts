import { MEDIA_MAX_BYTES, type ChatMediaKind } from '@anonlink/shared';

/**
 * Browser-side preparation of attachments.
 *
 * Two things happen here that the API cannot do for the user:
 *  - a photo is re-encoded before upload, which bounds its size and strips EXIF
 *    (including GPS coordinates) that a phone camera writes into a JPEG;
 *  - a voice recording is produced by `MediaRecorder`, so the browser has to own the
 *    microphone lifecycle.
 *
 * None of this is a security boundary: the API sniffs every file again and enforces its
 * own limits. This is about not spending a mobile user's upload budget on a 12 MP photo
 * that is going to be displayed at 400 px.
 */

/** Longest edge kept when re-encoding a photo. Enough for a phone screen at 2×. */
const IMAGE_MAX_EDGE = 1600;

/** Quality for the re-encoded photo. Visually indistinguishable at chat size. */
const IMAGE_QUALITY = 0.85;

let webpSupported: boolean | null = null;

/** Whether this browser can encode WebP from a canvas. Cached: it never changes. */
function canEncodeWebp(): boolean {
  if (webpSupported !== null) return webpSupported;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    webpSupported = canvas.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    webpSupported = false;
  }
  return webpSupported;
}

/**
 * Re-encodes a picked photo, or returns it unchanged when that is the better answer.
 *
 * GIFs are deliberately passed through: drawing one frame to a canvas would silently turn
 * an animation into a still image. They are still capped by the size limit, so an
 * oversized GIF is rejected rather than degraded.
 */
export async function prepareImageFile(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // The browser could not decode it. Let the upload fail with the server's answer
    // rather than replacing a real error with a guess.
    return file;
  }

  try {
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) return file;

    const useWebp = canEncodeWebp();
    if (!useWebp) {
      // JPEG has no alpha channel. Without an explicit background, transparent pixels
      // are composited onto black and a logo turns into a black square.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }

    context.drawImage(bitmap, 0, 0, width, height);

    const encoded = await toBlob(canvas, useWebp ? 'image/webp' : 'image/jpeg', IMAGE_QUALITY);
    // A re-encode that somehow grew the file (already heavily compressed) is discarded:
    // the original is both smaller and lossless, so there is nothing to gain.
    if (!encoded || encoded.size >= file.size) return file;
    return encoded;
  } finally {
    bitmap.close();
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Whether a file is within the per-kind ceiling. */
export function fitsMediaLimit(kind: ChatMediaKind, size: number): boolean {
  return size <= MEDIA_MAX_BYTES[kind];
}

/**
 * Reads the duration of an audio blob, in milliseconds.
 *
 * Returns `null` when the browser cannot tell (some containers report `Infinity` until
 * they are fully buffered). An unknown duration is not a reason to block the upload: the
 * server treats it as optional, and the receiver's player shows the real length.
 */
export function readAudioDuration(blob: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';

    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };

    audio.addEventListener('loadedmetadata', () => {
      finish(
        Number.isFinite(audio.duration) && audio.duration > 0
          ? Math.round(audio.duration * 1000)
          : null,
      );
    });
    audio.addEventListener('error', () => finish(null));

    // A corrupt file must not leave the composer waiting forever.
    setTimeout(() => finish(null), 5_000);
    audio.src = url;
  });
}
