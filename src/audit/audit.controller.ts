import { payrollMonthSchema } from '../payroll/dto/deduction.dto.js';
import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { parse } from '../common/validation/parse.js';
import { AuditService } from './audit.service.js';

@Controller('api/audit')
export class AuditController {
  constructor(
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}
  @Get() audit(@Req() req: AuthRequest, @Query('recordId') id?: string) {
    return this.auditService.auditHistory(
      req.actor,
      id ? parse(z.union([z.uuid(), payrollMonthSchema]), id) : undefined,
    );
  }
}
