import { EmployeesService } from './employees.service.js';
import { importSchema } from './employee-import.js';
import type { DatabaseService } from '../database/database.service.js';
import type { SchedulesService } from '../schedules/schedules.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { Actor } from '../common/types/actor.type.js';
import { IMPORT_PASSWORD_WORDS } from './import-password-words.js';

const actor = { id: 'admin', role: 'admin' } as Actor;
it('uses a large distinct short-word dictionary for memorable passwords', () => {
  expect(IMPORT_PASSWORD_WORDS.length).toBe(1295);
  expect(new Set(IMPORT_PASSWORD_WORDS).size).toBe(1295);
  expect(IMPORT_PASSWORD_WORDS.every((word) => /^[a-z]{2,5}$/.test(word))).toBe(
    true,
  );
});
const header =
  'Full Name,National ID,Email,Job Title,Date Joined,Monthly Salary';
const input = (preview = true) =>
  importSchema.parse({
    csv:
      header +
      '\nAmal,001,a@example.com,Agent,2024-01-01,100\nAli,002,b@example.com,Agent,2024-01-01,200\nAmal,001,a@example.com,Agent,2024-01-01,100',
    branchId: 'c4b4da30-35af-4a63-bcfa-10403ca56c23',
    scheduleId: 'a508f29e-7c74-4454-a4e2-7e911ed96252',
    department: 'Sales',
    salaryCurrency: 'EGP',
    dateFormat: 'ISO',
    preview,
  });
function setup() {
  const all = vi.fn().mockResolvedValue([]);
  const get = vi.fn().mockResolvedValue({ id: 'branch' });
  const service = new EmployeesService(
    { db: { prepare: () => ({ all, get }) } } as unknown as DatabaseService,
    { schedule: vi.fn().mockResolvedValue({}) } as unknown as SchedulesService,
    {} as AuditService,
  );
  const save = vi
    .spyOn(service, 'saveEmployee')
    .mockResolvedValue(
      {} as Awaited<ReturnType<EmployeesService['saveEmployee']>>,
    );
  return { service, save, all, get };
}
it('previews without creating accounts and skips duplicate rows', async () => {
  const { service, save } = setup();
  const rows = await service.importEmployees(actor, input());
  expect(rows.map((r) => r.status)).toEqual(['ready', 'ready', 'skipped']);
  expect(rows.every((r) => !r.password)).toBe(true);
  expect(save).not.toHaveBeenCalled();
});
it('skips existing email or ID and uses unique random passwords for new employees', async () => {
  const { service, save, all } = setup();
  all.mockResolvedValueOnce([{ code: '001', email: 'other@example.com' }]);
  const rows = await service.importEmployees(actor, input(false));
  expect(rows.map((r) => r.status)).toEqual(['skipped', 'created', 'skipped']);
  expect(save).toHaveBeenCalledTimes(1);
  expect(rows[1].password).toMatch(/^(?:[a-z]+-){4}\d{4}$/);
  const next = await service.importEmployees(actor, input(false));
  expect(next[0].password).not.toBe(next[1].password);
});
it('reports failures without returning their passwords and preserves successful credentials', async () => {
  const { service, save } = setup();
  save.mockRejectedValueOnce(new Error('private database information'));
  const rows = await service.importEmployees(actor, input(false));
  expect(rows[0]).toMatchObject({
    status: 'failed',
    message: 'Unable to create employee. Check the row and try again.',
  });
  expect(rows[0].password).toBeUndefined();
  expect(rows[1].status).toBe('created');
  expect(rows[1].password).toBeTruthy();
});
it('rejects unauthorized roles and unavailable branches before saving', async () => {
  const { service, save, get } = setup();
  await expect(
    service.importEmployees({ ...actor, role: 'employee' }, input(false)),
  ).rejects.toThrow('HR access required');
  get.mockResolvedValue(undefined);
  await expect(service.importEmployees(actor, input(false))).rejects.toThrow(
    'branch',
  );
  expect(save).not.toHaveBeenCalled();
});

it('reimporting successful responses never creates more accounts', async () => {
  const { service, save, all } = setup();
  const first = await service.importEmployees(actor, input(false));
  expect(first.filter((r) => r.status === 'created')).toHaveLength(2);
  expect(first.every((r) => !r.employee?.password)).toBe(true);
  all.mockResolvedValue([
    { code: '001', email: 'a@example.com' },
    { code: '002', email: 'b@example.com' },
  ]);
  const second = await service.importEmployees(actor, input(false));
  expect(second.every((r) => r.status === 'skipped' && !r.password)).toBe(true);
  expect(save).toHaveBeenCalledTimes(2);
});

it('keeps invalid rows out of account creation', async () => {
  const { service, save } = setup();
  const request = input(false);
  request.csv = request.csv.replace('a@example.com', 'invalid-email');
  const rows = await service.importEmployees(actor, request);
  expect(rows[0].status).toBe('invalid');
  expect(
    save.mock.calls.every(([, employee]) => employee.email !== 'invalid-email'),
  ).toBe(true);
});

it('validates edited branch and privilege defaults before previewing imports', async () => {
  const { service, save, get } = setup();
  const privileged = input();
  privileged.rowOverrides = { '2': { role: 'admin' } };
  expect(
    (await service.importEmployees({ ...actor, role: 'hr' }, privileged))[0],
  ).toMatchObject({
    status: 'invalid',
    message: 'Only administrators manage HR and administrator accounts',
  });
  const changedBranch = input();
  changedBranch.rowOverrides = {
    '2': { branchId: '11111111-1111-4111-8111-111111111111' },
  };
  get
    .mockResolvedValueOnce({ id: 'batch-branch' })
    .mockResolvedValueOnce(undefined);
  expect((await service.importEmployees(actor, changedBranch))[0].status).toBe(
    'invalid',
  );
  expect(save).not.toHaveBeenCalled();
});
