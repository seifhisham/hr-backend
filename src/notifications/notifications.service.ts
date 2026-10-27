import { RequestsService } from '../requests/requests.service.js';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  attendance,
  type AttendanceRow,
} from '../attendance/attendance.mapper.js';
import { attendanceStatus } from '../attendance/attendance-time.js';
import type { Actor } from '../common/types/actor.type.js';
import { DatabaseService } from '../database/database.service.js';
import type { Employee } from '../employees/types/employee.type.js';
import type { EmployeeRequest } from '../requests/types/employee-request.type.js';
export type Notification = {
  id: string;
  type:
    | 'manager-review-required'
    | 'manager-reviewed'
    | 'request-decided'
    | 'request-reopened'
    | 'pending-request'
    | 'employee-checked-in'
    | 'employee-checked-out'
    | 'missing-check-out';
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
  requestId?: string;
  attendanceId?: string;
};
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DatabaseService)
    private readonly store: DatabaseService,
    @Inject(RequestsService)
    private readonly requests: RequestsService,
  ) {}
  async list(actor: Actor): Promise<{
    items: Notification[];
    unreadCount: number;
  }> {
    const db = this.store.db;
    const items: Notification[] = [];
    if (actor.employeeId && ['manager', 'hr', 'admin'].includes(actor.role)) {
      for (const row of await db
        .prepare(
          `
        SELECT a.id,a.at,a.action,a.record_id,e.data::jsonb->>'name' AS employee_name
        FROM audit a JOIN attendance t ON t.id=a.record_id
        JOIN employees e ON e.id=t.employee_id
        JOIN employees m ON m.id=?
        WHERE a.action IN ('attendance.checked_in','attendance.checked_out','attendance.auto_checked_out')
          AND e.data::jsonb->>'managerId'=? AND e.id<>?
          AND m.data::jsonb->>'active'='true'
          AND m.data::jsonb->>'role' IN ('manager','hr','admin')
        ORDER BY a.row_order DESC LIMIT 100
      `,
        )
        .all(actor.employeeId, actor.employeeId, actor.employeeId)) {
        const checkedIn = row.action === 'attendance.checked_in';
        const action = checkedIn ? 'checked in' : 'checked out';
        items.push({
          id: row.id as string,
          type: checkedIn ? 'employee-checked-in' : 'employee-checked-out',
          title: `Direct report ${action}`,
          message: `${row.employee_name as string} ${action}`,
          createdAt: row.at as string,
          readAt: null,
          attendanceId: row.record_id as string,
        });
      }
    }
    // Decisions already have a durable, transactional audit event. Use its ID
    // so repeated reads never create duplicate notifications.
    if (actor.employeeId) {
      for (const row of await this.store.personal(async () =>
        db
          .prepare(
            `
        SELECT id, at, action, actor_name, reason, after_data FROM audit
        WHERE action IN ('request.approved', 'request.rejected', 'request.reopened', 'request.manager_reviewed')
          AND (after_data::jsonb->>'employeeId') = ?
        ORDER BY row_order DESC LIMIT 100
      `,
          )
          .all(actor.employeeId),
      )) {
        const request = JSON.parse(row.after_data as string) as EmployeeRequest;
        const reopened = row.action === 'request.reopened';
        const managerReviewed = row.action === 'request.manager_reviewed';
        items.push({
          id: row.id as string,
          type: managerReviewed
            ? 'manager-reviewed'
            : reopened
              ? 'request-reopened'
              : 'request-decided',
          title: managerReviewed
            ? `Manager recommended ${request.managerReview?.status}; awaiting HR`
            : reopened
              ? 'Request reopened for correction'
              : `Request ${request.status}`,
          message: `${request.type.replaceAll('-', ' ')}: ${row.reason as string} (${row.actor_name as string})`,
          createdAt: row.at as string,
          readAt: null,
          requestId: request.id,
        });
      }
    }
    {
      const privileged = actor.role === 'hr' || actor.role === 'admin';
      const profiles = new Map<string, Employee>();
      for (const row of await db
        .prepare(
          `SELECT r.data, (SELECT id FROM audit WHERE record_id = r.id
          AND action IN ('request.submitted', 'request.reopened', 'request.manager_reviewed', 'request.manager_review_reset') ORDER BY row_order DESC LIMIT 1) AS event_id
          FROM employee_requests r WHERE r.status = 'pending'
          ${privileged ? '' : "AND r.employee_id IN (SELECT id FROM employees WHERE (data::jsonb->>'managerId') = ?)"}`,
        )
        .all(...(privileged ? [] : [actor.employeeId]))) {
        const request = await this.requests.workflow(
          JSON.parse(row.data as string) as EmployeeRequest,
          profiles,
        );
        if (request.employeeId === actor.employeeId) continue;
        const managerPending = request.managerStage === 'pending';
        if (
          managerPending
            ? request.managerEmployeeId !== actor.employeeId
            : actor.role !== 'hr' && actor.role !== 'admin'
        )
          continue;
        if (
          !managerPending &&
          request.managerStage !== 'not-required' &&
          request.managerReview?.employeeId === actor.employeeId
        )
          continue;
        const createdAt =
          (!managerPending && request.managerReview?.reviewedAt) ||
          (request.lastChange?.action === 'reopen'
            ? request.lastChange.at
            : request.submittedAt);
        items.push({
          id: `${managerPending ? 'manager-pending' : 'pending'}:${(row.event_id as string | null) ?? request.id}`,
          type: managerPending ? 'manager-review-required' : 'pending-request',
          title: managerPending
            ? 'Direct report request awaiting your review'
            : 'Request awaiting HR decision',
          message: `${request.employeeName}: ${request.type.replaceAll('-', ' ')}`,
          createdAt,
          readAt: null,
          requestId: request.id,
        });
      }
    }
    if (actor.role === 'hr' || actor.role === 'admin') {
      for (const row of await db
        .prepare(
          `
        SELECT a.*, e.data AS employee_data FROM attendance a
        JOIN employees e ON e.id = a.employee_id WHERE a.check_out IS NULL
      `,
        )
        .all()) {
        const record = attendance(row as AttendanceRow);
        if (attendanceStatus(record, new Date()) !== 'Missing check-out')
          continue;
        const employee = JSON.parse(row.employee_data as string) as Employee;
        items.push({
          id: `missing:${record.id}`,
          type: 'missing-check-out',
          title: 'Missing check-out',
          message: `${employee.name}: ${record.workDate} (${record.timezone})`,
          createdAt: record.checkIn,
          readAt: null,
          attendanceId: record.id,
        });
      }
    }
    const reads = new Map(
      (
        await db
          .prepare(
            'SELECT notification_id, read_at FROM notification_reads WHERE user_id = ?',
          )
          .all(actor.id)
      ).map((row) => [row.notification_id as string, row.read_at as string]),
    );
    for (const item of items) item.readAt = reads.get(item.id) ?? null;
    items.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
    return { items, unreadCount: items.filter((item) => !item.readAt).length };
  }
  async markRead(actor: Actor, id: string) {
    const item = (await this.list(actor)).items.find((item) => item.id === id);
    if (!item) throw new NotFoundException('Notification not found');
    const readAt = item.readAt ?? new Date().toISOString();
    await this.store.db
      .prepare(
        'INSERT INTO notification_reads (user_id, notification_id, read_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      )
      .run(actor.id, id, readAt);
    return { ...item, readAt };
  }
}
