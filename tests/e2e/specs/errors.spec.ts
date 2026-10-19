import { expect, test } from '@playwright/test';

import { expectNoClientErrors, lookupUser, newIdentity } from '../support/app';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A syntactically valid User ID that nobody holds. */
function randomPublicId(): string {
  let suffix = '';
  for (let index = 0; index < 12; index += 1) {
    suffix += CROCKFORD[Math.floor(Math.random() * CROCKFORD.length)];
  }
  return `AL${suffix}`;
}

test.describe('input and failure states', () => {
  test('a malformed User ID is rejected locally, before the server is asked', async ({
    browser,
  }) => {
    const alice = await newIdentity(browser);

    await lookupUser(alice.page, 'привет');

    await expect(
      alice.page.getByText('Неверный формат. User ID состоит из 14 символов и начинается с AL.'),
    ).toBeVisible();
    await expect(
      alice.page.getByRole('button', { name: 'Отправить заявку', exact: true }),
    ).toHaveCount(0);
    await expect(
      alice.page.getByText('Пользователь с таким ID не найден. Проверьте, нет ли опечатки.'),
    ).toHaveCount(0);

    expectNoClientErrors(alice);
  });

  test('a valid but unknown User ID is reported as not found', async ({ browser }) => {
    const alice = await newIdentity(browser);

    await lookupUser(alice.page, randomPublicId());

    await expect(
      alice.page.getByText('Пользователь с таким ID не найден. Проверьте, нет ли опечатки.'),
    ).toBeVisible();
    await expect(
      alice.page.getByRole('button', { name: 'Отправить заявку', exact: true }),
    ).toHaveCount(0);

    expectNoClientErrors(alice);
  });

  test('a second lookup replaces the first answer instead of stacking on it', async ({
    browser,
  }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);

    await lookupUser(alice.page, randomPublicId());
    await expect(
      alice.page.getByText('Пользователь с таким ID не найден. Проверьте, нет ли опечатки.'),
    ).toBeVisible();

    // A stale verdict left next to a new ID would be actively misleading.
    await lookupUser(alice.page, bob.publicId);
    await expect(alice.page.getByText('Пользователь найден и принимает заявки.')).toBeVisible();
    await expect(
      alice.page.getByText('Пользователь с таким ID не найден. Проверьте, нет ли опечатки.'),
    ).toHaveCount(0);

    expectNoClientErrors(alice);
    expectNoClientErrors(bob);
  });
});
