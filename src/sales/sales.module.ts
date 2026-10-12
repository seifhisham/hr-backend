import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CompanyModule } from '../company/company.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { EmployeesModule } from '../employees/employees.module.js';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';

@Module({
  imports: [AuditModule, CompanyModule, DatabaseModule, EmployeesModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
