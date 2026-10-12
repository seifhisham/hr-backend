import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { getDistance } from 'geolib';
import sharp from 'sharp';
import { z } from 'zod';
import type { Actor } from '../common/types/actor.type.js';
import { parse } from '../common/validation/parse.js';
import { DatabaseService } from '../database/database.service.js';

export const officePolicy = Object.freeze({
  latitude: 30.023092,
  longitude: 31.528179,
  radiusMeters: 50,
  maxAccuracyMeters: 50,
  maxCaptureAgeSeconds: 120,
  maxPhotoBytes: 5 * 1024 * 1024,
  photoFormats: ['jpeg', 'png'] as const,
});

const captureSchema = z
  .object({
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
    accuracyMeters: z.coerce
      .number()
      .positive()
      .max(officePolicy.maxAccuracyMeters),
    capturedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type Evidence = z.infer<typeof captureSchema> & {
  distanceMeters: number;
  photo: Buffer;
};

export type AttendanceEvent = 'check-in' | 'check-out';

export function validateLocation(body: unknown) {
  const input = parse(captureSchema, body);
  const age = Date.now() - Date.parse(input.capturedAt);
  if (age < -10000 || age > officePolicy.maxCaptureAgeSeconds * 1000)
    throw new BadRequestException(
      'Capture must be recent. Retake the photo and refresh your location.',
    );
  const distanceMeters = getDistance(input, officePolicy, 0.01);
  if (distanceMeters > officePolicy.radiusMeters)
    throw new ForbiddenException(
      'You must be within 50 metres of the office to check in or out.',
    );
  return { ...input, distanceMeters };
}

@Injectable()
export class AttendanceEvidence {
  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
  ) {}

  async prepare(body: unknown, file?: Express.Multer.File): Promise<Evidence> {
    const location = validateLocation(body);
    if (!file?.buffer?.length)
      throw new BadRequestException('A photo of the place is required.');
    if (file.buffer.length > officePolicy.maxPhotoBytes)
      throw new BadRequestException('Photo must be no larger than 5 MB.');
    try {
      const image = sharp(file.buffer, {
        limitInputPixels: 20000000,
        failOn: 'warning',
      });
      const metadata = await image.metadata();
      if (
        !['jpeg', 'png'].includes(metadata.format ?? '') ||
        (metadata.pages ?? 1) !== 1
      )
        throw new Error('Unsupported image');
      // Decode and re-encode: reject corrupt uploads and discard EXIF and filenames.
      const photo = await image
        .rotate()
        .resize({
          width: 1280,
          height: 1280,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85, optimiseCoding: false })
        .toBuffer();
      return { ...location, photo };
    } catch {
      throw new BadRequestException(
        'Photo must be a valid, non-animated JPEG or PNG image (up to 20 megapixels).',
      );
    }
  }

  save(
    id: string,
    event: AttendanceEvent,
    evidence: Evidence,
    submittedAt: string,
  ) {
    // Called inside the attendance transaction, so no orphan evidence is committed.
    validateLocation(evidenceFields(evidence));
    this.store.db
      .prepare(
        'INSERT INTO attendance_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        event,
        evidence.latitude,
        evidence.longitude,
        evidence.accuracyMeters,
        evidence.distanceMeters,
        new Date(evidence.capturedAt).toISOString(),
        submittedAt,
        JSON.stringify(officePolicy),
        evidence.photo,
      );
  }

  list(actor: Actor, id: string) {
    this.authorize(actor, id);
    return this.store.db
      .prepare(
        'SELECT event, latitude, longitude, accuracy_meters, distance_meters, captured_at, submitted_at, policy FROM attendance_evidence WHERE attendance_id = ? ORDER BY event',
      )
      .all(id)
      .map((r) => ({
        event: r.event,
        latitude: r.latitude,
        longitude: r.longitude,
        accuracyMeters: r.accuracy_meters,
        distanceMeters: r.distance_meters,
        capturedAt: r.captured_at,
        submittedAt: r.submitted_at,
        policy: JSON.parse(r.policy as string) as typeof officePolicy,
        photoUrl: `/api/attendance/${id}/photos/${r.event as string}`,
      }));
  }

  photo(actor: Actor, id: string, event: AttendanceEvent) {
    this.authorize(actor, id);
    const row = this.store.db
      .prepare(
        'SELECT photo FROM attendance_evidence WHERE attendance_id = ? AND event = ?',
      )
      .get(id, event);
    if (!row) throw new NotFoundException('Attendance photo not found');
    return Buffer.from(row.photo as Uint8Array);
  }

  private authorize(actor: Actor, id: string) {
    const row = this.store.db
      .prepare('SELECT employee_id FROM attendance WHERE id = ?')
      .get(id);
    if (
      !row ||
      ((actor.role === 'employee' || actor.role === 'manager') &&
        actor.employeeId !== row.employee_id &&
        !(
          actor.role === 'manager' &&
          this.store.db
            .prepare(
              "SELECT 1 FROM employees WHERE id = ? AND json_extract(data, '$.managerId') = ?",
            )
            .get(row.employee_id, actor.employeeId)
        ))
    )
      throw new NotFoundException('Attendance record not found');
  }
}

function evidenceFields(evidence: Evidence) {
  return {
    latitude: evidence.latitude,
    longitude: evidence.longitude,
    accuracyMeters: evidence.accuracyMeters,
    capturedAt: evidence.capturedAt,
  };
}
