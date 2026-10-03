import { Injectable, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { parse } from './parse.js';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    return parse(this.schema, value);
  }
}
