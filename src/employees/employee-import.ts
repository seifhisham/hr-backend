import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { dateSchema, text } from '../common/validation/schemas.js';
import { employeeSchema, type SaveEmployeeDto } from './dto/employee.dto.js';

export const importSchema = z
  .object({
    csv: z.string().min(1).max(50000),
    branchId: z.uuid(),
    department: text,
    scheduleId: z.uuid(),
    salaryCurrency: z.string().regex(/^[A-Z]{3}$/),
    dateFormat: z.enum(['ISO', 'DMY', 'MDY']),
    fallbackStartDate: dateSchema.optional(),
    rowOverrides: z
      .record(
        z.string().regex(/^[1-9]\d{0,4}$/),
        employeeSchema
          .omit({ password: true, scheduleEffectiveFrom: true })
          .partial()
          .extend({
            monthlySalary: employeeSchema.shape.monthlySalary
              .unwrap()
              .unwrap()
              .optional(),
          }),
      )
      .refine((values) => Object.keys(values).length <= 100)
      .default({}),
    salaryOverrides: z
      .record(
        z.string().regex(/^[1-9]\d{0,4}$/),
        employeeSchema.shape.monthlySalary.unwrap().unwrap(),
      )
      .refine((values) => Object.keys(values).length <= 100)
      .default({}),
    preview: z.boolean().default(true),
  })
  .strict();
export type EmployeeImport = z.infer<typeof importSchema>;
export type ImportRow = {
  row: number;
  name: string;
  email: string;
  status: 'ready' | 'invalid' | 'skipped' | 'created' | 'failed';
  message?: string;
  employee?: SaveEmployeeDto;
  password?: string;
  salarySource: string;
  draft: Omit<SaveEmployeeDto, 'monthlySalary'> & {
    monthlySalary: number | null;
  };
};

function csvRecords(csv: string) {
  const records: { row: number; cells: string[] }[] = [];
  let cells: string[] = [],
    value = '',
    quoted = false,
    closed = false;
  let line = 1,
    row = 1;
  const field = () => {
    cells.push(value.trim());
    value = '';
    closed = false;
  };
  const record = () => {
    field();
    if (cells.some(Boolean)) records.push({ row, cells });
    cells = [];
  };
  csv = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        value += c;
        if (c === '\n') line++;
      }
    } else if (c === ',') field();
    else if (c === '\n' || c === '\r') {
      record();
      if (c === '\r' && csv[i + 1] === '\n') i++;
      line++;
      row = line;
    } else if (c === '"' && value === '' && !closed) quoted = true;
    else {
      if (closed || c === '"')
        throw new BadRequestException(`Invalid CSV quoting at line ${line}`);
      value += c;
    }
  }
  if (quoted) throw new BadRequestException('Unclosed CSV quote');
  record();
  return records;
}

function joinedDate(value: string, input: EmployeeImport) {
  if (!value) return input.fallbackStartDate ?? '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parts = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!parts || input.dateFormat === 'ISO') return '';
  const [, a, b, year] = parts;
  const [month, day] = input.dateFormat === 'MDY' ? [a, b] : [b, a];
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function salaryAmount(value: string) {
  if (/^\d+(?:\.\d{1,2})?k$/i.test(value))
    return Math.round(Number(value.slice(0, -1)) * 1000);
  if (/^\d{1,3}(?:\.\d{3})+$/.test(value))
    return Number(value.replaceAll('.', ''));
  return /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value)
    ? Number(value.replaceAll(',', ''))
    : NaN;
}

export function parseEmployeeCsv(input: EmployeeImport): ImportRow[] {
  const [header, ...records] = csvRecords(input.csv);
  const required = [
    'Full Name',
    'National ID',
    'Email',
    'Job Title',
    'Date Joined',
    'Monthly Salary',
  ];
  if (
    !header ||
    new Set(header.cells).size !== header.cells.length ||
    required.some((name) => !header.cells.includes(name))
  )
    throw new BadRequestException(
      `CSV must contain unique headers: ${required.join(', ')}`,
    );
  if (!records.length || records.length > 100)
    throw new BadRequestException('Upload between 1 and 100 responses per CSV');
  return records.map(({ row, cells }) => {
    if (cells.length !== header.cells.length)
      throw new BadRequestException(
        `CSV line ${row} has the wrong number of columns`,
      );
    const get = (name: string) => cells[header.cells.indexOf(name)];
    const salary = get('Monthly Salary');
    const amount = input.salaryOverrides[String(row)] ?? salaryAmount(salary);
    const draft = {
      name: get('Full Name'),
      nationalId: get('National ID'),
      email: get('Email'),
      jobTitle: get('Job Title'),
      startDate: joinedDate(get('Date Joined'), input),
      monthlySalary: amount,
      branchId: input.branchId,
      department: input.department,
      scheduleId: input.scheduleId,
      salaryCurrency: input.salaryCurrency,
      role: 'employee' as const,
      active: true,
      salesEnabled: false,
      managerId: null,
      ...input.rowOverrides[String(row)],
    };
    const result = employeeSchema.safeParse(draft);
    const base = {
      row,
      name: draft.name,
      email: draft.email,
      salarySource: salary,
      draft: {
        ...draft,
        monthlySalary: Number.isFinite(draft.monthlySalary)
          ? draft.monthlySalary
          : null,
      },
    };
    if (!result.success)
      return {
        ...base,
        status: 'invalid',
        message: result.error.issues
          .map((issue) =>
            issue.path[0] === 'monthlySalary'
              ? 'Monthly Salary: enter an amount from 0 to 1000000000 with at most two decimal places, then update the preview.'
              : `${issue.path[0] === 'startDate' ? 'Date Joined (select the matching date format or a fallback for blank dates)' : issue.path.join('.')}: ${issue.message}`,
          )
          .join('; '),
      };
    return {
      ...base,
      email: result.data.email,
      status: 'ready',
      employee: result.data,
    };
  });
}
