import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { passwordHash } from '../common/security/credentials.js';
import { requireHr } from '../common/security/permissions.js';
import type { Actor } from '../common/types/actor.type.js';
import { DatabaseService } from '../database/database.service.js';
import { SchedulesService } from '../schedules/schedules.service.js';
import type { SaveEmployeeDto } from './dto/employee.dto.js';
import type { Employee } from './types/employee.type.js';

@Injectable()
export class EmployeesService {
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(SchedulesService)
    private readonly schedulesService: SchedulesService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}
  private get db() {
    return this.store.db;
  }

  employeeActor(actor: Actor) {
    if (!actor.employeeId)
      throw new BadRequestException('This account has no employee profile');
    return this.employee(actor.employeeId);
  }

  employees(actor: Actor) {
    requireHr(actor);
    return this.db
      .prepare('SELECT data FROM employees ORDER BY code')
      .all()
      .map((r) => JSON.parse(r.data as string) as Employee);
  }

  employee(id: string): Employee {
    const row = this.db
      .prepare('SELECT data FROM employees WHERE id = ?')
      .get(id);
    if (!row) throw new NotFoundException('Employee not found');
    return JSON.parse(row.data as string) as Employee;
  }

  profile(actor: Actor) {
    return actor.employeeId ? this.employee(actor.employeeId) : null;
  }

  async saveEmployee(actor: Actor, input: SaveEmployeeDto, id?: string) {
    requireHr(actor);
    const before = id ? this.employee(id) : null;
    if (
      actor.role !== 'admin' &&
      (input.role !== 'employee' || (before && before.role !== 'employee'))
    )
      throw new ForbiddenException(
        'Only administrators manage HR and administrator accounts',
      );
    if (id === actor.employeeId && (!input.active || input.role !== actor.role))
      throw new BadRequestException(
        'You cannot deactivate or change your own role',
      );
    this.schedulesService.schedule(input.scheduleId);
    if (!before && !input.password)
      throw new BadRequestException('An initial password is required');
    const hash = input.password ? await passwordHash(input.password) : null;
    // Password hashing yields; check access again before committing account changes.
    const current = this.db
      .prepare('SELECT role, active FROM users WHERE id = ?')
      .get(actor.id) as { role: string; active: number };
    if (!current?.active || current.role !== actor.role)
      throw new ForbiddenException('Your access changed. Sign in again.');
    if (id && actor.role !== 'admin' && this.employee(id).role !== 'employee')
      throw new ForbiddenException(
        'Only administrators manage HR and administrator accounts',
      );
    const { password: _password, ...fields } = input;
    const employee: Employee = { ...fields, id: id ?? randomUUID() };
    try {
      this.store.transaction(() => {
        if (before) {
          this.db
            .prepare(
              'UPDATE employees SET code = ?, email = ?, data = ? WHERE id = ?',
            )
            .run(
              employee.employeeCode,
              employee.email,
              JSON.stringify(employee),
              employee.id,
            );
          this.db
            .prepare(
              'UPDATE users SET email = ?, name = ?, role = ?, active = ?, password_hash = COALESCE(?, password_hash) WHERE employee_id = ?',
            )
            .run(
              employee.email,
              employee.name,
              employee.role,
              Number(employee.active),
              hash,
              employee.id,
            );
          if (hash || !employee.active || employee.role !== before.role)
            this.db
              .prepare(
                'DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE employee_id = ?)',
              )
              .run(employee.id);
        } else {
          this.db
            .prepare('INSERT INTO employees VALUES (?, ?, ?, ?)')
            .run(
              employee.id,
              employee.employeeCode,
              employee.email,
              JSON.stringify(employee),
            );
          this.db
            .prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(
              randomUUID(),
              employee.email,
              employee.name,
              employee.role,
              employee.id,
              Number(employee.active),
              hash!,
            );
        }
        this.auditService.record(
          actor,
          before ? 'employee.updated' : 'employee.created',
          employee.id,
          before,
          employee,
        );
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint'))
        throw new ConflictException('Employee code or email already exists');
      throw error;
    }
    return employee;
  }
}
