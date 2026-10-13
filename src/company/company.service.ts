import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { requireAdmin } from '../common/security/permissions.js';
import type { Actor } from '../common/types/actor.type.js';
import { DatabaseService } from '../database/database.service.js';
import type { UpdateCompanyDto } from './dto/company.dto.js';

@Injectable()
export class CompanyService {
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}
  private get db() {
    return this.store.db;
  }

  settings() {
    return this.store.cachedRead(
      'company',
      () =>
        JSON.parse(
          (
            this.db
              .prepare("SELECT value FROM settings WHERE key = 'company'")
              .get() as { value: string }
          ).value,
        ) as { name: string; timezone: string },
    );
  }

  updateSettings(actor: Actor, value: UpdateCompanyDto) {
    requireAdmin(actor);
    try {
      new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format();
    } catch {
      throw new BadRequestException('Invalid timezone');
    }
    this.store.transaction(() => {
      this.auditService.record(
        actor,
        'company.updated',
        'company',
        this.settings(),
        value,
      );
      this.db
        .prepare("UPDATE settings SET value = ? WHERE key = 'company'")
        .run(JSON.stringify(value));
    });
    return value;
  }
}
