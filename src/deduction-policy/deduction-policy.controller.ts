import { Body, Controller, Get, Inject, Put, Req } from '@nestjs/common';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import {
  updateDeductionPolicySchema,
  type UpdateDeductionPolicyDto,
} from './deduction-policy.js';
import { DeductionPolicyService } from './deduction-policy.service.js';

@Controller('api/deduction-policy')
export class DeductionPolicyController {
  constructor(
    @Inject(DeductionPolicyService)
    private readonly policyService: DeductionPolicyService,
  ) {}
  @Get()
  async view(@Req() req: AuthRequest) {
    return await this.policyService.view(req.actor);
  }
  @Put()
  async update(
    @Req() req: AuthRequest,
    @Body(new ZodValidationPipe(updateDeductionPolicySchema))
    body: UpdateDeductionPolicyDto,
  ) {
    return await this.policyService.update(req.actor, body);
  }
}
