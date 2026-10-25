import { DatabaseService } from '../database/database.service.js';
import { Personal } from '../common/decorators/personal.decorator.js';
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
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(AuthService)
    private readonly authService: AuthService,
    @Inject(EmployeesService)
    private readonly employeesService: EmployeesService,
    @Inject(CompanyService)
    private readonly companyService: CompanyService,
  ) {}
  @Public()
  @Post('login')
  async login(
    @Body(new ZodValidationPipe(loginSchema))
    body: LoginDto,
    @Res({ passthrough: true })
    res: Response,
  ) {
    const { token, user } = await this.authService.login(
      body.email,
      body.password,
      body.workspace,
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
  @Post('logout')
  @Personal(true)
  async logout(
    @Req()
    req: AuthRequest,
    @Res({ passthrough: true })
    res: Response,
  ) {
    await this.authService.logout(req.sessionToken);
    res.clearCookie(SESSION_COOKIE, {
      path: '/api',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
    return { message: 'Signed out' };
  }
  @Get('me')
  @Personal()
  async me(
    @Req()
    req: AuthRequest,
  ) {
    const registry = await this.store
      .prepare('SELECT id,workspace_code,status FROM companies')
      .get();
    const hrBranchIds =
      req.actor.role === 'hr'
        ? (
            await this.store
              .prepare(
                'SELECT branch_id FROM hr_branch_grants WHERE user_id=? ORDER BY branch_id',
              )
              .all(req.actor.id)
          ).map((row) => row.branch_id as string)
        : [];
    const employee = await this.employeesService.profile(req.actor);
    const company = await this.companyService.settings();
    const branch = employee?.branchId
      ? await this.store
          .prepare('SELECT policy FROM branches WHERE id=?')
          .get(employee.branchId)
      : null;
    const personalCompany = branch
      ? {
          ...company,
          ...JSON.parse(branch.policy as string),
          name: company.name,
          timezone: company.timezone,
        }
      : company;
    return {
      companyId: registry!.id,
      workspace: registry!.workspace_code,
      companyStatus: registry!.status,
      hrBranchIds,
      user: req.actor,
      employee,
      company: personalCompany,
      today: localTime(
        new Date(),
        (await this.companyService.settings()).timezone,
      ).date,
    };
  }
  @RateLimit('passwords')
  @Post('password')
  @Personal(true)
  async password(
    @Req()
    req: AuthRequest,
    @Body(new ZodValidationPipe(changePasswordSchema))
    body: ChangePasswordDto,
  ) {
    return await this.authService.changePassword(
      req.actor,
      body.currentPassword,
      body.newPassword,
    );
  }
}
