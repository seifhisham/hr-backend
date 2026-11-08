import { z } from 'zod';

const account = z
  .string()
  .trim()
  .toUpperCase()
  .max(34)
  .regex(/^[A-Z0-9]*$/);
export const bankSettingsSchema = z
  .object({
    debitAccount: account,
    transactionTypeCode: z.string().trim().max(20),
    purposeCode: z.string().trim().max(20),
    paymentType: z.string().trim().max(50),
    purposeOfPayment: z.string().trim().max(120),
  })
  .strict();
export const employeeBankSchema = z
  .object({
    employeeId: z.uuid(),
    beneficiaryName: z.string().trim().max(200),
    account: account,
    swift: z
      .string()
      .trim()
      .toUpperCase()
      .max(20)
      .regex(/^[A-Z0-9]*$/),
  })
  .strict();
export const bankDetailsSchema = z
  .object({
    settings: bankSettingsSchema,
    employees: z
      .array(employeeBankSchema)
      .max(2000)
      .refine(
        (rows) =>
          new Set(rows.map((row) => row.employeeId)).size === rows.length,
        'Duplicate employee',
      ),
  })
  .strict();
export type BankDetails = z.infer<typeof bankDetailsSchema>;
