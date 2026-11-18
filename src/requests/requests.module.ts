import { CompanyModule } from '../company/company.module.js';
import { SchedulesModule } from '../schedules/schedules.module.js';
import { Module } from '@nestjs/common';
import { DeductionPolicyModule } from '../deduction-policy/deduction-policy.module.js';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { EmployeesModule } from '../employees/employees.module.js';
import { RequestsController } from './requests.controller.js';
import { RequestsService } from './requests.service.js';

@Module({
  imports: [
    DeductionPolicyModule,
    CompanyModule,
    DatabaseModule,
    AuditModule,
    EmployeesModule,
    AttendanceModule,
    SchedulesModule,
  ],
  controllers: [RequestsController],
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
