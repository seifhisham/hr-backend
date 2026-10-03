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
  @Get() employees(@Req() req: AuthRequest) {
    return this.employeesService.employees(req.actor);
  }

  @Post() createEmployee(
    @Req() req: AuthRequest,
    @Body(new ZodValidationPipe(employeeSchema)) body: SaveEmployeeDto,
  ) {
    return this.employeesService.saveEmployee(req.actor, body);
  }

  @Patch(':id') updateEmployee(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(employeeSchema)) body: SaveEmployeeDto,
  ) {
    return this.employeesService.saveEmployee(
      req.actor,
      body,
      parse(z.uuid(), id),
    );
  }
}
