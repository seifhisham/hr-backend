import { Body, Controller, Inject, Patch, Req } from '@nestjs/common';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { CompanyService } from './company.service.js';
import { companySchema, type UpdateCompanyDto } from './dto/company.dto.js';

@Controller('api/settings')
export class CompanyController {
  constructor(
    @Inject(CompanyService) private readonly companyService: CompanyService,
  ) {}
  @Patch() settings(
    @Req() req: AuthRequest,
    @Body(new ZodValidationPipe(companySchema)) body: UpdateCompanyDto,
  ) {
    return this.companyService.updateSettings(req.actor, body);
  }
}
