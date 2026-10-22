import { expect, test } from '@playwright/test';

import { expectMessage, matchPair, newIdentity, sendMessage } from '../support/app';
import {
  archiveTranscript,
  openOwnerPage,
  resetArchive,
  savePolicy,
  setStorageSwitch,
  signIn,
} from '../support/owner';

/**
 * The owner's archive page, driven the way the owner drives it.
 *
 * This spec exists because the page had no browser test while it had two real defects: the
 * `PUT` that saves the policy was missing from the CORS method list (server tests never
 * sent an `Origin`, so they never saw a preflight and the button was simply dead), and the
 * key was demanded again after every reload although the cookie was still valid. Both were
 * found by hand. A hand pass is not a regression test.
 *
 * ## What it deliberately does not do
 *
 * It does not assert an empty console. The owner page *asks* the server whether this
 * browser is already signed in, and the answer for a stranger is a 401 — which Chromium
 * reports as a console error. Asserting silence here would mean asserting the page cannot
 * tell "not signed in yet" from "the server is broken".
 *
 * ## Cleanup
 *
 * `afterEach` resets the archive through the owner's API. The integration suite's
 * `persistence.test.ts` asserts that a default installation stores nothing and runs
 * against the same `*_test` database, so leaving a row behind would fail a suite that has
 * nothing to do with this one. It is also why the reset does not go through the page: a
 * cleanup that depends on the interface under test is not a cleanup.
 */
