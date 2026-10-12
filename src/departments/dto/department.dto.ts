import { z } from 'zod';
import { text } from '../../common/validation/schemas.js';
export const departmentSchema = z.object({ name: text }).strict();
export type CreateDepartmentDto = z.infer<typeof departmentSchema>;
