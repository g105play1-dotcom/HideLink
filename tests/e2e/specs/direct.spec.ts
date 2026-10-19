import { expect, test } from '@playwright/test';

import {
  chatCard,
  closeSettings,
  connectionStatus,
  expectMessage,
  expectNoClientErrors,
  lookupUser,
  newIdentity,
  openSettings,
  sendMessage,
  waitForChat,
} from '../support/app';

test.describe('direct contact by User ID', () => {
  test('a request is sent, accepted, and both sides see each other', async ({ browser }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);

    // Typing the *display* form (with dashes) must work: people copy what they see.
    await lookupUser(alice.page, bob.displayId);
    await expect(alice.page.getByText('Пользователь найден и принимает заявки.')).toBeVisible();

    await alice.page.getByRole('button', { name: 'Отправить заявку', exact: true }).click();

    // The recipient decides, and is told who is asking — the one privacy cost of this
    // flow, which the sender's screen states explicitly before the button.
    const dialog = bob.page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(alice.publicId);
    await expect(dialog).toContainText('Без сообщения.');

    await dialog.getByRole('button', { name: 'Принять', exact: true }).click();

    const aliceChatId = await waitForChat(alice.page);
    const bobChatId = await waitForChat(bob.page);
    expect(bobChatId).toBe(aliceChatId);

    // A direct chat is the only place a User ID is disclosed — both parties already
    // knew it, and it is what makes blocking possible later.
    await expect(chatCard(alice.page)).toContainText(bob.publicId);
    await expect(chatCard(bob.page)).toContainText(alice.publicId);

    await sendMessage(alice.page, 'Спасибо, что приняли.');
    await expectMessage(bob.page, 'Спасибо, что приняли.');
    await sendMessage(bob.page, 'Не за что.');
    await expectMessage(alice.page, 'Не за что.');

    expectNoClientErrors(alice);
    expectNoClientErrors(bob);
  });

  test('a declined request tells the sender and starts nothing', async ({ browser }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);

    await lookupUser(alice.page, bob.publicId);
    await alice.page.getByRole('button', { name: 'Отправить заявку', exact: true }).click();

    const dialog = bob.page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Отклонить', exact: true }).click();

    await expect(
      alice.page.getByRole('status').filter({ hasText: 'Заявка отклонена.' }),
    ).toBeVisible();

    // Neither side is in a chat afterwards, and the pending-request panel is gone.
    await expect(chatCard(alice.page)).toHaveCount(0);
    await expect(chatCard(bob.page)).toHaveCount(0);
    await expect(alice.page.getByText('Заявка отправлена.')).toHaveCount(0);
    await expect(bob.page.getByRole('dialog')).toHaveCount(0);

    expectNoClientErrors(alice);
    expectNoClientErrors(bob);
  });

  test('a user who disabled incoming requests cannot be asked, and the setting survives a reload', async ({
    browser,
  }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);

    await openSettings(bob.page);
    const nobodyOption = bob.page.getByRole('button', { name: /Не принимать заявки/ });
    await nobodyOption.click();
    await expect(nobodyOption).toHaveAttribute('aria-pressed', 'true');
    await closeSettings(bob.page);

    // Alice can still find the identity — it exists — but cannot ask for a chat.
    await lookupUser(alice.page, bob.publicId);
    await expect(
      alice.page.getByText('Пользователь найден, но он отключил входящие заявки.'),
    ).toBeVisible();
    await expect(
      alice.page.getByRole('button', { name: 'Отправить заявку', exact: true }),
    ).toHaveCount(0);

    // The setting is stored server-side: a reload shows the server's answer, not a
    // value that only ever lived in this tab.
    await bob.page.reload();
    await expect(connectionStatus(bob.page)).toHaveText('На связи');
    await openSettings(bob.page);
    await expect(bob.page.getByRole('button', { name: /Не принимать заявки/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    expectNoClientErrors(alice);
  });

  test('a user cannot send a request to their own User ID', async ({ browser }) => {
    const alice = await newIdentity(browser);

    await lookupUser(alice.page, alice.publicId);

    await expect(alice.page.getByText('Это ваш собственный User ID.')).toBeVisible();
    await expect(
      alice.page.getByRole('button', { name: 'Отправить заявку', exact: true }),
    ).toHaveCount(0);

    expectNoClientErrors(alice);
  });
});
