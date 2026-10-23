import { expect, test } from '@playwright/test';

import { expectMessage, newIdentity, sendMessage, startRandomSearch } from '../support/app';
import { openOwnerPage, resetOwnerDirectory, signIn } from '../support/owner';

/**
 * The owner's people directory and hidden join, driven through `/admin`.
 *
 * The integration suite proves the server rules; this spec proves the owner can actually
 * reach them: star a person, join a waiting search, send and receive text as an ordinary
 * peer, and end the chat. It also covers the reservation path, because "join a person who
 * is not searching" has no immediate chat to look at and is easy to render as a dead
 * button.
 *
 * Cleanup goes through the API (see `resetOwnerDirectory`) for the same reason the archive
 * suite does: a failed spec must not leave a reservation or hidden chat for the global
 * matchmaker and the next test.
 */
test.describe('the owner people directory', () => {
  test.afterEach(async () => {
    await resetOwnerDirectory();
  });

  test('stars a person, joins their search, talks as an ordinary peer and leaves', async ({
    browser,
  }) => {
    const owner = await openOwnerPage(browser);
    await signIn(owner.page);

    const target = await newIdentity(browser);

    const search = owner.page.getByLabel('Найти пользователя по User ID', { exact: true });
    await search.fill(target.publicId);

    const row = owner.page.getByRole('listitem').filter({ hasText: target.publicId }).first();
    await expect(row).toBeVisible();

    // The default identity has declared nothing and filters nobody: the directory must say
    // that plainly instead of rendering empty cards with no explanation.
    await expect(row.getByText('Профиль не заполнен.')).toBeVisible();
    await expect(row.getByText('Без фильтров.')).toBeVisible();

    await row.getByRole('button', { name: `В избранное ${target.publicId}`, exact: true }).click();
    await expect(row.getByText('Избранное', { exact: true })).toBeVisible();

    const favorites = owner.page.getByRole('list', { name: 'Избранные пользователи' });
    await expect(favorites.getByText(target.publicId)).toBeVisible();
    const favoriteRow = favorites.getByRole('listitem').filter({ hasText: target.publicId });
    await expect(
      favoriteRow.getByRole('button', { name: /Присоединиться|Буду первым при поиске/ }),
    ).toBeVisible();
    await expect(favoriteRow.getByLabel(`Причина бана ${target.publicId}`)).toBeVisible();

    // The target starts waiting first. The owner's row may still show the pre-search label
    // until the poll runs; the server decides, so either button must open the same chat.
    await startRandomSearch(target.page);

    await row.getByRole('button', { name: /Присоединиться|Буду первым при поиске/ }).click();

    // The target sees a normal random chat, never the owner or a User ID.
    await expect(target.page.locator('[data-chat-id]')).toBeVisible({ timeout: 20_000 });

    const composer = owner.page.getByLabel('Сообщение', { exact: true });
    await expect(composer).toBeVisible();
    await composer.fill('Привет из кабинета владельца');
    await owner.page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await expectMessage(target.page, 'Привет из кабинета владельца');

    await sendMessage(target.page, 'И тебе привет');
    await expect(owner.page.getByText('И тебе привет', { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    const ownerComposer = owner.page
      .locator('form')
      .filter({ has: owner.page.getByLabel('Сообщение', { exact: true }) });
    await ownerComposer.getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(target.page.getByText('Собеседник завершил чат.')).toBeVisible({
      timeout: 10_000,
    });
    await target.page.getByRole('button', { name: 'Готово', exact: true }).click();
    await expect(target.page.getByRole('button', { name: 'Найти собеседника' })).toBeVisible();

    // The separate favorites card has the same actions, including unstarring. Removing a
    // person there must remove the bookmark, not just hide the row until the next poll.
    await favoriteRow
      .getByRole('button', { name: `Убрать из избранного ${target.publicId}`, exact: true })
      .click();
    await expect(favorites.getByText(target.publicId)).toHaveCount(0);

    await owner.context.close();
    await target.context.close();
  });

  test('reserves an idle person, shows the promise, and becomes their first match', async ({
    browser,
  }) => {
    const owner = await openOwnerPage(browser);
    await signIn(owner.page);

    const target = await newIdentity(browser);

    await owner.page
      .getByLabel('Найти пользователя по User ID', { exact: true })
      .fill(target.publicId);

    const row = owner.page.getByRole('listitem').filter({ hasText: target.publicId }).first();
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: 'Буду первым при поиске', exact: true }).click();
    await expect(row.getByText('Ждёт поиска', { exact: true })).toBeVisible();

    const pending = owner.page.getByRole('list', { name: 'Ожидающие поиска' });
    await expect(pending.getByText(target.publicId)).toBeVisible();

    await startRandomSearch(target.page);
    await expect(target.page.locator('[data-chat-id]')).toBeVisible({ timeout: 20_000 });
    await expect(pending.getByText(target.publicId)).toHaveCount(0, { timeout: 10_000 });

    // The target started this conversation by searching, so the owner's panel does not pop
    // open. The directory row now offers the existing hidden chat instead.
    await expect(row.getByRole('button', { name: 'Открыть чат', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await row.getByRole('button', { name: 'Открыть чат', exact: true }).click();
    await expect(owner.page.getByLabel('Сообщение', { exact: true })).toBeVisible();

    const ownerComposer = owner.page
      .locator('form')
      .filter({ has: owner.page.getByLabel('Сообщение', { exact: true }) });
    await ownerComposer.getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(target.page.getByText('Собеседник завершил чат.')).toBeVisible({
      timeout: 10_000,
    });

    await owner.context.close();
    await target.context.close();
  });
});
