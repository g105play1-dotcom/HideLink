import { deflateSync } from 'node:zlib';

import { expect, test } from '@playwright/test';

import {
  expectNoClientErrors,
  matchPair,
  newIdentity,
  transcript,
  type Identity,
} from '../support/app';

/**
 * Photos, audio files and voice messages in a real conversation.
 *
 * The assertions are about what each side can see and play: a photo appears once the
 * bytes arrive, an audio file gets a working player, and a recorded voice message does
 * the same. Nothing here reads the upload id or the API — those are covered by the
 * integration suite; this is the interface's half of the contract.
 */

/** CRC-32, required by PNG chunks. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

/** A real 2×2 PNG, so the browser can decode and re-encode it. */
function tinyPng(): Buffer {
  const width = 2;
  const height = 2;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 4;
      raw[pixel] = 220;
      raw[pixel + 1] = 60;
      raw[pixel + 2] = 60;
      raw[pixel + 3] = 255;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A 0.2-second silent WAV that every browser can decode. */
function tinyWav(): Buffer {
  const sampleRate = 8_000;
  const samples = 1_600;
  const data = Buffer.alloc(samples * 2);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

async function chooseFile(
  page: Identity['page'],
  buttonName: string,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  (await chooser).setFiles(file);
}

test.describe('chat attachments', () => {
  test('a photo, an audio file and a voice message reach the peer', async ({ browser }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);
    await matchPair(alice, bob);

    // --- photo with a caption -------------------------------------------------
    await alice.page.getByLabel('Сообщение', { exact: true }).fill('смотри');
    await chooseFile(alice.page, 'Прикрепить фото', {
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: tinyPng(),
    });

    const aliceImage = transcript(alice.page).getByRole('img', { name: 'Изображение' });
    const bobImage = transcript(bob.page).getByRole('img', { name: 'Изображение' });
    await expect(aliceImage).toBeVisible();
    await expect(bobImage).toBeVisible();

    // The bytes are fetched through the session and turned into a tab-local object URL:
    // there is no shareable address to copy out of the page.
    await expect(bobImage).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => bobImage.evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);

    await expect(transcript(bob.page)).toContainText('смотри');

    // The caption consumed the draft; the photo did not leave the text behind.
    await expect(alice.page.getByLabel('Сообщение', { exact: true })).toHaveValue('');

    // --- audio file -----------------------------------------------------------
    await chooseFile(alice.page, 'Прикрепить аудиофайл', {
      name: 'sound.wav',
      mimeType: 'audio/wav',
      buffer: tinyWav(),
    });

    await expect(transcript(alice.page).getByLabel('Аудиофайл')).toBeVisible();
    const bobAudio = transcript(bob.page).getByLabel('Аудиофайл');
    await expect(bobAudio).toBeVisible();
    await expect(bobAudio).toHaveAttribute('src', /^blob:/);

    // --- voice message --------------------------------------------------------
    await alice.context.grantPermissions(['microphone']);
    await alice.page.getByRole('button', { name: 'Записать голосовое сообщение' }).click();
    const stop = alice.page.getByRole('button', { name: 'Остановить запись и отправить' });
    await expect(stop).toBeVisible();
    // Let the fake device produce a few chunks before stopping.
    await alice.page.waitForTimeout(700);
    await stop.click();

    const bobVoice = transcript(bob.page).getByLabel('Голосовое сообщение');
    await expect(bobVoice).toBeVisible({ timeout: 20_000 });
    await expect(bobVoice).toHaveAttribute('src', /^blob:/);

    expectNoClientErrors(alice);
    expectNoClientErrors(bob);
  });

  test('a file that is not an image is rejected before upload', async ({ browser }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);
    await matchPair(alice, bob);

    // The picker filters by type, but a file manager can still hand over something the
    // server will not accept. The server's answer has to be shown, not swallowed.
    await chooseFile(alice.page, 'Прикрепить фото', {
      name: 'fake.png',
      mimeType: 'image/png',
      buffer: Buffer.from('<html>not an image</html>'),
    });

    await expect(alice.page.getByRole('alert').filter({ hasText: 'формат' })).toBeVisible();
    await expect(transcript(bob.page).getByRole('img', { name: 'Изображение' })).toHaveCount(0);

    expectNoClientErrors(alice);
    expectNoClientErrors(bob);
  });
});
