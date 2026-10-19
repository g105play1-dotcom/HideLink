import { expect, test } from '@playwright/test';

import {
  chatCard,
  composer,
  connectionStatus,
  expectMessage,
  matchPair,
  newIdentity,
  searchButton,
  sendButton,
  sendMessage,
  startRandomSearch,
  transcript,
  waitForNewChat,
} from '../support/app';
import { startApi, stopApi } from '../support/stack';

test.describe('connection loss and recovery', () => {
  test('reloading mid-chat restores the same conversation without duplicating messages', async ({
    browser,
  }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);

    const { firstChatId } = await matchPair(alice, bob);
    await sendMessage(alice.page, 'сообщение до перезагрузки');
    await expectMessage(bob.page, 'сообщение до перезагрузки');

    await alice.page.reload();

    await expect(connectionStatus(alice.page)).toHaveText('На связи', { timeout: 30_000 });

    // The identity survives the reload. Asserted explicitly because everything else in this
    // test would also pass on a brand-new identity that had somehow inherited the chat.
    await expect(alice.page.locator('#own-user-id')).toHaveText(alice.displayId);

    // Same conversation, and the server replays its history to this socket.
    await expect(chatCard(alice.page)).toHaveAttribute('data-chat-id', firstChatId);
    await expectMessage(alice.page, 'сообщение до перезагрузки');

    // Replayed exactly once. A transcript that doubles after every reload is the classic
    // reconnect bug, and no single-assertion test would notice it.
    const afterReload = (await transcript(alice.page).textContent()) ?? '';
    expect(afterReload.split('сообщение до перезагрузки')).toHaveLength(2);

    // The reconnected socket is fully functional in both directions.
    await sendMessage(alice.page, 'ответ после перезагрузки');
    await expectMessage(bob.page, 'ответ после перезагрузки');
  });

  test('a reload does not end the chat for the other side', async ({ browser }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);
    await matchPair(alice, bob);

    await alice.page.reload();
    await expect(connectionStatus(alice.page)).toHaveText('На связи', { timeout: 30_000 });

    // The peer keeps the conversation: a refresh is not a goodbye. This is the entire
    // point of the reconnect grace period.
    await expect(bob.page.getByText('Собеседник завершил чат.')).toHaveCount(0);
    await sendMessage(bob.page, 'я всё ещё здесь');
    await expectMessage(alice.page, 'я всё ещё здесь');
  });

  test('the composer refuses an over-long message instead of silently trimming it', async ({
    browser,
  }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);
    await matchPair(alice, bob);

    // The limit is whatever the server announced in `session:ready`. It is read from the
    // counter rather than hard-coded, so this test cannot drift from the deployment.
    await composer(alice.page).fill('Ж'.repeat(500));
    const counter = (await alice.page.locator('#composer-length').textContent()) ?? '';
    const max = Number(counter.split('/')[1]);

    expect(Number.isInteger(max)).toBe(true);
    expect(max).toBeGreaterThan(0);

    // Deliberately not a bare `getByRole('alert')`: Next.js renders its own route
    // announcer with that role, so an unfiltered locator would be ambiguous.
    await expect(
      alice.page.getByRole('alert').filter({ hasText: 'Сообщение слишком длинное' }),
    ).toContainText('Сообщение слишком длинное');
    await expect(sendButton(alice.page)).toBeDisabled();
    await expect(composer(alice.page)).toHaveAttribute('aria-invalid', 'true');

    // A message exactly at the limit is accepted, and arrives complete — no silent tail
    // loss, which is precisely what a "helpful" client-side truncation would cause.
    const long = 'Ж'.repeat(max);
    await composer(alice.page).fill(long);
    await expect(sendButton(alice.page)).toBeEnabled();
    await sendButton(alice.page).click();
    await expectMessage(bob.page, long);

    const received = (await transcript(bob.page).textContent()) ?? '';
    expect(received).toContain(long);
  });

  test('losing the API and coming back leaves no phantom conversation', async ({ browser }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);
    const { firstChatId } = await matchPair(alice, bob);
    await sendMessage(alice.page, 'сообщение до падения');
    await expectMessage(bob.page, 'сообщение до падения');

    stopApi();

    // While the server is gone the indicator is the only thing the user can rely on.
    await expect(connectionStatus(alice.page)).toHaveText(/Переподключение…|Нет связи/, {
      timeout: 20_000,
    });

    await startApi();
    await expect(connectionStatus(alice.page)).toHaveText('На связи', { timeout: 40_000 });

    // The conversation lived in the process that died. A fresh server reports no active
    // chat for this identity, and the tab must believe the server instead of keeping a
    // transcript that nobody will ever receive.
    await expect(chatCard(alice.page)).toHaveCount(0);
    await expect(searchButton(alice.page)).toBeVisible();
    await expect(
      alice.page.getByRole('status').filter({ hasText: 'Соединение с сервером прервалось' }),
    ).toBeVisible();

    // And the app is immediately usable again: a new match works end to end.
    await startRandomSearch(alice.page);
    await startRandomSearch(bob.page);

    const nextChatId = await waitForNewChat(alice.page, firstChatId);
    await expect(chatCard(bob.page)).toHaveAttribute('data-chat-id', nextChatId);

    await sendMessage(bob.page, 'восстановились');
    await expectMessage(alice.page, 'восстановились');
  });
});
