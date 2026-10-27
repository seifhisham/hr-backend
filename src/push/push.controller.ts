import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { Personal } from '../common/decorators/personal.decorator.js';
import { tokenHash } from '../common/security/credentials.js';
import { RateLimit } from '../common/security/rate-limit.guard.js';
import { parse } from '../common/validation/parse.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { DatabaseService } from '../database/database.service.js';

export const deviceSchema = z
  .object({
    deviceId: z.uuid(),
    token: z.string().min(20).max(4096).regex(/^\S+$/),
    platform: z.literal('android'),
  })
  .strict();
type DeviceInput = z.infer<typeof deviceSchema>;

@Controller('api/push/devices')
export class PushController {
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
  ) {}

  @Post()
  @HttpCode(200)
  @Personal()
  @RateLimit('push')
  async register(
    @Req() req: AuthRequest,
    @Body(new ZodValidationPipe(deviceSchema)) body: DeviceInput,
  ) {
    await this.store.transaction(() =>
      this.store
        .prepare('SELECT hr_register_push(?,?,?)')
        .get(tokenHash(req.sessionToken), body.deviceId, body.token),
    );
    return { deviceId: body.deviceId, platform: 'android' as const };
  }

  @Delete(':deviceId')
  @HttpCode(204)
  @Personal()
  @RateLimit('push')
  async unregister(@Req() req: AuthRequest, @Param('deviceId') id: string) {
    await this.store
      .prepare(
        'DELETE FROM push_devices WHERE device_id=? AND user_id=? AND session_hash=?',
      )
      .run(parse(z.uuid(), id), req.actor.id, tokenHash(req.sessionToken));
  }
}
