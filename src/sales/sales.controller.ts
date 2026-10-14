import { RateLimit } from '../common/security/rate-limit.guard.js';
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { parse } from '../common/validation/parse.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import {
  createActivitySchema,
  updateActivitySchema,
  filtersSchema,
  reviewSchema,
  targetSchema,
} from './sales.dto.js';
import { SalesService } from './sales.service.js';

@Controller('api/sales')
export class SalesController {
  constructor(@Inject(SalesService) private readonly sales: SalesService) {}
  @Get('access') access(@Req() req: AuthRequest) {
    return this.sales.access(req.actor);
  }
  @RateLimit('reports')
  @Get('activities/me')
  own(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.sales.list(req.actor, parse(filtersSchema, query), true);
  }
  @RateLimit('reports')
  @Get('activities')
  list(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.sales.list(req.actor, parse(filtersSchema, query));
  }
  @Get('activities/:id') get(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.sales.get(req.actor, parse(z.uuid(), id));
  }
  @Post('activities') create(
    @Req() req: AuthRequest,
    @Body(new ZodValidationPipe(createActivitySchema))
    body: z.infer<typeof createActivitySchema>,
  ) {
    return this.sales.create(req.actor, body.id, body.activity);
  }
  @Patch('activities/:id') update(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateActivitySchema))
    body: z.infer<typeof updateActivitySchema>,
  ) {
    return this.sales.update(
      req.actor,
      parse(z.uuid(), id),
      body.expectedRevision,
      body.activity,
    );
  }
  @Patch('activities/:id/review') review(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reviewSchema))
    body: z.infer<typeof reviewSchema>,
  ) {
    return this.sales.review(req.actor, parse(z.uuid(), id), body);
  }
  @RateLimit('reports')
  @Get('performance/me')
  ownPerformance(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.sales.performance(
      req.actor,
      parse(filtersSchema.pick({ month: true }), query),
      true,
    );
  }
  @RateLimit('reports')
  @Get('performance')
  performance(@Req() req: AuthRequest, @Query() query: unknown) {
    return this.sales.performance(
      req.actor,
      parse(filtersSchema.omit({ kind: true, status: true }), query),
    );
  }
  @Post('targets') target(
    @Req() req: AuthRequest,
    @Body(new ZodValidationPipe(targetSchema))
    body: z.infer<typeof targetSchema>,
  ) {
    return this.sales.saveTarget(req.actor, body);
  }
  @RateLimit('exports')
  @Get('export')
  export(
    @Req() req: AuthRequest,
    @Query() query: unknown,
    @Res() res: Response,
  ) {
    const filters = parse(
      filtersSchema.omit({ kind: true, status: true }),
      query,
    );
    const rows = this.sales.performance(req.actor, filters);
    const cell = (value: string | number | null | undefined) => {
      const text = String(value ?? '');
      const safe = /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const csv = [
      [
        'Month',
        'Employee ID',
        'Name',
        'Department',
        'Verified meetings',
        'Verified viewings',
        'Signed sales',
        'Signed leases',
        'Contract values by currency',
        'Pending',
        'Returned',
        'Meetings/viewings target',
        'Deals target',
        'Contract value target',
        'Target currency',
        'Meetings achievement %',
        'Deals achievement %',
        'Contract value achievement %',
      ],
      ...rows.map((row) => [
        row.month,
        row.employeeNumber,
        row.employeeName,
        row.department,
        row.meetings,
        row.viewings,
        row.sales,
        row.leases,
        Object.entries(row.transactionValues)
          .map(([currency, value]) => `${currency} ${value}`)
          .join('; '),
        row.pending,
        row.returned,
        row.target?.meetings,
        row.target?.deals,
        row.target?.transactionValue,
        row.target?.currency,
        row.achievement.meetings,
        row.achievement.deals,
        row.achievement.transactionValue,
      ]),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="sales-performance-${filters.month}.csv"`,
    );
    res.send(`\uFEFF${csv}`);
  }
}
