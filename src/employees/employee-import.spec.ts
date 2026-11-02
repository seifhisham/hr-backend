import { parseEmployeeCsv, importSchema } from './employee-import.js';

const header =
  'Timestamp,Full Name,National ID,Email,Job Title,Date Joined,Monthly Salary,Iphone or android';
const defaults = {
  branchId: 'c4b4da30-35af-4a63-bcfa-10403ca56c23',
  department: 'Sales',
  scheduleId: 'a508f29e-7c74-4454-a4e2-7e911ed96252',
  salaryCurrency: 'EGP',
  dateFormat: 'ISO' as const,
};
const parse = (csv: string, extra = {}) =>
  parseEmployeeCsv(importSchema.parse({ csv, ...defaults, ...extra }));

it('lets each row override CSV data and batch defaults before validation', () => {
  const csv =
    header + '\nnow,Amal,001,a@example.com,Agent,2024-01-01,NA,Android';
  const overrides = {
    name: 'Edited name',
    nationalId: '009',
    email: 'edited@example.com',
    jobTitle: 'Manager',
    startDate: '2024-02-01',
    monthlySalary: 7000,
    department: 'Operations',
    branchId: '11111111-1111-4111-8111-111111111111',
    scheduleId: '22222222-2222-4222-8222-222222222222',
    salaryCurrency: 'USD',
    role: 'manager',
    active: false,
    salesEnabled: true,
    managerId: null,
  };
  expect(
    parse(csv, { rowOverrides: { '2': overrides } })[0].employee,
  ).toMatchObject(overrides);
  expect(() =>
    parse(csv, { rowOverrides: { '2': { password: 'not-allowed' } } }),
  ).toThrow();
  expect(() =>
    parse(csv, { rowOverrides: { '2': { email: 'invalid' } } }),
  ).toThrow();
  expect(() =>
    parse(csv, { rowOverrides: { '2': { role: 'owner' } } }),
  ).toThrow();
});

it('accepts k suffixes and dot thousands while preserving decimal salaries', () => {
  for (const [salary, expected] of [
    ['10k', 10000],
    ['10K', 10000],
    ['10.5k', 10500],
    ['4.56k', 4560],
    ['7.000', 7000],
    ['1.250.000', 1250000],
    ['7000.50', 7000.5],
  ] as const) {
    const row = parse(
      header +
        `\nnow,Amal,001,a@example.com,Agent,2024-01-01,${salary},Android`,
    )[0];
    expect(row.employee?.monthlySalary).toBe(expected);
  }
});

it('requires an explicit salary for NA and applies validated overrides to CSV line numbers', () => {
  const csv =
    header + '\nnow,Amal,001,a@example.com,Agent,2024-01-01,NA,Android';
  expect(parse(csv)[0]).toMatchObject({
    status: 'invalid',
    salarySource: 'NA',
  });
  expect(
    parse(csv, { salaryOverrides: { '2': 12345.67 } })[0].employee
      ?.monthlySalary,
  ).toBe(12345.67);
  expect(
    parse(csv, { salaryOverrides: { '2': 0 } })[0].employee?.monthlySalary,
  ).toBe(0);
  for (const value of [-1, 1000000001, 1.001, null, '10000']) {
    expect(() => parse(csv, { salaryOverrides: { '2': value } })).toThrow();
  }
});

it('reads BOM, CRLF, quoted commas, escaped quotes and newlines without changing national IDs', () => {
  const rows = parse(
    '\uFEFF' +
      header +
      '\r\nnow,"Amal, ""A""\nAli",00123456789012,A@EXAMPLE.COM,Agent,2020-02-29,"12,500.50",Android\r\n',
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].employee).toMatchObject({
    name: 'Amal, "A"\nAli',
    nationalId: '00123456789012',
    email: 'a@example.com',
    monthlySalary: 12500.5,
    startDate: '2020-02-29',
    role: 'employee',
  });
});

it('requires missing dates explicitly and validates salary and email by row', () => {
  const csv = header + '\nnow,Amal,001,a@example.com,Agent,,100,Android';
  expect(parse(csv)[0].message).toContain('Date Joined');
  expect(
    parse(csv, { fallbackStartDate: '2024-01-01' })[0].employee?.startDate,
  ).toBe('2024-01-01');
  expect(
    parse(header + '\nnow,Amal,001,bad,Agent,2024-01-01,abc,Android')[0].status,
  ).toBe('invalid');
});

it('uses an explicit date format and rejects invalid dates and malformed amounts', () => {
  const csv = (date: string, salary = '100') =>
    header + `\nnow,Amal,001,a@example.com,Agent,${date},${salary},Android`;
  expect(parse(csv('01/02/2024'))[0].status).toBe('invalid');
  expect(
    parse(csv('01/02/2024'), { dateFormat: 'DMY' })[0].employee?.startDate,
  ).toBe('2024-02-01');
  expect(
    parse(csv('01/02/2024'), { dateFormat: 'MDY' })[0].employee?.startDate,
  ).toBe('2024-01-02');
  expect(parse(csv('2023-02-29'))[0].status).toBe('invalid');
  expect(parse(csv('2024-01-01', '"1,2,3"'))[0].status).toBe('invalid');
});

it('rejects missing/duplicate headers, bad quoting, uneven rows, empty data and oversized batches', () => {
  for (const csv of [
    'Full Name\nAmal',
    header + ',Email\nx',
    header + '\n"unfinished',
    header + '\nx,y',
    header,
    header +
      '\n' +
      Array(101)
        .fill('now,Amal,001,a@example.com,Agent,2024-01-01,100,Android')
        .join('\n'),
  ]) {
    expect(() => parse(csv)).toThrow();
  }
});

it('rejects extra privilege fields and invalid batch defaults at the REST boundary', () => {
  const valid = {
    ...defaults,
    csv: header + '\nnow,Amal,001,a@example.com,Agent,2024-01-01,100,Android',
  };
  expect(importSchema.safeParse({ ...valid, role: 'admin' }).success).toBe(
    false,
  );
  expect(
    importSchema.safeParse({ ...valid, branchId: 'invalid' }).success,
  ).toBe(false);
  expect(
    importSchema.safeParse({ ...valid, fallbackStartDate: '2024-02-30' })
      .success,
  ).toBe(false);
  expect(
    importSchema.safeParse({ ...valid, csv: 'a'.repeat(50001) }).success,
  ).toBe(false);
});
