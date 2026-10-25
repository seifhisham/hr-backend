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
import { employeeSchema, type SaveEmployeeDto } from './dto/employee.dto.js';
import { EmployeesService } from './employees.service.js';
@Controller('api/employees')
export class EmployeesController {
  constructor(
    @Inject(EmployeesService)
    private readonly employeesService: EmployeesService,
  ) {}
  @Get()
  async employees(
    @Req()
    req: AuthRequest,
  ) {
    return await this.employeesService.employees(req.actor);
  }
  @Get('reports')
  async reports(
    @Req()
    req: AuthRequest,
  ) {
    return await this.employeesService.reports(req.actor);
  }
  @Get(':id/schedules')
  async scheduleHistory(
    @Req()
    req: AuthRequest,
    @Param('id')
    id: string,
  ) {
    return await this.employeesService.scheduleHistory(
      req.actor,
      parse(z.uuid(), id),
    );
  }
  @Post()
  async createEmployee(
    @Req()
    req: AuthRequest,
    @Body(new ZodValidationPipe(employeeSchema))
    body: SaveEmployeeDto,
  ) {
    return await this.employeesService.saveEmployee(req.actor, body);
  }
  @Patch(':id')
  async updateEmployee(
    @Req()
    req: AuthRequest,
    @Param('id')
    id: string,
    @Body(new ZodValidationPipe(employeeSchema))
    body: SaveEmployeeDto,
  ) {
    return await this.employeesService.saveEmployee(
      req.actor,
      body,
      parse(z.uuid(), id),
    );
  }
}
