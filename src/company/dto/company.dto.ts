import { z } from 'zod';

export const companySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    radiusMeters: z.number().positive().optional(),
    trackingRadiusMeters: z.number().positive().optional(),
    trackingGraceMinutes: z.number().int().positive().max(1440).optional(),
    timezone: z.string().min(1).max(100),
  })
  .strict();

export type UpdateCompanyDto = z.infer<typeof companySchema>;
