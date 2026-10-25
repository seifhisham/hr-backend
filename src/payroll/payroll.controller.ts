import { RateLimit } from '../common/security/rate-limit.guard.js';
import {
  payrollApprovalSchema,
  type ApprovePayrollDto,
} from './dto/approval.dto.js';
import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import {
  deductionSchema,
  deductionRangeSchema,
  payrollMonthSchema,
  type AddDeductionDto,
} from './dto/deduction.dto.js';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { parse } from '../common/validation/parse.js';
import { PayrollService } from './payroll.service.js';
@Controller('api/payroll')
export class PayrollController {
  constructor(
    @Inject(PayrollService)
    private readonly payrollService: PayrollService,
  ) {}
  @RateLimit('reports')
  @Get()
  async preview(
    @Req()
    req: AuthRequest,
    @Query('month')
    month: unknown,
  ) {
    return await this.payrollService.preview(
      req.actor,
      parse(payrollMonthSchema, month),
    );
  }
  @RateLimit('reports')
  @Get('run')
  async run(
    @Req()
    req: AuthRequest,
    @Query('month')
    month: unknown,
  ) {
    return await this.payrollService.run(
      req.actor,
      parse(payrollMonthSchema, month),
    );
  }
  @Post('approve')
  async approve(
    @Req()
    req: AuthRequest,
    @Body(new ZodValidationPipe(payrollApprovalSchema))
    body: ApprovePayrollDto,
  ) {
    return await this.payrollService.approve(req.actor, body);
  }
  @RateLimit('reports')
  @Get('deductions')
  async deductions(
    @Req()
    req: AuthRequest,
    @Query()
    query: unknown,
  ) {
    return await this.payrollService.deductions(
      req.actor,
      parse(deductionRangeSchema, query),
    );
  }
  @Post('deductions')
  async addDeduction(
    @Req()
    req: AuthRequest,
    @Body(new ZodValidationPipe(deductionSchema))
    body: AddDeductionDto,
  ) {
    return await this.payrollService.addDeduction(req.actor, body);
  }
}
