import { z } from 'zod';

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Invalid calendar date');

export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const text = z.string().trim().min(1).max(120);

export const passwordSchema = z.string().min(8).max(128);
