import { NotificationsModule } from './notifications/notifications.module.js';
import { DepartmentsModule } from './departments/departments.module.js';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AttendanceModule } from './attendance/attendance.module.js';
import { AuditModule } from './audit/audit.module.js';
import { RateLimitGuard } from './common/security/rate-limit.guard.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { CompanyModule } from './company/company.module.js';
import { DatabaseModule } from './database/database.module.js';
import { EmployeesModule } from './employees/employees.module.js';
import { HealthModule } from './health/health.module.js';
import { RequestsModule } from './requests/requests.module.js';
import { PayrollModule } from './payroll/payroll.module.js';
import { SchedulesModule } from './schedules/schedules.module.js';
import { SalesModule } from './sales/sales.module.js';

@Module({
  imports: [
    DatabaseModule,
    NotificationsModule,
    DepartmentsModule,
    AuditModule,
    SchedulesModule,
    CompanyModule,
    EmployeesModule,
    AuthModule,
    AttendanceModule,
    RequestsModule,
    PayrollModule,
    SalesModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
