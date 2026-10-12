import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { CompanyModule } from '../company/company.module.js';
import { EmployeesModule } from '../employees/employees.module.js';
import { RequestsModule } from '../requests/requests.module.js';
import { PayrollController } from './payroll.controller.js';
import { PayrollService } from './payroll.service.js';

@Module({
  imports: [
    CompanyModule,
    EmployeesModule,
    RequestsModule,
    DatabaseModule,
    AuditModule,
  ],
  controllers: [PayrollController],
  providers: [PayrollService],
})
export class PayrollModule {}
