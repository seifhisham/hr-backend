import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(
    z
      .object({
        name: z.string().trim().min(1),
        count: z.coerce.number().int().positive(),
      })
      .strict(),
  );

  it('returns parsed and normalized input', () => {
    expect(pipe.transform({ name: ' Employee ', count: '2' })).toEqual({
      name: 'Employee',
      count: 2,
    });
  });

  it('rejects invalid input as a bad request', () => {
    expect(() => pipe.transform({ name: '', count: 0 })).toThrow(
      BadRequestException,
    );
  });

  it('rejects fields outside the DTO contract', () => {
    expect(() =>
      pipe.transform({ name: 'Employee', count: 2, role: 'admin' }),
    ).toThrow(BadRequestException);
  });
});
