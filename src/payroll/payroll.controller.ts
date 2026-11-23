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
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import {
  absenceDeductionParamsSchema,
  adjustDeductionSchema,
  automaticDeductionParamsSchema,
  type AdjustDeductionDto,
  deductionSchema,
  deductionRangeSchema,
  payrollMonthSchema,
  type AddDeductionDto,
} from './dto/deduction.dto.js';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { parse } from '../common/validation/parse.js';
import { PayrollService } from './payroll.service.js';
import { bankDetailsSchema, type BankDetails } from './dto/bank-details.dto.js';
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
  @Get('bank-details')
  async bankDetails(@Req() req: AuthRequest) {
    return this.payrollService.bankDetails(req.actor);
  }
  @Post('bank-details')
  async saveBankDetails(
    @Req() req: AuthRequest,
    @Body(new ZodValidationPipe(bankDetailsSchema)) body: BankDetails,
  ) {
    return this.payrollService.saveBankDetails(req.actor, body);
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
  @RateLimit('reports')
  @Get('automatic-deductions')
  async automaticDeductions(
    @Req() req: AuthRequest,
    @Query('month') month: unknown,
  ) {
    return await this.payrollService.automaticDeductions(
      req.actor,
      parse(payrollMonthSchema, month),
    );
  }
  @Patch('automatic-deductions/:source/:id')
  async adjustAutomaticDeduction(
    @Req() req: AuthRequest,
    @Param() params: unknown,
    @Body(new ZodValidationPipe(adjustDeductionSchema))
    body: AdjustDeductionDto,
  ) {
    const { source, id } = parse(automaticDeductionParamsSchema, params);
    return await this.payrollService.adjustAutomaticDeduction(
      req.actor,
      source,
      id,
      body,
    );
  }
  @Patch('absence-deductions/:employeeId/:workDate')
  async adjustAbsenceDeduction(
    @Req() req: AuthRequest,
    @Param() params: unknown,
    @Body(new ZodValidationPipe(adjustDeductionSchema))
    body: AdjustDeductionDto,
  ) {
    const { employeeId, workDate } = parse(
      absenceDeductionParamsSchema,
      params,
    );
    return await this.payrollService.adjustAbsenceDeduction(
      req.actor,
      employeeId,
      workDate,
      body,
    );
  }
  @RateLimit('reports')
  @Get('never-checked-in')
  async neverCheckedIn(
    @Req() req: AuthRequest,
    @Query('month') month: unknown,
  ) {
    return await this.payrollService.neverCheckedIn(
      req.actor,
      parse(payrollMonthSchema, month),
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
