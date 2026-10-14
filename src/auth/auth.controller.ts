import { RateLimit } from '../common/security/rate-limit.guard.js';
import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { localTime } from '../attendance/attendance-time.js';
import { Public } from '../common/decorators/public.decorator.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { CompanyService } from '../company/company.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import { SESSION_COOKIE } from './auth.constants.js';
import { AuthService } from './auth.service.js';
import {
  changePasswordSchema,
  loginSchema,
  type ChangePasswordDto,
  type LoginDto,
} from './dto/auth.dto.js';
import type { AuthRequest } from './types/auth-request.type.js';

@Controller('api/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(EmployeesService)
    private readonly employeesService: EmployeesService,
    @Inject(CompanyService) private readonly companyService: CompanyService,
  ) {}
  @Public()
  @Post('login')
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, user } = await this.authService.login(
      body.email,
      body.password,
    );
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/api',
      maxAge: 12 * 3600000,
    });
    // Native clients use this token; browser clients use the HttpOnly cookie.
    return { user, token };
  }

  @Post('logout') logout(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.authService.logout(req.sessionToken);
    res.clearCookie(SESSION_COOKIE, {
      path: '/api',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
    return { message: 'Signed out' };
  }

  @Get('me') me(@Req() req: AuthRequest) {
    return {
      user: req.actor,
      employee: this.employeesService.profile(req.actor),
      company: this.companyService.settings(),
      today: localTime(new Date(), this.companyService.settings().timezone)
        .date,
    };
  }

  @RateLimit('passwords')
  @Post('password')
  password(
    @Req() req: AuthRequest,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordDto,
  ) {
    return this.authService.changePassword(
      req.actor,
      body.currentPassword,
      body.newPassword,
    );
  }
}
