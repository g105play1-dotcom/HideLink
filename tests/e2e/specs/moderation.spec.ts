import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import {
  closeSettings,
  connectionStatus,
  expectMessage,
  matchPair,
  newIdentity,
  openSettings,
  searchButton,
  sendMessage,
  waitForChat,
} from '../support/app';
import { openOwnerPage, setBlockingPolicy, signIn } from '../support/owner';

/**
 * The owner's moderation panel, driven the way the owner drives it.
 *
 * Two things are proven here that no server test can prove on its own: the platform switch
 * actually reaches a *new* user's chat screen (the button is gone when it is off, back when
 * it is on), and a report filed through the interface is readable and actionable in
 * `/admin`, including the server's own snapshot of the reported message.
 *
 * The stack fixture starts with blocking enabled because most specs test its mechanics;
 * this spec is the one that turns it off. Teardown restores it through the API even if a
 * test fails halfway, so a later spec never inherits "blocking off" by accident.
 */

test.describe('moderation panel', () => {
  test.afterAll(async () => {
    await setBlockingPolicy(true);
  });

  test('the owner switch removes the block action for new chats and brings it back', async ({
    browser,
  }) => {
    const owner = await openOwnerPage(browser);
    const toggle = owner.page.getByRole('checkbox', {
      name: /Разрешить блокировку собеседника/,
    });

    try {
      await signIn(owner.page);

      // The fixture enabled it, so the owner sees the switch on.
      await expect(toggle).toBeChecked();

      await toggle.click();
      // The box is controlled by the server's answer: it only stays unchecked after the
      // PUT succeeded and the query refetched. A failed save leaves it checked and visible.
      await expect(toggle).not.toBeChecked();

      const withoutBlocking = await newIdentity(browser);
      const peer = await newIdentity(browser);
      await matchPair(withoutBlocking, peer);
      await waitForChat(withoutBlocking.page);

      // The report action is still there — only blocking is the owner's to grant.
      await expect(
        withoutBlocking.page.getByRole('button', { name: 'Жалоба', exact: true }),
      ).toBeVisible();
      await expect(
        withoutBlocking.page.getByRole('button', { name: 'Блокировать', exact: true }),
      ).toHaveCount(0);

      await toggle.click();
      await expect(toggle).toBeChecked();

      const withBlocking = await newIdentity(browser);
      const otherPeer = await newIdentity(browser);
      await matchPair(withBlocking, otherPeer);
      await waitForChat(withBlocking.page);

      await expect(
        withBlocking.page.getByRole('button', { name: 'Блокировать', exact: true }),
      ).toBeVisible();
    } finally {
      await owner.context.close();
    }
  });

  test('a report filed by a user shows up with its evidence and an editable status', async ({
    browser,
  }) => {
    const reporter = await newIdentity(browser);
    const target = await newIdentity(browser);
    await matchPair(reporter, target);
    await waitForChat(target.page);

    const marker = `e2e-жалоба-${randomUUID()}`;
    const reportedText = `сообщение-${randomUUID()}`;

    await sendMessage(reporter.page, reportedText);
    // The report names the last message the *reporter's client* has; wait until the other
    // side actually holds it, or the snapshot could legitimately be the previous message.
    await expectMessage(target.page, reportedText);

    // The *target* reports the last message, which is the one the server snapshots.
    await target.page.getByRole('button', { name: 'Жалоба', exact: true }).click();
    const dialog = target.page.getByRole('dialog', { name: 'Пожаловаться на собеседника' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('radio', { name: 'Спам или реклама' }).check();
    await dialog.getByLabel('Подробности').fill(marker);
    await dialog.getByRole('button', { name: 'Отправить жалобу', exact: true }).click();
    await expect(dialog).toBeHidden();

    // The reported side now sees a warning with the possible-ban consequence. It names
    // neither the reporter nor the evidence, and acknowledging it is durable.
    const warning = reporter.page.getByRole('dialog', { name: 'На вас поступила жалоба' });
    await expect(warning).toBeVisible();
    await warning.getByRole('button', { name: 'Понятно', exact: true }).click();
    await expect(warning).toBeHidden();

    await reporter.page.reload();
    await expect(connectionStatus(reporter.page)).toHaveText('На связи', { timeout: 30_000 });
    await expect(
      reporter.page.getByRole('dialog', { name: 'На вас поступила жалоба' }),
    ).toHaveCount(0);

    const owner = await openOwnerPage(browser);
    try {
      await signIn(owner.page);

      // The row is found by the unique note, because the report list is global and the
      // test database is not wiped between runs.
      const row = owner.page.getByRole('listitem').filter({ hasText: marker });
      await expect(row).toBeVisible();
      await expect(row.getByText('Спам или реклама')).toBeVisible();
      await expect(row.getByText(reportedText)).toBeVisible();
      await expect(row.getByText(reporter.publicId, { exact: true })).toBeVisible();
      await expect(row.getByText(target.publicId, { exact: true })).toBeVisible();

      const status = row.getByLabel(`Статус жалобы ${target.publicId}`);
      await expect(status).toHaveValue('open');

      await status.selectOption('actioned');
      await expect(status).toHaveValue('actioned');

      // A reload proves the status was stored rather than only rendered. The admin cookie
      // survives it, so the panel must open without asking for the key again.
      await owner.page.reload();
      await expect(owner.page.getByRole('heading', { name: 'Что сохранять' })).toBeVisible();

      const persisted = owner.page.getByRole('listitem').filter({ hasText: marker });
      await expect(persisted).toBeVisible();
      await expect(persisted.getByLabel(`Статус жалобы ${target.publicId}`)).toHaveValue(
        'actioned',
      );
    } finally {
      await owner.context.close();
    }
  });

  test('blocked people sit beside friends at the bottom and stay removable when the policy is off', async ({
    browser,
  }) => {
    await setBlockingPolicy(true);

    const blocker = await newIdentity(browser);
    const peer = await newIdentity(browser);

    try {
      await matchPair(blocker, peer);
      await waitForChat(blocker.page);

      await blocker.page.getByRole('button', { name: 'Блокировать', exact: true }).click();
      const dialog = blocker.page.getByRole('dialog', { name: 'Заблокировать собеседника?' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Заблокировать', exact: true }).click();
      await expect(dialog).toBeHidden();

      await blocker.page.getByRole('button', { name: 'Готово', exact: true }).click();

      const friendsHeading = blocker.page.getByRole('heading', { name: /^Друзья/ });
      const blockedHeading = blocker.page.getByRole('heading', { name: /^Заблокированные/ });
      await expect(friendsHeading).toBeVisible();
      await expect(blockedHeading).toBeVisible();

      const friendsBox = await friendsHeading.boundingBox();
      const blockedBox = await blockedHeading.boundingBox();
      const searchBox = await searchButton(blocker.page).boundingBox();

      expect(friendsBox).not.toBeNull();
      expect(blockedBox).not.toBeNull();
      expect(searchBox).not.toBeNull();

      // Friends on the left, blocked people on the right, both under the search card.
      expect(friendsBox!.x).toBeLessThan(blockedBox!.x);
      expect(Math.abs(friendsBox!.y - blockedBox!.y)).toBeLessThan(8);
      expect(blockedBox!.y).toBeGreaterThan(searchBox!.y);

      const blockedList = blocker.page.getByRole('list', { name: 'Список заблокированных' });
      await expect(blockedList.getByTitle(peer.publicId)).toBeVisible();

      // Switching new blocks off is not an amnesty: the existing block is still listed
      // and removable, and the settings screen neither repeats the list nor explains the
      // platform policy. The absence of the action in a chat is the whole message.
      await setBlockingPolicy(false);
      await blocker.page.reload();
      await expect(connectionStatus(blocker.page)).toHaveText('На связи', { timeout: 30_000 });
      await expect(blockedList.getByTitle(peer.publicId)).toBeVisible();

      await openSettings(blocker.page);
      const settings = blocker.page.locator('#settings-panel');
      await expect(settings.getByText('Заблокированные', { exact: true })).toHaveCount(0);
      await expect(
        settings.getByText('Блокировка собеседника сейчас отключена администрацией.', {
          exact: false,
        }),
      ).toHaveCount(0);
      await closeSettings(blocker.page);

      await blockedList.getByRole('button', { name: 'Разблокировать', exact: true }).click();
      await expect(blockedList).toHaveCount(0);
    } finally {
      await setBlockingPolicy(true);
    }
  });
});
