import { Controller, Get, Inject, Param, Patch, Req } from '@nestjs/common';
import { z } from 'zod';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { parse } from '../common/validation/parse.js';
import { NotificationsService } from './notifications.service.js';

@Controller('api/notifications')
export class NotificationsController {
  constructor(
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
  ) {}
  @Get() list(@Req() req: AuthRequest) {
    return this.notifications.list(req.actor);
  }
  @Patch(':id/read') markRead(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.notifications.markRead(
      req.actor,
      parse(z.string().min(1).max(200), id),
    );
  }
}
