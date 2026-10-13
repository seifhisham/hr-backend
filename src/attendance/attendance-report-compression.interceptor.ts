import {
  Injectable,
  StreamableFile,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { mergeMap } from 'rxjs';
import type { ReportRow } from './types/attendance.type.js';

const compress = promisify(gzip);

@Injectable()
export class AttendanceReportCompression implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler<ReportRow[]>) {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    response.vary('Accept-Encoding');
    response.vary('User-Agent');
    response.setHeader('Cache-Control', 'no-store');
    // shortcut: Node 24 fetch needs identity on closing sockets, retest after a runtime upgrade.
    if (
      request.get('User-Agent') === 'node' &&
      request.get('Connection')?.toLowerCase().includes('close')
    )
      return next.handle();
    if (request.acceptsEncodings('gzip', 'identity') !== 'gzip')
      return next.handle();
    return next.handle().pipe(
      mergeMap(async (rows) => {
        const json = JSON.stringify(rows);
        if (Buffer.byteLength(json) < 64 * 1024) return rows;
        let compressed: Buffer;
        try {
          compressed = await compress(json, { level: 1 });
        } catch {
          return rows;
        }
        response.setHeader('Content-Encoding', 'gzip');
        return new StreamableFile(compressed, {
          type: 'application/json; charset=utf-8',
          length: compressed.length,
        });
      }),
    );
  }
}
