import { expect, test, type Page } from '@playwright/test';

import { newIdentity } from '../support/app';

/**
 * The interface language.
 *
 * The owner's rules are all observable from the outside, so they are asserted here
 * rather than in a unit test: Russian by default (not the browser's language), a
 * switch beside the theme switch with native names, persistence in both the cookie
 * and `localStorage`, `<html lang>` and the page title following the choice, and an
 * `/admin` that stays Russian.
 *
 * The browser is created with Playwright's default `en-US` locale on purpose: a
 * default that followed `Accept-Language` would fail the first assertion.
 */
function languageSelect(page: Page) {
  // The only `<select>` in the header, and the one control whose accessible name
  // itself changes with the language. Locating it structurally keeps the helper
  // usable while the label is translated.
  return page.locator('header select');
}

test.describe('interface language', () => {
  test('is Russian by default and switches between all three, persistently', async ({
    browser,
  }) => {
    const alice = await newIdentity(browser);
    const page = alice.page;

    const select = languageSelect(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(select).toHaveValue('ru');
    await expect(select.locator('option')).toHaveText(['Русский', 'English', '中文']);
    await expect(
      page.getByRole('button', { name: 'Найти собеседника', exact: true }),
    ).toBeVisible();

    await select.selectOption('en');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: 'Find someone', exact: true })).toBeVisible();
    await expect(page.getByText('Anonymous chat with strangers')).toBeVisible();
    await expect(page.getByLabel('Interface language')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Найти собеседника', exact: true })).toHaveCount(
      0,
    );

    await expect.poll(() => page.evaluate(() => document.cookie)).toContain('anonlink.locale=en');
    expect(await page.evaluate(() => localStorage.getItem('anonlink.locale'))).toBe('en');

    // A reload is the real test of persistence: the server reads only the cookie and
    // renders the title and `<html lang>` before React runs.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: 'Find someone', exact: true })).toBeVisible();
    await expect(page).toHaveTitle('AnonLink — anonymous chat');

    await page.locator('header select').selectOption('zh');

    await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
    await expect(page.getByRole('button', { name: '寻找聊天对象', exact: true })).toBeVisible();
    await expect(page.getByText('与陌生人的匿名聊天')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Найти собеседника', exact: true })).toHaveCount(
      0,
    );

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
    await expect(page).toHaveTitle('AnonLink — 匿名聊天');

    await page.locator('header select').selectOption('ru');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(
      page.getByRole('button', { name: 'Найти собеседника', exact: true }),
    ).toBeVisible();
  });

  test('leaves the owner page in Russian when the interface is English', async ({ browser }) => {
    const alice = await newIdentity(browser);

    await languageSelect(alice.page).selectOption('en');
    await expect
      .poll(() => alice.page.evaluate(() => document.cookie))
      .toContain('anonlink.locale=en');

    await alice.page.goto('/admin');

    await expect(alice.page.getByRole('heading', { name: 'Архив переписок' })).toBeVisible();
    await expect(alice.page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(alice.page.getByRole('button', { name: 'Открыть архив' })).toBeVisible();
  });
});
