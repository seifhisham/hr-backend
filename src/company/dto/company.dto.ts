import { z } from 'zod';

export const companySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    timezone: z.string().min(1).max(100),
  })
  .strict();

export type UpdateCompanyDto = z.infer<typeof companySchema>;
