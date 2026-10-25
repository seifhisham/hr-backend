import { Personal } from '../common/decorators/personal.decorator.js';
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
} from '@nestjs/common';
import { z } from 'zod';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { parse } from '../common/validation/parse.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import {
  decisionSchema,
  requestChangeSchema,
  requestSchema,
  requestPageSchema,
  type RequestPageDto,
  type RequestDecisionDto,
  type SubmitRequestDto,
} from './dto/request.dto.js';
import { RequestsService } from './requests.service.js';
@Controller('api/requests')
export class RequestsController {
  constructor(
    @Inject(RequestsService)
    private readonly requestsService: RequestsService,
  ) {}
  @Get('me')
  @Personal()
  async myRequests(
    @Req()
    req: AuthRequest,
    @Query(new ZodValidationPipe(requestPageSchema))
    page: RequestPageDto,
  ) {
    return await this.requestsService.requests(req.actor, true, page);
  }
  @Get('managed')
  @Personal()
  async managedRequests(
    @Req()
    req: AuthRequest,
    @Query(new ZodValidationPipe(requestPageSchema))
    page: RequestPageDto,
  ) {
    return await this.requestsService.managedRequests(req.actor, page);
  }
  @Patch(':id/manager-review')
  @Personal()
  async reviewRequest(
    @Req()
    req: AuthRequest,
    @Param('id')
    id: string,
    @Body(new ZodValidationPipe(decisionSchema))
    body: RequestDecisionDto,
  ) {
    return await this.requestsService.reviewRequest(
      req.actor,
      parse(z.uuid(), id),
      body,
    );
  }
  @Get()
  async requests(
    @Req()
    req: AuthRequest,
    @Query(new ZodValidationPipe(requestPageSchema))
    page: RequestPageDto,
  ) {
    return await this.requestsService.requests(req.actor, false, page);
  }
  @Post()
  @Personal()
  async submitRequest(
    @Req()
    req: AuthRequest,
    @Body(new ZodValidationPipe(requestSchema))
    body: SubmitRequestDto,
  ) {
    return await this.requestsService.submitRequest(req.actor, body);
  }
  @Patch(':id/withdraw')
  @Personal()
  async withdrawRequest(
    @Req()
    req: AuthRequest,
    @Param('id')
    id: string,
    @Body(new ZodValidationPipe(requestChangeSchema))
    body: {
      reason: string;
    },
  ) {
    return await this.requestsService.changeRequest(
      req.actor,
      parse(z.uuid(), id),
      'withdraw',
      body.reason,
    );
  }
  @Patch(':id/reopen')
  async reopenRequest(
    @Req()
    req: AuthRequest,
    @Param('id')
    id: string,
    @Body(new ZodValidationPipe(requestChangeSchema))
    body: {
      reason: string;
    },
  ) {
    return await this.requestsService.changeRequest(
      req.actor,
      parse(z.uuid(), id),
      'reopen',
      body.reason,
    );
  }
  @Patch(':id/decision')
  async decideRequest(
    @Req()
    req: AuthRequest,
    @Param('id')
    id: string,
    @Body(new ZodValidationPipe(decisionSchema))
    body: RequestDecisionDto,
  ) {
    return await this.requestsService.decideRequest(
      req.actor,
      parse(z.uuid(), id),
      body,
    );
  }
}
