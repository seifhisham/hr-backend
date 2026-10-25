import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { parse } from '../common/validation/parse.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { scheduleSchema, type SaveScheduleDto } from './dto/schedule.dto.js';
import { SchedulesService } from './schedules.service.js';
@Controller('api/schedules')
export class SchedulesController {
  constructor(
    @Inject(SchedulesService)
    private readonly schedulesService: SchedulesService,
  ) {}
  @Get()
  async schedules() {
    return await this.schedulesService.schedules();
  }
  @Post()
  async createSchedule(
    @Req()
    req: AuthRequest,
    @Body(new ZodValidationPipe(scheduleSchema))
    body: SaveScheduleDto,
  ) {
    return await this.schedulesService.saveSchedule(req.actor, body);
  }
  @Patch(':id')
  async updateSchedule(
    @Req()
    req: AuthRequest,
    @Param('id')
    id: string,
    @Body(new ZodValidationPipe(scheduleSchema))
    body: SaveScheduleDto,
  ) {
    return await this.schedulesService.saveSchedule(
      req.actor,
      body,
      parse(z.uuid(), id),
    );
  }
}
