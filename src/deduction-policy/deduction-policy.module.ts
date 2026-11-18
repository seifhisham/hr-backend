import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DeductionPolicyController } from './deduction-policy.controller.js';
import { DeductionPolicyService } from './deduction-policy.service.js';

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [DeductionPolicyController],
  providers: [DeductionPolicyService],
  exports: [DeductionPolicyService],
})
export class DeductionPolicyModule {}
