import { PERSONAL_ROUTE } from '../common/decorators/personal.decorator.js';
import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { defer, lastValueFrom } from 'rxjs';
import { DatabaseService } from './database.service.js';
import type { Response } from 'express';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { tokenHash } from '../common/security/credentials.js';

@Injectable()
export class CompanyInterceptor implements NestInterceptor {
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
  ) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const actor = request.actor;
    if (!actor) return next.handle();
    const personal = Reflect.getMetadata(
      PERSONAL_ROUTE,
      context.getHandler(),
    ) as boolean | string | undefined;
    return defer(() =>
      this.store
        .withSession(
          actor,
          tokenHash(request.sessionToken),
          () => lastValueFrom(next.handle()),
          !!personal,
          personal !== 'session-change',
        )
        .catch((error: unknown) => {
          const response = context.switchToHttp().getResponse<Response>();
          if (!response.headersSent) {
            response.removeHeader('Content-Encoding');
            response.removeHeader('Content-Length');
            response.removeHeader('Content-Disposition');
          }
          throw error;
        }),
    );
  }
}
