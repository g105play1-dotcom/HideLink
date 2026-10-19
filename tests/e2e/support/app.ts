/**
 * Browser-side helpers shared by every spec.
 *
 * These are written in terms of what a user sees (roles, labels, visible text) rather
 * than CSS classes or test ids, so a passing test is also evidence that the accessible
 * structure of the page is intact. The only non-semantic hook is `data-chat-id`, which
 * carries the conversation's identifier for the cross-account authorisation test.
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export interface Identity {
  context: BrowserContext;
  page: Page;
  /** The raw User ID, e.g. `AL7KM39PQ2XRZ4`. */
  publicId: string;
  /** The same ID as the interface shows it, e.g. `AL7KM3-9PQ2-XRZ4`. */
  displayId: string;
  /** Console errors and uncaught exceptions seen on this page so far. */
  errors: string[];
}

/** Opens the app in a fresh browser context with a brand-new anonymous identity. */
export async function newIdentity(browser: Browser): Promise<Identity> {
  const context = await browser.newContext();
  const page = await context.newPage();

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });

  await openApp(page);

  const displayId = (await page.locator('#own-user-id').textContent())?.trim() ?? '';
  const publicId = displayId.replace(/-/g, '');

  expect(publicId, 'the identity card must show a User ID').toMatch(/^AL[0-9A-Z]{12}$/);

  return { context, page, publicId, displayId, errors };
}

/** Navigates to the app and waits until the socket is established. */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(connectionStatus(page)).toHaveText('На связи', { timeout: 30_000 });
}

/** The live connection indicator in the header. */
export function connectionStatus(page: Page) {
  return page.locator('header').getByRole('status');
}

/** The "find a random stranger" call to action. */
export function searchButton(page: Page) {
  return page.getByRole('button', { name: 'Найти собеседника', exact: true });
}

export function cancelSearchButton(page: Page) {
  return page.getByRole('button', { name: 'Отменить поиск', exact: true });
}

/** The conversation card, whichever state it is in. */
export function chatCard(page: Page) {
  return page.locator('[data-chat-id]');
}

/** The message transcript. */
export function transcript(page: Page) {
  return page.getByRole('log', { name: 'Переписка' });
}

export function composer(page: Page) {
  return page.getByLabel('Сообщение', { exact: true });
}

export function sendButton(page: Page) {
  return page.getByRole('button', { name: 'Отправить', exact: true });
}

/**
 * Joins the random-matching queue.
 *
 * The waiting screen is *transient* for the second participant of a pair: they are
 * matched the moment they join, so waiting for "Ищем собеседника…" specifically would
 * race the chat screen that replaces it. Either outcome means the click worked.
 */
export async function startRandomSearch(page: Page): Promise<void> {
  await searchButton(page).click();
  await expect(page.getByText('Ищем собеседника…').or(chatCard(page))).toBeVisible({
    timeout: 20_000,
  });
}

/** Waits for a conversation to appear and returns its id. */
export async function waitForChat(page: Page): Promise<string> {
  const card = chatCard(page);
  await expect(card).toBeVisible({ timeout: 20_000 });

  const chatId = await card.getAttribute('data-chat-id');
  expect(chatId, 'the chat card must carry its conversation id').toBeTruthy();

  return chatId as string;
}

/** Waits until the visible conversation is a *different* one, and returns its id. */
export async function waitForNewChat(page: Page, previousChatId: string): Promise<string> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const current = await chatCard(page)
      .getAttribute('data-chat-id')
      .catch(() => null);

    if (current && current !== previousChatId) return current;

    await page.waitForTimeout(100);
  }

  throw new Error(`the conversation never changed away from ${previousChatId}`);
}

/** Two strangers queue up and are matched with each other. */
export async function matchPair(
  first: Identity,
  second: Identity,
): Promise<{ firstChatId: string; secondChatId: string }> {
  // Sequentially: the first one waits in the queue, so the second joins and matches
  // immediately. Clicking both "at the same time" would be a race in the test itself.
  await startRandomSearch(first.page);
  await startRandomSearch(second.page);

  const firstChatId = await waitForChat(first.page);
  const secondChatId = await waitForChat(second.page);

  return { firstChatId, secondChatId };
}

/** Types a message, sends it, and waits for the sender's own copy to appear. */
export async function sendMessage(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await sendButton(page).click();
  await expect(transcript(page)).toContainText(text);
}

/** Waits for a message to arrive in the transcript. */
export async function expectMessage(page: Page, text: string): Promise<void> {
  await expect(transcript(page)).toContainText(text, { timeout: 20_000 });
}

/** Switches to the "write by User ID" tab. */
export async function openDirectTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'По User ID', exact: true }).click();
}

/** Switches to the settings tab. */
export async function openSettingsTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Настройки', exact: true }).click();
}

/** Looks a User ID up: switch to the tab, type it, press the check button. */
export async function lookupUser(page: Page, publicId: string): Promise<void> {
  await openDirectTab(page);
  await page.locator('#target-user-id').fill(publicId);
  await page.getByRole('button', { name: 'Проверить', exact: true }).click();
}

/**
 * Fails the test if the page logged a console error or threw.
 *
 * Worth asserting explicitly: a React key warning or a failed socket handshake does not
 * make a visible assertion fail, but it is exactly the kind of defect a manual pass
 * misses.
 */
export function expectNoClientErrors(identity: Identity): void {
  expect(identity.errors, `console output of ${identity.publicId}`).toEqual([]);
}
