import { z } from 'zod';
import { text } from '../common/validation/schemas.js';
import { branchSchema } from '../branches/branch.dto.js';
const email = z.email().trim().toLowerCase().max(254);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const code = z.string().regex(/^\d{6}$/);
export const ownerPassword = z.string().min(8).max(128);
export const ownerLoginSchema = z
  .object({
    email,
    password: z.string().min(1).max(128),
    code: code.optional(),
    recoveryCode: z
      .string()
      .regex(/^[a-f0-9]{24}$/i)
      .optional(),
  })
  .strict()
  .refine(
    (input) => !!input.code !== !!input.recoveryCode,
    'Enter an authenticator code or one recovery code',
  );
export const ownerRecoverySchema = z
  .object({
    password: z.string().min(1).max(128),
    code: code.optional(),
    recoveryCode: z
      .string()
      .regex(/^[a-f0-9]{24}$/i)
      .optional(),
  })
  .strict()
  .refine(
    (input) => !!input.code !== !!input.recoveryCode,
    'Enter an authenticator code or one recovery code',
  );
export const setupTokenSchema = z.object({ token }).strict();
export const ownerSetupSchema = z
  .object({ token, password: ownerPassword, name: text, code })
  .strict();
export const createCompanySchema = z
  .object({
    requestId: z.uuid(),
    workspace: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    name: text,
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Choose a valid timezone'),
    adminEmail: email,
    adminName: text,
  })
  .strict();
export const invitationSchema = z.object({ requestId: z.uuid() }).strict();
export const reasonSchema = z
  .object({ reason: z.string().trim().min(5).max(500) })
  .strict();
export const statusSchema = reasonSchema
  .extend({
    status: z.enum(['active', 'suspended', 'archived']),
    expectedStatus: z.enum(['provisioning', 'active', 'suspended', 'archived']),
  })
  .strict();
export const branchLimitSchema = reasonSchema
  .extend({ branchLimit: z.number().int().min(1).max(2147483647).nullable() })
  .strict();
export const acceptInvitationSchema = z
  .object({
    token,
    password: ownerPassword,
    name: text,
    branchName: text,
    policy: branchSchema.pick({
      address: true,
      latitude: true,
      longitude: true,
      radiusMeters: true,
      trackingRadiusMeters: true,
      trackingGraceMinutes: true,
    }),
  })
  .strict();
export type OwnerLogin = z.infer<typeof ownerLoginSchema>;
export type OwnerSetup = z.infer<typeof ownerSetupSchema>;
export type CreateCompany = z.infer<typeof createCompanySchema>;
