import { z } from 'zod';
import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
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
        ({
          latitude: 30.023092,
          longitude: 31.528179,
          radiusMeters: 50,
          trackingRadiusMeters: 150,
          trackingGraceMinutes: 5,
          ...JSON.parse(
            (
              this.db
                .prepare("SELECT value FROM settings WHERE key = 'company'")
                .get() as { value: string }
            ).value,
          ),
        }) as {
          name: string;
          timezone: string;
          latitude: number;
          longitude: number;
          radiusMeters: number;
          trackingRadiusMeters: number;
          trackingGraceMinutes: number;
        },
    );
  }

  async searchLocations(actor: Actor, query: string) {
    requireAdmin(actor);
    const q = z.string().trim().min(3).max(200).safeParse(query);
    if (!q.success) throw new BadRequestException('Enter an address between 3 and 200 characters.');
    const url = new URL('https://photon.komoot.io/api/');
    url.searchParams.set('q', q.data);
    url.searchParams.set('limit', '5');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Geocoder unavailable');
      const result = z.object({ features: z.array(z.object({
        geometry: z.object({ coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]) }),
        properties: z.record(z.string(), z.unknown()),
      })) }).parse(await response.json());
      return result.features.map(({ geometry, properties }) => ({
        longitude: geometry.coordinates[0],
        latitude: geometry.coordinates[1],
        label: [...new Set([properties.name, properties.housenumber, properties.street, properties.city, properties.state, properties.postcode, properties.country].filter((part): part is string => typeof part === 'string' && part.length > 0))].join(', '),
      }));
    } catch {
      throw new ServiceUnavailableException('Address search is unavailable. Please try again or choose the location on the map.');
    }
  }

  updateSettings(actor: Actor, value: UpdateCompanyDto) {
    requireAdmin(actor);
    try {
      new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format();
    } catch {
      throw new BadRequestException('Invalid timezone');
    }
    value = { ...this.settings(), ...value };
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
