import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { RateLimit } from '../common/security/rate-limit.guard.js';
import { auditQuerySchema, type AuditQuery } from './audit.dto.js';
import { AuditService } from './audit.service.js';
@Controller('api/audit')
export class AuditController {
  constructor(
    @Inject(AuditService)
    private readonly auditService: AuditService,
  ) {}
  @RateLimit('reports')
  @Get()
  async audit(
    @Req()
    req: AuthRequest,
    @Query(new ZodValidationPipe(auditQuerySchema))
    query: AuditQuery,
  ) {
    return await this.auditService.auditHistory(
      req.actor,
      query.recordId,
      query,
    );
  }
}
