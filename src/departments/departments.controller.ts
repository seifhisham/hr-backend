import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import {
  departmentSchema,
  type CreateDepartmentDto,
} from './dto/department.dto.js';
import { DepartmentsService } from './departments.service.js';
@Controller('api/departments')
export class DepartmentsController {
  constructor(
    @Inject(DepartmentsService)
    private readonly service: DepartmentsService,
  ) {}
  @Get()
  async list(
    @Req()
    req: AuthRequest,
  ) {
    return await this.service.list(req.actor);
  }
  @Post()
  async create(
    @Req()
    req: AuthRequest,
    @Body(new ZodValidationPipe(departmentSchema))
    input: CreateDepartmentDto,
  ) {
    return await this.service.create(req.actor, input);
  }
}
