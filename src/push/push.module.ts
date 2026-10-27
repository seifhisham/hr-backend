import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { FirebaseSender } from './firebase-sender.js';
import { PushController } from './push.controller.js';
import { PushWorker } from './push.worker.js';

@Module({
  imports: [DatabaseModule, NotificationsModule],
  controllers: [PushController],
  providers: [FirebaseSender, PushWorker],
})
export class PushModule {}
