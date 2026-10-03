export type Role = 'employee' | 'hr' | 'admin';

export type Actor = {
  id: string;
  name: string;
  email: string;
  role: Role;
  employeeId: string | null;
};
