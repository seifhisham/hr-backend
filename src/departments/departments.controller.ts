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
    @Inject(DepartmentsService) private readonly service: DepartmentsService,
  ) {}
  @Get() list(@Req() req: AuthRequest) {
    return this.service.list(req.actor);
  }
  @Post() create(
    @Req() req: AuthRequest,
    @Body(new ZodValidationPipe(departmentSchema))
    input: CreateDepartmentDto,
  ) {
    return this.service.create(req.actor, input);
  }
}
