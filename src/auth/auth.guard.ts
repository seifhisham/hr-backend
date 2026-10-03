import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PUBLIC_ROUTE_KEY } from '../common/decorators/public.decorator.js';
import { SESSION_COOKIE } from './auth.constants.js';
import { AuthService } from './auth.service.js';
import type { AuthRequest } from './types/auth-request.type.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      const allowed = (
        process.env.HR_ALLOWED_ORIGINS ?? 'http://localhost:3003'
      )
        .split(',')
        .map((v) => v.trim());
      if (origin && !allowed.includes(origin))
        throw new ForbiddenException('Origin is not allowed');
      if (req.headers['sec-fetch-site'] === 'cross-site')
        throw new ForbiddenException('Cross-site requests are not allowed');
    }
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const bearer = req.headers.authorization;
    const cookie = req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    req.sessionToken = bearer?.startsWith('Bearer ')
      ? bearer.slice(7)
      : (cookie ?? '');
    req.actor = this.authService.authenticate(req.sessionToken);
    return true;
  }
}
