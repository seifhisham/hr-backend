import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { parse } from '../common/validation/parse.js';
import { BranchesService } from './branches.service.js';
import { assignmentSchema, branchSchema, grantsSchema } from './branch.dto.js';
@Controller('api')
export class BranchesController {
  constructor(
    @Inject(BranchesService) private readonly branches: BranchesService,
  ) {}
  @Get('branches') list(@Req() req: AuthRequest) {
    return this.branches.list(req.actor);
  }
  @Post('branches') create(@Req() req: AuthRequest, @Body() input: unknown) {
    return this.branches.save(req.actor, parse(branchSchema, input));
  }
  @Patch('branches/:id') update(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.branches.save(
      req.actor,
      parse(branchSchema, input),
      parse(z.uuid(), id),
    );
  }
  @Get('hr-accounts') accounts(@Req() req: AuthRequest) {
    return this.branches.hrAccounts(req.actor);
  }
  @Get('hr-accounts/:id/branches') grants(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.branches.grants(req.actor, parse(z.uuid(), id));
  }
  @Patch('hr-accounts/:id/branches') setGrants(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.branches.setGrants(
      req.actor,
      parse(z.uuid(), id),
      parse(grantsSchema, input),
    );
  }
  @Get('employees/:id/branches') history(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.branches.history(req.actor, parse(z.uuid(), id));
  }
  @Post('employees/:id/branches') assign(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.branches.assign(
      req.actor,
      parse(z.uuid(), id),
      parse(assignmentSchema, input),
    );
  }
}
