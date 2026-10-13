import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CompanyModule } from '../company/company.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { EmployeesModule } from '../employees/employees.module.js';
import { SchedulesModule } from '../schedules/schedules.module.js';
import { AttendanceEvidence } from './attendance-evidence.service.js';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';
import { AttendanceLocationService } from './attendance-location.service.js';
import { AttendanceReportCompression } from './attendance-report-compression.interceptor.js';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    EmployeesModule,
    SchedulesModule,
    CompanyModule,
    AuthModule,
  ],
  controllers: [AttendanceController],
  providers: [
    AttendanceService,
    AttendanceEvidence,
    AttendanceLocationService,
    AttendanceReportCompression,
  ],
  exports: [AttendanceService],
})
export class AttendanceModule {}
