import { expect, test, type Page } from '@playwright/test';

import {
  cancelSearchButton,
  chatCard,
  closeSettings,
  expectNoClientErrors,
  newIdentity,
  openSettings,
  startRandomSearch,
  waitForChat,
} from '../support/app';

/**
 * Filtered search, end to end: the settings screen, the server's matching, and what the
 * waiting screen is allowed to claim.
 *
 * The unit tests pin the filter arithmetic and the integration tests pin the server's use
 * of it. What is left — and what only a browser can show — is that the interface reports
 * the criteria the *server* is applying, says so loudly when the server widens the search,
 * and that changing a filter really changes who you meet.
 */

/** Picks a declared gender in the "what the search knows about you" card. */
async function declareGender(page: Page, label: string): Promise<void> {
  await page
    .getByRole('group', { name: 'Ваш пол', exact: true })
    .getByRole('button', { name: label, exact: true })
    .click();
}

/** Toggles one gender in the "who to look for" card. */
async function togglePartnerGender(page: Page, label: string): Promise<void> {
  await page
    .getByRole('group', { name: 'Пол собеседника', exact: true })
    .getByRole('button', { name: label, exact: true })
    .click();
}

async function saveProfile(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Сохранить данные', exact: true }).click();
  await expect(page.getByText('Данные о себе сохранены.')).toBeVisible();
}

async function saveFilters(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Сохранить фильтры', exact: true }).click();
  await expect(page.getByText('Фильтры поиска сохранены.')).toBeVisible();
}

