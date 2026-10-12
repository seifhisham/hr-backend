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
    @Inject(PayrollService) private readonly payrollService: PayrollService,
  ) {}

  @Get()
  preview(@Req() req: AuthRequest, @Query('month') month: unknown) {
    return this.payrollService.preview(
      req.actor,
      parse(payrollMonthSchema, month),
    );
  }
  @Get('run') run(@Req() req: AuthRequest, @Query('month') month: unknown) {
    return this.payrollService.run(req.actor, parse(payrollMonthSchema, month));
  }
  @Post('approve') approve(
    @Req() req: AuthRequest,
    @Body(new ZodValidationPipe(payrollApprovalSchema)) body: ApprovePayrollDto,
  ) {
    return this.payrollService.approve(req.actor, body);
  }
  @Get('deductions')
  deductions(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.payrollService.deductions(
      req.actor,
      parse(deductionRangeSchema, query),
    );
  }
  @Post('deductions')
  addDeduction(
    @Req() req: AuthRequest,
    @Body(new ZodValidationPipe(deductionSchema)) body: AddDeductionDto,
  ) {
    return this.payrollService.addDeduction(req.actor, body);
  }
}
