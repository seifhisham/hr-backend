import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { requireHr } from '../common/security/permissions.js';
import type { Actor } from '../common/types/actor.type.js';
import type { CreateDepartmentDto } from './dto/department.dto.js';
@Injectable()
export class DepartmentsService {
  constructor(
    @Inject(DatabaseService)
    private readonly store: DatabaseService,
    @Inject(AuditService)
    private readonly audit: AuditService,
  ) {}
  async list(actor: Actor) {
    requireHr(actor);
    return await this.store.cachedRead('departments', async () =>
      (
        await this.store.db
          .prepare('SELECT name FROM departments ORDER BY lower(name)')
          .all()
      ).map((row) => ({ name: row.name as string })),
    );
  }
  async create(actor: Actor, input: CreateDepartmentDto) {
    requireHr(actor);
    return await this.store.transaction(async () => {
      const inserted = await this.store.db
        .prepare(
          'INSERT INTO departments (name) VALUES (?) ON CONFLICT DO NOTHING',
        )
        .run(input.name);
      if (!inserted.changes)
        throw new ConflictException('Department already exists');
      await this.audit.record(
        actor,
        'department.created',
        input.name,
        null,
        input,
      );
      return input;
    });
  }
}
