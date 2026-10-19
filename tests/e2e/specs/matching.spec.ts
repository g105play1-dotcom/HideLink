import { expect, test } from '@playwright/test';

import { formatPublicIdForDisplay } from '@anonlink/shared';

import {
  cancelSearchButton,
  chatCard,
  expectMessage,
  expectNoClientErrors,
  matchPair,
  newIdentity,
  searchButton,
  sendMessage,
  startRandomSearch,
  transcript,
  waitForNewChat,
} from '../support/app';

test.describe('random matching', () => {
  test('matches two strangers and delivers messages both ways', async ({ browser }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);

    const { firstChatId, secondChatId } = await matchPair(alice, bob);

    // One conversation, two points of view.
    expect(secondChatId).toBe(firstChatId);

    // A random match never discloses the peer's User ID. This is the property the whole
    // "anonymous by default" promise rests on, so it is asserted from both sides.
    await expect(alice.page.locator('main')).not.toContainText(
      formatPublicIdForDisplay(bob.publicId),
    );
    await expect(bob.page.locator('main')).not.toContainText(
      formatPublicIdForDisplay(alice.publicId),
    );

    await sendMessage(alice.page, 'Привет! Как дела?');
    await expectMessage(bob.page, 'Привет! Как дела?');

    await sendMessage(bob.page, 'Отлично, а у тебя?');
    await expectMessage(alice.page, 'Отлично, а у тебя?');

    // Ordering: the earlier message precedes the later one in the transcript.
    const log = (await transcript(alice.page).textContent()) ?? '';
    const first = log.indexOf('Привет! Как дела?');
    const second = log.indexOf('Отлично, а у тебя?');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);

    expectNoClientErrors(alice);
    expectNoClientErrors(bob);
  });

  test('ending a chat explains it to both sides, and "done" returns to the start screen', async ({
    browser,
  }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);
    await matchPair(alice, bob);

    await sendMessage(alice.page, 'до встречи');
    await expectMessage(bob.page, 'до встречи');

    await alice.page.getByRole('button', { name: 'Завершить', exact: true }).click();

    // Each side is told from its own perspective — nobody is told "you were left" when
    // they were the one who left.
    await expect(alice.page.getByText('Вы завершили чат.')).toBeVisible();
    await expect(bob.page.getByText('Собеседник завершил чат.')).toBeVisible();

    // The transcript survives, so the user can still read what was said.
    await expectMessage(alice.page, 'до встречи');

    // "Готово" dismisses the finished conversation and brings the start screen back.
    // Without it the ended screen was a dead end whose only exit was another search.
    await alice.page.getByRole('button', { name: 'Готово', exact: true }).click();
    await expect(searchButton(alice.page)).toBeVisible();
    await expect(alice.page.locator('#target-user-id')).toBeVisible();
    await expect(chatCard(alice.page)).toHaveCount(0);

    expectNoClientErrors(alice);
    expectNoClientErrors(bob);
  });

  test('"next" starts a different conversation with an empty transcript', async ({ browser }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);

    const { firstChatId } = await matchPair(alice, bob);
    await sendMessage(alice.page, 'это первый чат');
    await expectMessage(bob.page, 'это первый чат');

    // Alice skips: the chat ends for both of them and she is queued straight away.
    await alice.page.getByRole('button', { name: 'Следующий', exact: true }).click();
    await expect(alice.page.getByText('Ищем собеседника…')).toBeVisible();

    // Bob learns the chat is over and queues for a new stranger too.
    await expect(bob.page.getByText('Собеседник завершил чат.')).toBeVisible();
    await bob.page.getByRole('button', { name: 'Найти нового собеседника', exact: true }).click();

    const nextChatId = await waitForNewChat(alice.page, firstChatId);
    expect(nextChatId).not.toBe(firstChatId);
    await expect(chatCard(bob.page)).toHaveAttribute('data-chat-id', nextChatId);

    // Nothing from the previous conversation may leak into the new one.
    await expect(transcript(alice.page)).not.toContainText('это первый чат');
    await expect(transcript(bob.page)).not.toContainText('это первый чат');

    await sendMessage(bob.page, 'новый чат работает');
    await expectMessage(alice.page, 'новый чат работает');

    expectNoClientErrors(alice);
    expectNoClientErrors(bob);
  });

  test('a search can be cancelled, and its timer is actually running', async ({ browser }) => {
    const alice = await newIdentity(browser);
    await startRandomSearch(alice.page);

    const timer = alice.page.getByLabel('Время ожидания');
    await expect(timer).toHaveText(/^\d{2}:\d{2}$/);

    const firstReading = await timer.textContent();
    await expect.poll(async () => timer.textContent(), { timeout: 5_000 }).not.toBe(firstReading);

    await cancelSearchButton(alice.page).click();
    await expect(searchButton(alice.page)).toBeVisible();
    await expect(
      alice.page.getByRole('status').filter({ hasText: 'Поиск отменён.' }),
    ).toBeVisible();

    expectNoClientErrors(alice);
  });
});
