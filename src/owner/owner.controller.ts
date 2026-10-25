import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
  SetMetadata,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public } from '../common/decorators/public.decorator.js';
import { parse } from '../common/validation/parse.js';
import { OwnerService, type OwnerIdentity } from './owner.service.js';
import {
  ownerLoginSchema,
  ownerRecoverySchema,
  setupTokenSchema,
  ownerSetupSchema,
  createCompanySchema,
  invitationSchema,
  reasonSchema,
  statusSchema,
  branchLimitSchema,
  acceptInvitationSchema,
} from './owner.dto.js';
export const OWNER_ROUTE = 'platform_owner_route';
export const OWNER_COOKIE = 'hr_owner_session';
export type OwnerRequest = Request & {
  owner: OwnerIdentity;
  ownerToken: string;
};
@Controller('api/owner')
@SetMetadata(OWNER_ROUTE, true)
export class OwnerController {
  constructor(@Inject(OwnerService) private readonly owner: OwnerService) {}
  @Public() @Post('login') async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.owner.login(parse(ownerLoginSchema, body));
    res.setHeader('Cache-Control', 'no-store');
    res.cookie(OWNER_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/api/owner',
      maxAge: 4 * 3600000,
    });
    return result;
  }
  @Get('me') me(@Req() req: OwnerRequest) {
    return req.owner;
  }
  @Post('logout') async logout(
    @Req() req: OwnerRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.owner.command(req.ownerToken, 'logout');
    res.clearCookie(OWNER_COOKIE, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/api/owner',
    });
    return result;
  }
  @Public() @Post('setup/prepare') prepare(@Body() body: unknown) {
    return this.owner.prepareSetup(parse(setupTokenSchema, body).token);
  }
  @Public() @Post('setup/complete') complete(@Body() body: unknown) {
    return this.owner.completeSetup(parse(ownerSetupSchema, body));
  }
  @Post('recovery') recovery(@Req() req: OwnerRequest, @Body() body: unknown) {
    return this.owner.recovery(
      req.ownerToken,
      parse(ownerRecoverySchema, body),
    );
  }
  @Get('companies') companies(@Req() req: OwnerRequest) {
    return this.owner.command(req.ownerToken, 'companies');
  }
  @Post('companies') create(@Req() req: OwnerRequest, @Body() body: unknown) {
    return this.owner.createCompany(
      req.ownerToken,
      parse(createCompanySchema, body),
    );
  }
  @Post('companies/:id/invitation') invite(
    @Req() req: OwnerRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.owner.invitation(
      req.ownerToken,
      parse(z.uuid(), id),
      parse(invitationSchema, body).requestId,
    );
  }
  @Post('companies/:id/revoke-invitation') revoke(
    @Req() req: OwnerRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.owner.command(req.ownerToken, 'revoke-invitation', {
      companyId: parse(z.uuid(), id),
      ...parse(reasonSchema, body),
    });
  }
  @Post('companies/:id/status') status(
    @Req() req: OwnerRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.owner.command(req.ownerToken, 'status', {
      companyId: parse(z.uuid(), id),
      ...parse(statusSchema, body),
    });
  }
  @Get('audit') audit(@Req() req: OwnerRequest) {
    return this.owner.command(req.ownerToken, 'audit');
  }
  @Post('companies/:id/branch-limit') branchLimit(
    @Req() req: OwnerRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.owner.command(req.ownerToken, 'branch-limit', {
      companyId: parse(z.uuid(), id),
      ...parse(branchLimitSchema, body),
    });
  }
}
@Controller('api/onboarding')
export class OnboardingController {
  constructor(@Inject(OwnerService) private readonly owner: OwnerService) {}
  @Public() @Post('preview') preview(@Body() body: unknown) {
    return this.owner.invitationPreview(parse(setupTokenSchema, body).token);
  }
  @Public() @Post('accept') accept(@Body() body: unknown) {
    return this.owner.acceptInvitation(parse(acceptInvitationSchema, body));
  }
}
