import { expect, test } from '@playwright/test';

import { expectNoClientErrors, matchPair, newIdentity } from '../support/app';

/**
 * Friends are the one persistent link a random chat can produce.
 *
 * The test drives the two things the owner asked for: a request that both sides must
 * accept, and a list that survives the conversation and can be cleaned up one-sidedly.
 */
test.describe('friends', () => {
  test('two people become friends in a chat, see each other in the list, and one can remove the contact', async ({
    browser,
  }) => {
    const alice = await newIdentity(browser);
    const bob = await newIdentity(browser);

    await matchPair(alice, bob);

    await alice.page.getByRole('button', { name: 'В друзья', exact: true }).click();

    const dialog = bob.page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toContainText('друзья');
    await dialog.getByRole('button', { name: 'Принять', exact: true }).click();

    await expect(alice.page.getByRole('button', { name: 'Вы друзья', exact: true })).toBeVisible();
    await expect(bob.page.getByRole('button', { name: 'Вы друзья', exact: true })).toBeVisible();

    // Leave the conversation; the friendship is what survives it.
    await bob.page.getByRole('button', { name: 'Завершить', exact: true }).click();
    await alice.page.getByRole('button', { name: 'Готово', exact: true }).click();
    await bob.page.getByRole('button', { name: 'Готово', exact: true }).click();

    const aliceFriends = alice.page.getByRole('list', { name: 'Список друзей' });
    const bobFriends = bob.page.getByRole('list', { name: 'Список друзей' });

    await expect(aliceFriends.getByTitle(bob.publicId)).toBeVisible();
    await expect(bobFriends.getByTitle(alice.publicId)).toBeVisible();

    // Removing is immediate and one-sided. The other tab must not keep a contact that
    // the server has already deleted.
    await alice.page
      .getByRole('button', { name: `Удалить ${bob.publicId} из друзей`, exact: true })
      .click();
    const confirm = alice.page.getByRole('dialog');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Удалить', exact: true }).click();

    await expect(aliceFriends.getByTitle(bob.publicId)).toHaveCount(0);
    await expect(bobFriends.getByTitle(alice.publicId)).toHaveCount(0);

    expectNoClientErrors(alice);
    expectNoClientErrors(bob);

    await alice.context.close();
    await bob.context.close();
  });
});
