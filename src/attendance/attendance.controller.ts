import { Personal } from '../common/decorators/personal.decorator.js';
import { RateLimit } from '../common/security/rate-limit.guard.js';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service.js';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { parse } from '../common/validation/parse.js';
import { dateSchema } from '../common/validation/schemas.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { CompanyService } from '../company/company.service.js';
import {
  AttendanceEvidence,
  officePolicy,
} from './attendance-evidence.service.js';
import { localTime } from './attendance-time.js';
import { AttendanceService } from './attendance.service.js';
import { AttendanceReportCompression } from './attendance-report-compression.interceptor.js';
import { AttendanceLocationService } from './attendance-location.service.js';
import {
  correctionSchema,
  filtersSchema,
  manualAttendanceSchema,
  type AttendanceCorrectionDto,
  type ManualAttendanceDto,
} from './dto/attendance.dto.js';
const attendanceUpload = () =>
  FileInterceptor('photo', {
    limits: {
      fileSize: officePolicy.maxPhotoBytes,
      files: 1,
      fields: 4,
      fieldSize: 256,
      parts: 5,
    },
  });
@Controller('api/attendance')
export class AttendanceController {
  constructor(
    @Inject(AuthService)
    private readonly authService: AuthService,
    @Inject(CompanyService)
    private readonly companyService: CompanyService,
    @Inject(AttendanceService)
    private readonly attendanceService: AttendanceService,
    @Inject(AttendanceEvidence)
    private readonly evidence: AttendanceEvidence,
    @Inject(AttendanceLocationService)
    private readonly location: AttendanceLocationService,
  ) {}
  @Get('me')
  @Personal()
  async mine(
    @Req()
    req: AuthRequest,
  ) {
    return await this.attendanceService.myAttendance(req.actor);
  }
  @Get('policy')
  @Personal()
  async policy(@Req() req: AuthRequest) {
    const policy = await this.attendanceService.policy(req.actor);
    return {
      ...officePolicy,
      ...policy,
      tracking: {
        ...(await this.location.policy()),
        radiusMeters: policy.trackingRadiusMeters,
        graceSeconds: policy.trackingGraceMinutes * 60,
      },
    };
  }
  @Post(':id/location')
  @Personal()
  async locationUpdate(
    @Req()
    req: AuthRequest,
    @Param('id')
    id: string,
    @Body()
    body: unknown,
  ) {
    return await this.location.update(req.actor, parse(z.uuid(), id), body);
  }
  @RateLimit('photos')
  @Post('check-in')
  @UseInterceptors(attendanceUpload())
  @Personal()
  async checkIn(
    @Req()
    req: AuthRequest,
    @Body()
    body: unknown,
    @UploadedFile()
    photo?: Express.Multer.File,
  ) {
    const evidence = await this.evidence.prepare(
      body,
      photo,
      await this.attendanceService.policy(req.actor),
    );
    return await this.attendanceService.checkIn(
      await this.authService.authenticate(req.sessionToken),
      evidence,
    );
  }
  @RateLimit('photos')
  @Post(':id/check-out')
  @UseInterceptors(attendanceUpload())
  @Personal()
  async checkOut(
    @Req()
    req: AuthRequest,
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @UploadedFile()
    photo?: Express.Multer.File,
  ) {
    const evidence = await this.evidence.prepare(
      body,
      photo,
      await this.attendanceService.policy(req.actor, parse(z.uuid(), id)),
    );
    return await this.attendanceService.checkOut(
      await this.authService.authenticate(req.sessionToken),
      parse(z.uuid(), id),
      evidence,
    );
  }
  @Get(':id/evidence')
  @Personal()
  async evidenceList(
    @Req()
    req: AuthRequest,
    @Param('id')
    id: string,
  ) {
    return await this.evidence.list(req.actor, parse(z.uuid(), id));
  }
  @Get(':id/photos/:event')
  @Personal()
  async photo(
    @Req()
    req: AuthRequest,
    @Param('id')
    id: string,
    @Param('event')
    event: string,
    @Res({ passthrough: true })
    res: Response,
  ) {
    const photo = await this.evidence.photo(
      req.actor,
      parse(z.uuid(), id),
      parse(z.enum(['check-in', 'check-out']), event),
    );
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(photo);
  }
  @RateLimit('reports')
  @Get()
  @UseInterceptors(AttendanceReportCompression)
  async report(
    @Req()
    req: AuthRequest,
    @Query()
    query: unknown,
  ) {
    const rows = await this.attendanceService.report(
      req.actor,
      await this.filters(query),
    );
    await this.authorizeReport(req);
    return rows;
  }
  @Post()
  async manual(
    @Req()
    req: AuthRequest,
    @Body(new ZodValidationPipe(manualAttendanceSchema))
    body: ManualAttendanceDto,
  ) {
    return await this.attendanceService.manualAttendance(req.actor, body);
  }
  @Patch(':id')
  async correction(
    @Req()
    req: AuthRequest,
    @Param('id')
    id: string,
    @Body(new ZodValidationPipe(correctionSchema))
    body: AttendanceCorrectionDto,
  ) {
    return await this.attendanceService.correct(
      req.actor,
      parse(z.uuid(), id),
      body,
    );
  }
  @RateLimit('exports')
  @Get('export')
  async export(
    @Req()
    req: AuthRequest,
    @Query()
    query: unknown,
    @Res({ passthrough: true })
    res: Response,
  ) {
    const filters = await this.filters(query);
    const rows = await this.attendanceService.report(req.actor, filters);
    await this.authorizeReport(req);
    const cell = (value: string | number | null) => {
      const text = String(value ?? '');
      const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const csv = [
      [
        'National ID',
        'Name',
        'Department',
        'Branch',
        'Workday',
        'Check-in (UTC)',
        'Check-out (UTC)',
        'Timezone',
        'Status',
        'Hours',
        'Location status',
        'Return deadline (UTC)',
      ],
      ...rows.map((r) => [
        r.nationalId,
        r.name,
        r.department,
        r.branchName ?? '',
        r.workDate,
        r.checkIn,
        r.checkOut,
        r.timezone,
        r.status,
        r.hours,
        r.location?.status ?? null,
        r.location?.returnBy ?? null,
      ]),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="attendance-${filters.from}-${filters.to}.csv"`,
    );
    return `\uFEFF${csv}`;
  }
  private async authorizeReport(req: AuthRequest) {
    const current = await this.authService.authenticate(req.sessionToken);
    if (
      current.role !== req.actor.role ||
      current.employeeId !== req.actor.employeeId
    )
      throw new ForbiddenException('Your access changed. Sign in again.');
  }
  private async filters(value: unknown) {
    const today = localTime(
      new Date(),
      (await this.companyService.settings()).timezone,
    ).date;
    const query = parse(
      z
        .object({
          from: dateSchema.optional(),
          to: dateSchema.optional(),
          employeeId: z.string().optional(),
          branchId: z.uuid().optional(),
          department: z.string().optional(),
          status: z.string().optional(),
        })
        .strict(),
      value,
    );
    return parse(filtersSchema, {
      ...query,
      from: query.from ?? today,
      to: query.to ?? query.from ?? today,
    });
  }
}
