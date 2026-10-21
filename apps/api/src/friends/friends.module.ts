import { Module } from '@nestjs/common';

import { FriendRequestService } from './friend-requests.js';
import { FriendsController } from './friends.controller.js';
import { FriendsService } from './friends.service.js';

/**
 * Friendships and the ephemeral requests that create them.
 *
 * No dependency on the chat module: the chat layer imports this one to enforce the
 * rules, which keeps the domain graph pointing in one direction. The request register
 * is deliberately exported alongside the database service because the gateway's session
 * restoration needs to find a pending request after a reload.
 */
@Module({
  controllers: [FriendsController],
  providers: [FriendsService, FriendRequestService],
  exports: [FriendsService, FriendRequestService],
})
export class FriendsModule {}
