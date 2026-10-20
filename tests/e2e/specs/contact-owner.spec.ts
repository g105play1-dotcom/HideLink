import { expect, test } from '@playwright/test';

import { expectNoClientErrors, newIdentity } from '../support/app';
import { openOwnerPage, resetInbox, signIn } from '../support/owner';

/**
 * "Связаться с администрацией" — the one form that sends text to the operator.
 *
 * ## What only a browser test can prove
 *
 * The server-side rules (validation, the daily budget, the sender taken from the session)
 * are integration tests. What is only visible here is the loop a person actually performs:
 * open the form, pick a subsection, send, and find the message waiting in the owner's
 * inbox on a *different* screen — including the promise the form makes before sending,
 * that the text is stored and the owner sees who wrote it.
 *
 * ## Cleanup
 *
 * The inbox is global state in the shared `*_test` database, so `afterEach` empties it
 * through the owner's API rather than through the page under test.
 */
test.describe('contacting the owner', () => {
  test.afterEach(async () => {
    await resetInbox();
  });

  test('a message reaches the owner inbox, and the owner can delete it', async ({ browser }) => {
    const user = await newIdentity(browser);
    const owner = await openOwnerPage(browser);

    await user.page
      .getByRole('button', { name: 'Связаться с администрацией', exact: true })
      .click();

    const dialog = user.page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Связаться с администрацией' })).toBeVisible();

    // Nothing to send yet, and the interface says so instead of sending an empty message.
    const send = dialog.getByRole('button', { name: 'Отправить администрации', exact: true });
    await expect(send).toBeDisabled();

    // The subsections the owner asked for are all offered.
    for (const topic of [
      'Жалоба на пользователя',
      'Предложение',
      'Ошибка в работе',
      'Реклама',
      'Сотрудничество',
    ]) {
      await expect(dialog.getByRole('radio', { name: topic, exact: true })).toBeVisible();
    }

    await dialog.getByRole('radio', { name: 'Реклама', exact: true }).check();
    await dialog
      .getByLabel('Текст сообщения', { exact: true })
      .fill('Хочу разместить рекламу на сайте');
    await dialog
      .getByLabel('Как с вами связаться (необязательно)', { exact: true })
      .fill('telegram: @buyer');

    await expect(send).toBeEnabled();
    await send.click();

    // The confirmation is the user's only evidence — there is no "sent" screen.
    await expect(user.page.getByText('Сообщение отправлено администрации.')).toBeVisible();
    await expect(user.page.getByRole('dialog')).toHaveCount(0);

    await signIn(owner.page);
    await expect(
      owner.page.getByRole('heading', { name: 'Сообщения от пользователей' }),
    ).toBeVisible();

    const row = owner.page.locator('li').filter({ hasText: 'Хочу разместить рекламу на сайте' });
    await expect(row).toBeVisible();
    await expect(row.getByText('Реклама', { exact: true })).toBeVisible();
    await expect(row.getByText('telegram: @buyer')).toBeVisible();
    // The owner is told who wrote in; nobody else is.
    await expect(row.getByText(user.publicId)).toBeVisible();

    owner.page.once('dialog', (confirmation) => confirmation.accept());
    await row.getByRole('button', { name: 'Удалить', exact: true }).click();

    await expect(owner.page.getByText('Хочу разместить рекламу на сайте')).toHaveCount(0);

    expectNoClientErrors(user);

    await owner.context.close();
    await user.context.close();
  });
});
