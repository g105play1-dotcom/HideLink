/**
 * The owner's archive page, from the suite's point of view.
 *
 * The owner is a role of its own: a browser context with no anonymous identity, a page at
 * `/admin`, and the key pinned for this stack (`E2E_ADMIN_TOKEN`). Keeping that in one
 * helper means a spec never has to know how the key travels.
 *
 * `resetArchive` goes straight to the API instead of clicking through the page, on purpose:
 * a spec that fails halfway must still leave the test database clean, and a cleanup that
 * depends on the interface under test is not a cleanup. The integration suite's
 * `persistence.test.ts` asserts that a default installation stores nothing, and it runs
 * against the same `*_test` database — so a leftover row here would fail a suite that has
 * nothing to do with this one.
 */
import { DEFAULT_ARCHIVE_POLICY, type AdminPlatformView } from '@anonlink/shared';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { E2E_ADMIN_TOKEN, E2E_API_BASE } from '../env';

export interface OwnerSession {
  /** A context of its own, so no user's session cookie can leak into the owner's page. */
  context: BrowserContext;
  page: Page;
}

/** Opens `/admin` in a fresh context. It does not sign in. */
export async function openOwnerPage(browser: Browser): Promise<OwnerSession> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/admin');

  return { context, page };
}

/** Types the key and waits for the policy form that only a signed-in owner sees. */
export async function signIn(page: Page, token: string = E2E_ADMIN_TOKEN): Promise<void> {
  await page.getByLabel('Ключ', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Открыть архив', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Что сохранять' })).toBeVisible();
}

/** Checks the "Хранить переписку" switch without saving it. */
export async function setStorageSwitch(page: Page, enabled: boolean): Promise<void> {
  const toggle = page.getByLabel('Хранить переписку', { exact: true });
  await toggle.setChecked(enabled);
}

/**
 * Saves the form and proves the *server* kept it.
 *
 * The status line alone is not enough: react-query keeps `isSuccess` after a save, so a
 * second save in the same page would see a stale "Сохранено." and pass even if it failed.
 * The reload clears that transient state and makes the assertion about what was stored.
 *
 * The locator is narrowed by text on purpose. `role="status"` is not unique on this page —
 * the archive card uses it for "Пока ничего не сохранено" and for the deletion report — and
 * `getByText` matches substrings, so a bare "Сохранено." also matches "…уже сохранено" in
 * another card's description. A strict-mode failure here would look like a broken save.
 */
export async function savePolicy(page: Page, expected: { enabled: boolean }): Promise<void> {
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Сохранено.' })).toBeVisible();

  await page.reload();

  const toggle = page.getByLabel('Хранить переписку', { exact: true });
  if (expected.enabled) await expect(toggle).toBeChecked();
  else await expect(toggle).not.toBeChecked();
}

/** The messages of an opened transcript. */
export function archiveTranscript(page: Page) {
  return page.locator('ol');
}

/** The owner's API, without a browser. Used for teardown only. */
async function ownerApi(path: string, init: RequestInit = {}): Promise<void> {
  const response = await fetch(`${E2E_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${E2E_ADMIN_TOKEN}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`[e2e] owner API ${path} answered ${response.status}`);
  }
}

/**
 * Sets the platform-wide policy.
 *
 * Used by the stack fixture (most specs test blocking mechanics, not the shipped default)
 * and by the moderation spec's teardown. Goes straight to the API: a cleanup that depends
 * on the interface under test is not a cleanup. The endpoint is a full replace, so the
 * current switches are read first and only the requested ones are changed.
 */
export async function setPlatformPolicy(update: Partial<AdminPlatformView>): Promise<void> {
  const response = await fetch(`${E2E_API_BASE}/admin/platform`, {
    headers: { authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`[e2e] owner API GET /admin/platform answered ${response.status}`);
  }
  const current = (await response.json()) as AdminPlatformView;

  await ownerApi('/admin/platform', {
    method: 'PUT',
    body: JSON.stringify({ ...current, ...update }),
  });
}

export async function setBlockingPolicy(blockingEnabled: boolean): Promise<void> {
  await setPlatformPolicy({ blockingEnabled });
}

/** Puts the archive back to the shipped default: switched off, and empty. */
export async function resetArchive(): Promise<void> {
  await ownerApi('/admin/policy', {
    method: 'PUT',
    body: JSON.stringify({ ...DEFAULT_ARCHIVE_POLICY, enabled: false }),
  });

  await ownerApi('/admin/archives/delete-all', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });
}

/**
 * Empties the owner's inbox ("Сообщения от пользователей").
 *
 * Teardown only, for the same reason `resetArchive` exists: the inbox is global state, and
 * the integration suite's `persistence.test.ts` runs against the same database. A spec that
 * fails halfway must still leave it clean.
 */
export async function resetInbox(): Promise<void> {
  const response = await fetch(`${E2E_API_BASE}/admin/messages`, {
    headers: { authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
  });

  if (!response.ok) {
    throw new Error(`[e2e] owner API /admin/messages answered ${response.status}`);
  }

  const body = (await response.json()) as { messages: Array<{ id: string }> };
  for (const message of body.messages) {
    await ownerApi(`/admin/messages/${message.id}`, { method: 'DELETE' });
  }
}
