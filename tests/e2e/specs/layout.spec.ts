import { expect, test, type Page } from '@playwright/test';

import { closeSettings, newIdentity, openSettings, settingsToggle } from '../support/app';

/**
 * The one page, at the width of a phone.
 *
 * The interface is a single responsive layout, not a desktop version and a separate mobile
 * one (docs/DECISIONS.md D22), so the two things that can silently break on a narrow
 * screen are worth pinning end to end:
 *
 *   1. **Nothing overflows sideways.** A single element wider than the viewport — a fixed
 *      rail, a long monospace ID in a non-shrinking box, a two-column grid — makes the
 *      whole page scroll horizontally, and it is invisible on the machine the layout was
 *      written on.
 *   2. **The controls the user needs are all reachable.** The identity, the field for the
 *      peer's User ID, the call to action and the settings disclosure.
 *
 * The reserved advertising columns are *not* part of this: they are hidden below the `xl`
 * breakpoint on purpose, and the assertion for that is the absence of the overflow itself.
 */
test.use({ viewport: { width: 390, height: 844 } });

/** Whoever is wider than the window, or `null`. Reported so a failure names the culprit. */
async function horizontalOverflow(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= viewport + 1) return null;

    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      const box = element.getBoundingClientRect();
      if (box.right > viewport + 1 || box.left < -1) {
        return `${element.tagName.toLowerCase()}.${element.className} → right=${Math.round(box.right)}`;
      }
    }

    return 'unknown element';
  });
}

test.describe('the one page on a phone-sized screen', () => {
  test('shows every control and never scrolls sideways', async ({ browser }) => {
    const alice = await newIdentity(browser);

    await expect(alice.page.locator('#own-user-id')).toBeVisible();
    await expect(alice.page.locator('#target-user-id')).toBeVisible();
    await expect(
      alice.page.getByRole('button', { name: 'Найти собеседника', exact: true }),
    ).toBeVisible();
    await expect(settingsToggle(alice.page)).toBeVisible();

    expect(await horizontalOverflow(alice.page), 'the idle page overflows sideways').toBeNull();

    // The settings are the densest part of the page — two columns side by side on a wide
    // screen — so they are where a narrow layout breaks first.
    await openSettings(alice.page);
    await expect(alice.page.getByRole('heading', { name: 'О вас' })).toBeVisible();
    await expect(alice.page.getByRole('heading', { name: 'Кого искать' })).toBeVisible();

    expect(
      await horizontalOverflow(alice.page),
      'the settings overflow sideways on a phone',
    ).toBeNull();

    await expect(alice.page.locator('#profile-age')).toBeVisible();
    await expect(alice.page.getByRole('button', { name: 'Сохранить фильтры' })).toBeVisible();

    await closeSettings(alice.page);
    expect(await horizontalOverflow(alice.page), 'the page overflows after closing').toBeNull();
  });
});
