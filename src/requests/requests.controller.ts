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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '../auth/types/auth-request.type.js';
import { parse } from '../common/validation/parse.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import {
  decisionSchema,
  requestChangeSchema,
  requestSchema,
  requestPageSchema,
  hrRequestPageSchema,
  type HrRequestPageDto,
  type RequestPageDto,
  type RequestDecisionDto,
  type SubmitRequestDto,
} from './dto/request.dto.js';
import { RequestsService } from './requests.service.js';
/** Total matching requests across all pages; the body stays a plain array. */
function total(res: Response, count: number) {
  res.setHeader('X-Total-Count', String(count));
}
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
    @Res({ passthrough: true })
    res: Response,
  ) {
    const rows = await this.requestsService.requests(req.actor, true, page);
    total(
      res,
      await this.requestsService.requestCount(req.actor, true, page.status),
    );
    return rows;
  }
  @Get('managed')
  @Personal()
  async managedRequests(
    @Req()
    req: AuthRequest,
    @Query(new ZodValidationPipe(requestPageSchema))
    page: RequestPageDto,
  ) {
    // No X-Total-Count here: counting would rebuild every pending workflow on
    // each page. Pages are filled to `limit`, so a short page marks the end.
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
    @Query(new ZodValidationPipe(hrRequestPageSchema))
    page: HrRequestPageDto,
    @Res({ passthrough: true })
    res: Response,
  ) {
    const rows = await this.requestsService.requests(req.actor, false, page);
    total(
      res,
      await this.requestsService.requestCount(
        req.actor,
        false,
        page.status,
        page.employeeId,
      ),
    );
    return rows;
  }
  @Get(':id')
  async request(
    @Req()
    req: AuthRequest,
    @Param('id')
    id: string,
  ) {
    return await this.requestsService.request(req.actor, parse(z.uuid(), id));
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