test.describe('filtered search', () => {
  test('a long search widens visibly, and then meets the peer it had just excluded', async ({
    browser,
  }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);

    // Alice says she is a woman and wants to meet women.
    await openSettings(alice.page);
    await declareGender(alice.page, 'Женский');
    await saveProfile(alice.page);
    await togglePartnerGender(alice.page, 'Женский');

    // She allows widening. This is a permission, not an instruction: nothing happens until
    // the server's own timing decides the wait has been long enough.
    const relaxToggle = alice.page.getByRole('button', {
      name: 'Снимать фильтры по одному',
      exact: true,
    });
    await expect(relaxToggle).toHaveAttribute('aria-pressed', 'false');
    await relaxToggle.click();
    await expect(relaxToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(alice.page.getByText('Разрешено', { exact: true })).toBeVisible();
    await saveFilters(alice.page);

    // The idle search screen states what a search would apply. The settings have to be
    // closed for that: their "будет применяться" preview says the same thing, and two
    // elements with the same text would be ambiguous — to the test and to a reader.
    await closeSettings(alice.page);
    await expect(alice.page.getByText('Пол: Женский')).toBeVisible();

    await startRandomSearch(alice.page);
    await expect(alice.page.getByText('Ищем по фильтрам')).toBeVisible();
    await expect(alice.page.getByText('Пол: Женский')).toBeVisible();

    // Nobody else is looking, so the only thing that can happen is the server dropping the
    // filter — after the configured wait, and saying exactly what it dropped. Silence here
    // would be the bug: it would mean a partner could later appear who was filtered out.
    await expect(alice.page.getByRole('status').filter({ hasText: 'Уже снято: пол' })).toBeVisible({
      timeout: 25_000,
    });
    await expect(alice.page.getByText(/Ищем шире: снят фильтр «пол»/)).toBeVisible();

    // Bob is a man: exactly the peer the filter excluded a moment ago. Alice now accepts
    // anyone, so the two must meet.
    await openSettings(bob.page);
    await declareGender(bob.page, 'Мужской');
    await saveProfile(bob.page);
    await closeSettings(bob.page);

    await startRandomSearch(bob.page);

    const aliceChatId = await waitForChat(alice.page);
    const bobChatId = await waitForChat(bob.page);
    expect(bobChatId).toBe(aliceChatId);

    expectNoClientErrors(alice);
    expectNoClientErrors(bob);
  });

  test('a filter keeps two waiting users apart until it is removed', async ({ browser }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);

    // Alice wants to meet men; Bob is a woman. Widening is left at its default (off).
    await openSettings(alice.page);
    await togglePartnerGender(alice.page, 'Мужской');
    await saveFilters(alice.page);
    await closeSettings(alice.page);

    await openSettings(bob.page);
    await declareGender(bob.page, 'Женский');
    await saveProfile(bob.page);
    await closeSettings(bob.page);

    await startRandomSearch(alice.page);
    await startRandomSearch(bob.page);

    // Nothing may happen: the filter is enforced by the server, and widening was not
    // allowed. A fixed wait is the only way to assert an absence.
    await alice.page.waitForTimeout(3_000);
    await expect(chatCard(alice.page)).toHaveCount(0);
    await expect(chatCard(bob.page)).toHaveCount(0);
    await expect(cancelSearchButton(alice.page)).toBeVisible();

    // Alice changes her mind, removes the filter, and searches again — Bob is still waiting.
    await cancelSearchButton(alice.page).click();
    await openSettings(alice.page);
    await togglePartnerGender(alice.page, 'Мужской');
    await saveFilters(alice.page);
    await closeSettings(alice.page);
    await startRandomSearch(alice.page);

    const aliceChatId = await waitForChat(alice.page);
    const bobChatId = await waitForChat(bob.page);
    expect(bobChatId).toBe(aliceChatId);

    expectNoClientErrors(alice);
    expectNoClientErrors(bob);
  });

  test('every filter row offers an explicit "Любой", and it really clears the filter', async ({
    browser,
  }) => {
    const alice = await newIdentity(browser);
    await openSettings(alice.page);

    const panel = alice.page.locator('#settings-panel');
    const genderRow = panel.getByRole('group', { name: 'Пол собеседника', exact: true });
    const placeRow = panel.getByRole('group', { name: 'Где искать', exact: true });

    // The neutral state is a pressed button, not an empty row of chips: an empty row
    // reads as an unfinished form rather than as a decision (docs/DECISIONS.md D22).
    await expect(genderRow.getByRole('button', { name: 'Любой', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(placeRow.getByRole('button', { name: 'Любой', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Two cities and a region at once is the point of the row being a list rather than a
    // choice: each is typed by hand and kept as its own chip.
    await togglePartnerGender(alice.page, 'Женский');

    const cities = placeRow.getByLabel('Города', { exact: true });
    const regions = placeRow.getByLabel('Регионы', { exact: true });

    await cities.fill('Москва');
    await cities.press('Enter');
    await cities.fill('Казань');
    await placeRow.getByRole('button', { name: 'Добавить город', exact: true }).click();
    await regions.fill('Татарстан');
    await regions.press('Enter');

    await expect(
      placeRow.getByRole('button', { name: 'Убрать Москва', exact: true }),
    ).toBeVisible();
    await expect(
      placeRow.getByRole('button', { name: 'Убрать Татарстан', exact: true }),
    ).toBeVisible();
    await expect(placeRow.getByRole('button', { name: 'Любой', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await saveFilters(alice.page);
    await closeSettings(alice.page);

    // The applied filters come from the server, so this is the round trip and not the form.
    await expect(alice.page.getByText('Пол: Женский')).toBeVisible();
    await expect(alice.page.getByText('Города: Москва, Казань')).toBeVisible();
    await expect(alice.page.getByText('Регионы: Татарстан')).toBeVisible();

    await openSettings(alice.page);
    await genderRow.getByRole('button', { name: 'Любой', exact: true }).click();
    await placeRow.getByRole('button', { name: 'Любой', exact: true }).click();
    await expect(placeRow.getByRole('button', { name: 'Убрать Москва', exact: true })).toHaveCount(
      0,
    );

    await saveFilters(alice.page);
    await closeSettings(alice.page);

    await expect(alice.page.getByText('Без фильтров — подойдёт любой собеседник.')).toBeVisible();
    await expect(alice.page.getByText('Пол: Женский')).toHaveCount(0);
    await expect(alice.page.getByText('Города: Москва, Казань')).toHaveCount(0);
    await expect(alice.page.getByText('Регионы: Татарстан')).toHaveCount(0);

    expectNoClientErrors(alice);
  });

  test('an impossible age range is refused in the interface before it is sent', async ({
    browser,
  }) => {
    const alice = await newIdentity(browser);
    await openSettings(alice.page);

    const saveButton = alice.page.getByRole('button', { name: 'Сохранить фильтры', exact: true });
    await expect(saveButton).toBeEnabled();

    await alice.page.getByLabel('Минимальный возраст', { exact: true }).fill('40');
    await alice.page.getByLabel('Максимальный возраст', { exact: true }).fill('30');

    // A range nobody can satisfy looks exactly like a broken search, so it is refused
    // before the request rather than stored and silently matching no one.
    await expect(
      alice.page.getByText('Нижняя граница возраста больше верхней', { exact: false }),
    ).toBeVisible();
    await expect(saveButton).toBeDisabled();

    await alice.page.getByLabel('Максимальный возраст', { exact: true }).fill('50');
    await expect(saveButton).toBeEnabled();

    expectNoClientErrors(alice);
  });

  test('a declared gender is withdrawn by pressing it again, and the withdrawal survives a reload', async ({
    browser,
  }) => {
    const alice = await newIdentity(browser);
    await openSettings(alice.page);

    const group = alice.page.getByRole('group', { name: 'Ваш пол', exact: true });
    const female = group.getByRole('button', { name: 'Женский', exact: true });

    // Two buttons and no «Не указывать» (the owner's rule, 2026-10-20): the pressed one is
    // the only way back to "not stated", so pressing it again must really clear it.
    await female.click();
    await expect(female).toHaveAttribute('aria-pressed', 'true');
    await saveProfile(alice.page);

    await alice.page.reload();
    await openSettings(alice.page);
    await expect(female).toHaveAttribute('aria-pressed', 'true');

    await female.click();
    await expect(female).toHaveAttribute('aria-pressed', 'false');
    await saveProfile(alice.page);

    await alice.page.reload();
    await openSettings(alice.page);
    await expect(female).toHaveAttribute('aria-pressed', 'false');

    expectNoClientErrors(alice);
  });
});
