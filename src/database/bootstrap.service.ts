import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { passwordHash } from '../common/security/credentials.js';
import { parse } from '../common/validation/parse.js';
import { passwordSchema } from '../common/validation/schemas.js';
import { employeeSchema } from '../employees/dto/employee.dto.js';
import type { Schedule } from '../schedules/types/schedule.type.js';
import { DatabaseService } from './database.service.js';

@Injectable()
export class BootstrapService implements OnModuleInit {
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
  ) {}
  async onModuleInit() {
    // Provisioning a company is explicit; starting the server never creates or imports one.
    const companyId = process.env.HR_BOOTSTRAP_COMPANY_ID;
    if (!companyId) return;
    await this.store.withCompany(companyId, async () => {
      const existing = await this.store
        .prepare('SELECT id FROM users LIMIT 1')
        .get();
      let hash: string | null = null;
      let email = '';
      if (!existing) {
        const input = parse(
          employeeSchema
            .pick({ email: true })
            .extend({ password: passwordSchema }),
          {
            email: process.env.HR_ADMIN_EMAIL,
            password: process.env.HR_ADMIN_PASSWORD,
          },
        );
        email = input.email;
        hash = await passwordHash(input.password);
      }
      await this.store.transaction(async () => {
        if (
          hash &&
          !(await this.store.prepare('SELECT id FROM users LIMIT 1').get())
        )
          await this.store
            .prepare(
              'INSERT INTO users(id,email,name,role,employee_id,active,password_hash) VALUES(?,?,?, ?,NULL,1,?)',
            )
            .run(randomUUID(), email, 'Company Administrator', 'admin', hash);
        if (
          !(await this.store
            .prepare("SELECT value FROM settings WHERE key='company'")
            .get())
        ) {
          const company = await this.store
            .prepare('SELECT name,timezone FROM companies')
            .get();
          await this.store
            .prepare('INSERT INTO settings(key,value) VALUES(?,?)')
            .run(
              'company',
              JSON.stringify({
                name: company!.name,
                timezone: company!.timezone,
              }),
            );
        }
        if (
          !(await this.store.prepare('SELECT id FROM schedules LIMIT 1').get())
        ) {
          for (const sales of [false, true]) {
            const schedule: Schedule = {
              id: randomUUID(),
              name: sales ? 'Sales workweek' : 'Standard workweek',
              start: sales ? '11:00' : '10:00',
              end: sales ? '19:00' : '18:00',
              days: [0, 1, 2, 3, 4],
              graceMinutes: 15,
            };
            await this.store
              .prepare('INSERT INTO schedules(id,data) VALUES(?,?)')
              .run(schedule.id, JSON.stringify(schedule));
          }
        }
      });
    });
  }
}