test.describe('the owner archive page', () => {
  test.afterEach(async () => {
    await resetArchive();
  });

  test('refuses a wrong key, opens for the right one, and survives a reload', async ({
    browser,
  }) => {
    const owner = await openOwnerPage(browser);

    // Closed by default: no policy form, only the key form.
    await expect(owner.page.getByRole('heading', { name: 'Ключ владельца' })).toBeVisible();
    await expect(owner.page.getByRole('heading', { name: 'Что сохранять' })).toHaveCount(0);

    // A wrong key is refused, and the refusal is visible — not a silent no-op. The alert is
    // narrowed by text because Next renders its own always-present `role="alert"` route
    // announcer, so a bare `getByRole('alert')` matches two elements.
    await owner.page.getByLabel('Ключ', { exact: true }).fill('not-the-key'.padEnd(40, 'x'));
    await owner.page.getByRole('button', { name: 'Открыть архив', exact: true }).click();
    await expect(
      owner.page.getByRole('alert').filter({ hasText: 'Неверный ключ владельца.' }),
    ).toBeVisible();
    await expect(owner.page.getByRole('heading', { name: 'Что сохранять' })).toHaveCount(0);

    await signIn(owner.page);

    // The key is exchanged for a cookie, so a reload must not ask for it again. This is the
    // behaviour that was broken: the page trusted its own memory instead of the server.
    await owner.page.reload();
    await expect(owner.page.getByRole('heading', { name: 'Что сохранять' })).toBeVisible();
    await expect(owner.page.getByRole('heading', { name: 'Ключ владельца' })).toHaveCount(0);

    await owner.context.close();
  });

  test('records a conversation the policy covers, and reads it back', async ({ browser }) => {
    const owner = await openOwnerPage(browser);
    await signIn(owner.page);

    // The shipped policy is off; the owner turns it on for everyone, text only.
    await expect(owner.page.getByLabel('Хранить переписку', { exact: true })).not.toBeChecked();
    await setStorageSwitch(owner.page, true);
    await savePolicy(owner.page, { enabled: true });

    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);
    await matchPair(alice, bob);

    await sendMessage(alice.page, 'привет, это первая строка');
    await expectMessage(bob.page, 'привет, это первая строка');
    await sendMessage(bob.page, 'а это вторая строка');
    await expectMessage(alice.page, 'а это вторая строка');

    await alice.page.getByRole('button', { name: 'Завершить', exact: true }).click();
    await expect(alice.page.getByText('Вы завершили чат.')).toBeVisible();

    // The list refreshes on its own every ten seconds; a reload makes the assertion about
    // the server's state instead of about waiting.
    await owner.page.reload();
    await expect(owner.page.getByRole('heading', { name: 'Сохранённые переписки' })).toBeVisible();
    await expect(owner.page.getByText('сообщений: 2')).toBeVisible();
    await expect(owner.page.getByText(alice.publicId).first()).toBeVisible();
    await expect(owner.page.getByText(bob.publicId).first()).toBeVisible();

    // Opening a row reads the transcript, and each message is attributed to its author.
    await owner.page.getByRole('button', { name: 'Открыть', exact: true }).click();

    const transcript = archiveTranscript(owner.page);
    await expect(transcript).toContainText('привет, это первая строка');
    await expect(transcript).toContainText('а это вторая строка');
    await expect(
      transcript.locator('li').filter({ hasText: 'привет, это первая строка' }),
    ).toContainText(alice.publicId);
    await expect(transcript.locator('li').filter({ hasText: 'а это вторая строка' })).toContainText(
      bob.publicId,
    );

    // The users themselves are told nothing: their screens never mention storage. This is
    // the owner's requirement (2026-10-19), and it is a property of the product, not of
    // the archive: nothing in the chat may advertise that a transcript is being kept.
    // `innerText` and not `textContent`, so a dialog that is mounted but closed — the report
    // form legitimately mentions a saved message — is not counted as something the user sees.
    for (const identity of [alice, bob]) {
      const visible = await identity.page.locator('main').innerText();
      expect(visible).not.toMatch(/архив/i);
      expect(visible).not.toMatch(/сохраня/i);
      expect(visible).not.toMatch(/истори/i);
    }

    await owner.context.close();
    await alice.context.close();
    await bob.context.close();
  });

  test('stores nothing once the switch is off, and deletes on demand', async ({ browser }) => {
    const owner = await openOwnerPage(browser);
    await signIn(owner.page);

    // One stored conversation to delete later.
    await setStorageSwitch(owner.page, true);
    await savePolicy(owner.page, { enabled: true });

    const first = await newIdentity(browser);
    const firstPeer = await newIdentity(browser);
    await matchPair(first, firstPeer);
    await sendMessage(first.page, 'запись до выключения');
    await expectMessage(firstPeer.page, 'запись до выключения');
    await first.page.getByRole('button', { name: 'Завершить', exact: true }).click();
    await expect(first.page.getByText('Вы завершили чат.')).toBeVisible();

    await owner.page.reload();
    await expect(owner.page.getByRole('button', { name: 'Открыть', exact: true })).toHaveCount(1);

    // Readable while it is stored — otherwise "it is gone after the deletion" would be a
    // statement about text that was never on screen to begin with.
    await owner.page.getByRole('button', { name: 'Открыть', exact: true }).click();
    await expect(archiveTranscript(owner.page)).toContainText('запись до выключения');

    // Off. The switch acts immediately: the messages below are sent while it is off.
    await setStorageSwitch(owner.page, false);
    await savePolicy(owner.page, { enabled: false });

    const second = await newIdentity(browser);
    const secondPeer = await newIdentity(browser);
    await matchPair(second, secondPeer);
    await sendMessage(second.page, 'запись после выключения');
    await expectMessage(secondPeer.page, 'запись после выключения');
    await second.page.getByRole('button', { name: 'Завершить', exact: true }).click();
    await expect(second.page.getByText('Вы завершили чат.')).toBeVisible();

    await owner.page.reload();
    await expect(owner.page.getByRole('button', { name: 'Открыть', exact: true })).toHaveCount(1);
    await expect(owner.page.getByText('запись после выключения')).toHaveCount(0);

    // Deleting asks first, and then deletes for real.
    owner.page.once('dialog', (dialog) => dialog.accept());
    await owner.page.getByRole('button', { name: 'Удалить всё', exact: true }).click();

    // The report is the server's own count, so "the list is empty" is not the only evidence
    // that something was actually deleted.
    await expect(
      owner.page.getByRole('status').filter({ hasText: 'Удалено переписок: 1' }),
    ).toBeVisible();
    await expect(owner.page.getByText('Пока ничего не сохранено.')).toBeVisible();
    await expect(owner.page.getByRole('button', { name: 'Открыть', exact: true })).toHaveCount(0);
    await expect(owner.page.getByText('запись до выключения')).toHaveCount(0);

    await owner.context.close();
    await first.context.close();
    await firstPeer.context.close();
    await second.context.close();
    await secondPeer.context.close();
  });

  test('bans a User ID, closes the banned tab, and lets it back in after unbanning', async ({
    browser,
  }) => {
    const owner = await openOwnerPage(browser);
    await signIn(owner.page);

    const user = await newIdentity(browser);

    const search = owner.page.getByLabel('Найти пользователя по User ID', { exact: true });
    await search.fill(user.publicId);

    const row = owner.page.getByRole('listitem').filter({ hasText: user.publicId });
    await expect(row).toBeVisible();
    await row.getByLabel(`Причина бана ${user.publicId}`).fill('проверка бана');
    await row.getByRole('button', { name: 'Забанить', exact: true }).click();

    await expect(row.getByText('Заблокирован', { exact: true })).toBeVisible();
    await expect(row.getByText('проверка бана')).toBeVisible();

    // The live tab is told by the server, not merely left to fail on the next action.
    await expect(user.page.getByText('Доступ закрыт', { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(user.page.getByText('Эта анонимная личность заблокирована.')).toBeVisible();

    // Unbanning restores the same identity: the session was never revoked, so pressing
    // "Повторить" must open the app again instead of minting a new User ID.
    await row.getByRole('button', { name: 'Разбанить', exact: true }).click();
    await expect(row.getByText('Активен', { exact: true })).toBeVisible();

    await user.page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(user.page.getByText('На связи', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(user.page.locator('#own-user-id')).toHaveText(user.displayId);

    await owner.context.close();
    await user.context.close();
  });
});
