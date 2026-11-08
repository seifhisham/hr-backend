import { PayrollService } from './payroll.service.js';
import { bankDetailsSchema, type BankDetails } from './dto/bank-details.dto.js';
import type { EmployeesService } from '../employees/employees.service.js';
import type { CompanyService } from '../company/company.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../common/types/actor.type.js';

const actor = { id: 'hr-user', role: 'hr', companyId: 'company' } as Actor;
const employeeId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const settings = {
  debitAccount: '0012345678901',
  transactionTypeCode: 'BT',
  purposeCode: '13',
  paymentType: 'SALARY',
  purposeOfPayment: 'SALARY',
};
let values: Map<string, string>;
let service: PayrollService;
let prepare: ReturnType<typeof vi.fn>;
let employee: ReturnType<typeof vi.fn>;
let record: ReturnType<typeof vi.fn>;
beforeEach(() => {
  values = new Map();
  prepare = vi.fn((_sql: string) => ({
    all: async () => [...values].map(([key, value]) => ({ key, value })),
    run: async (key: string, value: string) => {
      values.set(key, value);
    },
  }));
  employee = vi.fn(async (id: string) => {
    if (id !== employeeId) throw new Error('Employee not found');
    return { id, role: 'employee' };
  });
  record = vi.fn();
  service = new PayrollService(
    {
      employees: async () => [{ id: employeeId, role: 'employee' }],
      employee,
    } as unknown as EmployeesService,
    {} as CompanyService,
    {
      prepare,
      transaction: async (fn: () => Promise<unknown>) => fn(),
    } as unknown as DatabaseService,
    { record } as unknown as AuditService,
  );
});
const input = (): BankDetails => ({
  settings,
  employees: [
    {
      employeeId,
      beneficiaryName: 'Test employee',
      account: '0000987654321',
      swift: 'ARABEGXXXX',
    },
  ],
});

it('persists bank details and only returns currently permitted employees', async () => {
  values.set(
    `payroll-bank:${otherId}`,
    JSON.stringify({ employeeId: otherId, account: 'hidden' }),
  );
  await service.saveBankDetails(actor, input());
  const saved = await service.bankDetails(actor);
  expect(saved).toEqual(input());
  expect(values.has(`payroll-bank:${otherId}`)).toBe(true);
  expect(JSON.stringify(record.mock.calls)).not.toContain('0000987654321');
});
it('checks all employee access before writing and rejects administrator beneficiaries', async () => {
  await expect(
    service.saveBankDetails(actor, {
      ...input(),
      employees: [
        ...input().employees,
        { ...input().employees[0], employeeId: otherId },
      ],
    }),
  ).rejects.toThrow('Employee not found');
  expect(prepare).not.toHaveBeenCalled();
  employee.mockResolvedValue({ id: employeeId, role: 'admin' });
  await expect(service.saveBankDetails(actor, input())).rejects.toThrow(
    'Administrator',
  );
  expect(prepare).not.toHaveBeenCalled();
});
it('rejects employees and managers without reading or changing bank details', async () => {
  for (const role of ['employee', 'manager'] as const) {
    await expect(service.bankDetails({ ...actor, role })).rejects.toThrow(
      'HR access',
    );
    await expect(
      service.saveBankDetails({ ...actor, role }, input()),
    ).rejects.toThrow('HR access');
  }
  expect(prepare).not.toHaveBeenCalled();
});
it('validates account text and duplicates while preserving leading zeros', () => {
  expect(bankDetailsSchema.parse(input()).employees[0].account).toBe(
    '0000987654321',
  );
  expect(
    bankDetailsSchema.safeParse({
      ...input(),
      employees: [...input().employees, ...input().employees],
    }).success,
  ).toBe(false);
  expect(
    bankDetailsSchema.safeParse({
      ...input(),
      settings: { ...settings, debitAccount: '=1+1' },
    }).success,
  ).toBe(false);
});
