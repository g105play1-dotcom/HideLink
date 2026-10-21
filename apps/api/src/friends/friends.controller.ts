import { Controller, Delete, Get, Param } from '@nestjs/common';
import { userLookupParamsSchema, type FriendListResponse } from '@anonlink/shared';

import { zodParam } from '../common/zod-validation.pipe.js';
import { AppEventBus } from '../events/app-events.js';
import { CurrentIdentity } from '../identity/request-context.js';
import type { AuthenticatedIdentity } from '../identity/identity.service.js';
import { FriendsService } from './friends.service.js';

/**
 * The caller's own friend list.
 *
 * There is deliberately no endpoint that looks at somebody else's list, and no
 * endpoint that adds a friend directly: a friendship is only created by the mutual
 * in-chat flow in `ChatService`. REST can only read the result and remove a row.
 */
@Controller('friends')
export class FriendsController {
  constructor(
    private readonly friends: FriendsService,
    private readonly bus: AppEventBus,
  ) {}

  /** Everything this identity has agreed to, newest first. */
  @Get()
  async list(@CurrentIdentity() identity: AuthenticatedIdentity): Promise<FriendListResponse> {
    return { friends: await this.friends.list(identity.userId) };
  }

  /**
   * Removes a friend, one-sidedly and immediately.
   *
   * The other side is told so an open tab does not keep showing a contact that no
   * longer exists. The caller learns nothing about whether the User ID exists or was a
   * friend: `removed` is `false` for both cases.
   */
  @Delete(':publicId')
  async remove(
    @CurrentIdentity() identity: AuthenticatedIdentity,
    @Param(zodParam(userLookupParamsSchema)) params: { publicId: string },
  ): Promise<{ removed: boolean }> {
    const result = await this.friends.remove(identity.userId, params.publicId);

    if (result.removed && result.otherUserId) {
      this.bus.emit({
        type: 'friend.removed',
        userId: result.otherUserId,
        publicId: identity.publicId,
      });
    }

    return { removed: result.removed };
  }
}
