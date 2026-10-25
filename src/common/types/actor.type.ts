export type Role = 'employee' | 'manager' | 'hr' | 'admin';

export type Actor = {
  companyId: string;
  id: string;
  name: string;
  email: string;
  role: Role;
  employeeId: string | null;
};
