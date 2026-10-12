import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { requireHr } from '../common/security/permissions.js';
import type { Actor } from '../common/types/actor.type.js';
import type { CreateDepartmentDto } from './dto/department.dto.js';
@Injectable()
export class DepartmentsService {
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  list(actor: Actor) {
    requireHr(actor);
    return this.store.db
      .prepare('SELECT name FROM departments ORDER BY name COLLATE NOCASE')
      .all()
      .map((row) => ({ name: row.name as string }));
  }

  create(actor: Actor, input: CreateDepartmentDto) {
    requireHr(actor);
    return this.store.transaction(() => {
      const inserted = this.store.db
        .prepare('INSERT OR IGNORE INTO departments (name) VALUES (?)')
        .run(input.name);
      if (!inserted.changes)
        throw new ConflictException('Department already exists');
      this.audit.record(actor, 'department.created', input.name, null, input);
      return input;
    });
  }
}
