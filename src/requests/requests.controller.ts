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
import {
  decisionSchema,
  requestSchema,
  type RequestDecisionDto,
  type SubmitRequestDto,
} from './dto/request.dto.js';
import { RequestsService } from './requests.service.js';

@Controller('api/requests')
export class RequestsController {
  constructor(
    @Inject(RequestsService) private readonly requestsService: RequestsService,
  ) {}
  @Get('me') myRequests(@Req() req: AuthRequest) {
    return this.requestsService.requests(req.actor, true);
  }

  @Get() requests(@Req() req: AuthRequest) {
    return this.requestsService.requests(req.actor);
  }

  @Post() submitRequest(
    @Req() req: AuthRequest,
    @Body(new ZodValidationPipe(requestSchema)) body: SubmitRequestDto,
  ) {
    return this.requestsService.submitRequest(req.actor, body);
  }

  @Patch(':id/decision') decideRequest(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decisionSchema)) body: RequestDecisionDto,
  ) {
    return this.requestsService.decideRequest(
      req.actor,
      parse(z.uuid(), id),
      body,
    );
  }
}
