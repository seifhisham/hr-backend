import type { Actor } from '../../common/types/actor.type.js';
export type User = {
  company_id: string;
  id: string;
  email: string;
  name: string;
  role: Actor['role'];
  employee_id: string | null;
  active: number;
  password_hash: string;
};
