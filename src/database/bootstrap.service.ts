import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
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
  private get db() {
    return this.store.db;
  }
  async onModuleInit() {
    if (!this.db.prepare('SELECT id FROM users LIMIT 1').get()) {
      const email = process.env.HR_ADMIN_EMAIL;
      const password = process.env.HR_ADMIN_PASSWORD;
      if (!email || !password)
        throw new Error(
          'Set HR_ADMIN_EMAIL and HR_ADMIN_PASSWORD to provision the first administrator.',
        );
      const input = parse(
        employeeSchema
          .pick({ email: true })
          .extend({ password: passwordSchema }),
        { email, password },
      );
      this.db
        .prepare('INSERT INTO users VALUES (?, ?, ?, ?, NULL, 1, ?)')
        .run(
          randomUUID(),
          input.email,
          'Company Administrator',
          'admin',
          await passwordHash(input.password),
        );
    }
    if (
      !this.db.prepare("SELECT value FROM settings WHERE key = 'company'").get()
    ) {
      this.db
        .prepare('INSERT INTO settings VALUES (?, ?)')
        .run(
          'company',
          JSON.stringify({ name: 'Company HR', timezone: 'Africa/Cairo' }),
        );
    }
    if (!this.db.prepare('SELECT id FROM schedules LIMIT 1').get()) {
      const schedule: Schedule = {
        id: randomUUID(),
        name: 'Standard workweek',
        start: '10:00',
        end: '18:00',
        days: [0, 1, 2, 3, 4],
        graceMinutes: 15,
      };
      this.db
        .prepare('INSERT INTO schedules VALUES (?, ?)')
        .run(schedule.id, JSON.stringify(schedule));
      const sales: Schedule = {
        ...schedule,
        id: randomUUID(),
        name: 'Sales workweek',
        start: '11:00',
        end: '19:00',
      };
      this.db
        .prepare('INSERT INTO schedules VALUES (?, ?)')
        .run(sales.id, JSON.stringify(sales));
    }
  }
}
