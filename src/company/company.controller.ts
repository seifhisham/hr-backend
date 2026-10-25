import { RateLimit } from '../common/security/rate-limit.guard.js';
import {
  Body,
  Controller,
  Get,
  Inject,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { CompanyService } from './company.service.js';
import { companySchema, type UpdateCompanyDto } from './dto/company.dto.js';
@Controller('api/settings')
export class CompanyController {
  constructor(
    @Inject(CompanyService)
    private readonly companyService: CompanyService,
  ) {}
  @Get('locations')
  @RateLimit('geocoding')
  async locations(
    @Req()
    req: AuthRequest,
    @Query('q')
    query: string,
  ) {
    return await this.companyService.searchLocations(req.actor, query);
  }
  @Patch()
  async settings(
    @Req()
    req: AuthRequest,
    @Body(new ZodValidationPipe(companySchema))
    body: UpdateCompanyDto,
  ) {
    return await this.companyService.updateSettings(req.actor, body);
  }
}
