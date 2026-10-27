import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../common/types/actor.type.js';
import {
  DatabaseService,
  type DatabaseRow,
} from '../database/database.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { FirebaseSender, deliveryFailure } from './firebase-sender.js';

@Injectable()
export class PushWorker {
  private timer?: ReturnType<typeof setInterval>;
  private processing = false;
  private stopping = false;
  private readonly logger = new Logger(PushWorker.name);

  constructor(
    @Inject(DatabaseService) private readonly store: DatabaseService,
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
    @Inject(FirebaseSender) private readonly sender: FirebaseSender,
  ) {}

  onModuleInit() {
    if (process.env.HR_PUSH_ENABLED !== 'true') return;
    this.timer = setInterval(() => void this.tick(), 10000);
    this.timer.unref();
  }

  onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
  }

  async tick() {
    if (this.processing || this.stopping) return;
    this.processing = true;
    try {
      for (const companyId of await this.store.activeCompanyIds()) {
        if (this.stopping) break;
        try {
          await this.store.withCompany(companyId, () => this.sweep());
        } catch {
          this.logger.warn('Push company sweep deferred');
        }
      }
    } catch {
      this.logger.warn('Push sweep unavailable');
    } finally {
      this.processing = false;
    }
  }

  private async asRecipient<T>(
    device: DatabaseRow,
    work: (actor: Actor) => Promise<T>,
  ) {
    const row = await this.store.sessionActor(
      device.session_hash as string,
      new Date().toISOString(),
    );
    if (
      !row ||
      row.company_id !== this.store.companyId ||
      row.id !== device.user_id
    )
      return;
    const actor: Actor = {
      companyId: row.company_id as string,
      id: row.id as string,
      name: row.name as string,
      email: row.email as string,
      role: row.role as Actor['role'],
      employeeId: row.employee_id as string | null,
    };
    return this.store.withSession(actor, device.session_hash as string, () =>
      work(actor),
    );
  }

  async sweep() {
    const devices = await this.store
      .prepare('SELECT * FROM push_devices ORDER BY registered_at,device_id')
      .all();
    for (const device of devices) {
      if (this.stopping) return;
      try {
        await this.asRecipient(device, async (actor) => {
          const { items } = await this.notifications.list(actor);
          await this.store.transaction(async () => {
            for (const item of items.filter((item) => !item.readAt)) {
              // The inbox sources (audit/request/attendance) are already committed.
              // Persist a minimal inbox event and its delivery together before any network call.
              await this.store
                .prepare(
                  `INSERT INTO push_events(user_id,notification_id,type)
                VALUES(?,?,?) ON CONFLICT DO NOTHING`,
                )
                .run(actor.id, item.id, item.type);
              await this.store
                .prepare(
                  `INSERT INTO push_deliveries(user_id,notification_id,device_id)
                SELECT ?,?,device_id FROM push_devices
                WHERE device_id=? AND binding_id=? ON CONFLICT DO NOTHING`,
                )
                .run(actor.id, item.id, device.device_id, device.binding_id);
            }
          });
        });
      } catch {
        this.logger.warn('Push recipient scan deferred');
      }
    }

    // A lease survives crashes; its ID fences late completion by an older worker.
    for (let index = 0; index < 20 && !this.stopping; index++) {
      const lease = randomUUID();
      const delivery = await this.store.transaction(async () => {
        await this.store
          .prepare(
            `UPDATE push_deliveries SET state='failed',last_code='attempts-exhausted',finished_at=now()
          WHERE state='pending' AND attempts>=6 AND (lease_until IS NULL OR lease_until<now())`,
          )
          .run();
        return this.store
          .prepare(
            `UPDATE push_deliveries SET lease_id=?,lease_until=now()+interval '10 minutes',attempts=attempts+1
          WHERE (company_id,user_id,notification_id,device_id) IN (
            SELECT company_id,user_id,notification_id,device_id FROM push_deliveries
            WHERE state='pending' AND attempts<6 AND next_attempt<=now() AND (lease_until IS NULL OR lease_until<now())
            ORDER BY next_attempt LIMIT 1 FOR UPDATE SKIP LOCKED
          ) RETURNING *`,
          )
          .get(lease);
      });
      if (!delivery) break;
      const heartbeat = setInterval(() => {
        void this.store
          .prepare(
            `UPDATE push_deliveries SET lease_until=now()+interval '10 minutes'
          WHERE lease_id=? AND state='pending'`,
          )
          .run(lease)
          .catch(() => this.logger.warn('Push lease renewal failed'));
      }, 60000);
      heartbeat.unref();
      try {
        await this.deliver(delivery, lease);
      } catch {
        // Leave the lease recoverable if the database/session check failed.
        this.logger.warn('Push delivery deferred');
      } finally {
        clearInterval(heartbeat);
      }
    }
  }

  private async finish(
    row: DatabaseRow,
    lease: string,
    state: string,
    code: string,
    delay = 0,
  ) {
    await this.store
      .prepare(
        `UPDATE push_deliveries SET state=?,last_code=?,lease_id=NULL,lease_until=NULL,
      next_attempt=?,finished_at=CASE WHEN ?='pending' THEN NULL ELSE now() END
      WHERE user_id=? AND notification_id=? AND device_id=? AND lease_id=?`,
      )
      .run(
        state,
        code,
        new Date(Date.now() + delay).toISOString(),
        state,
        row.user_id,
        row.notification_id,
        row.device_id,
        lease,
      );
    this.logger.log(`Push delivery ${state} (${code})`);
  }

  private async deliver(row: DatabaseRow, lease: string) {
    const device = await this.store
      .prepare(
        `SELECT * FROM push_devices
      WHERE device_id=? AND user_id=?`,
      )
      .get(row.device_id, row.user_id);
    if (!device) return this.finish(row, lease, 'cancelled', 'binding-changed');
    const processed = await this.asRecipient(device, async (actor) => {
      // Reuse the inbox's current branch grants, manager assignment, status and read state.
      const item = (await this.notifications.list(actor)).items.find(
        (item) => item.id === row.notification_id && !item.readAt,
      );
      if (!item) {
        await this.finish(row, lease, 'cancelled', 'ineligible');
        return true;
      }
      const current = await this.store
        .prepare(
          `SELECT 1 FROM push_devices
        WHERE device_id=? AND binding_id=? AND user_id=?`,
        )
        .get(device.device_id, device.binding_id, row.user_id);
      if (!current) {
        await this.finish(row, lease, 'cancelled', 'binding-changed');
        return true;
      }
      try {
        await this.sender.send(device.token as string, item.id, item.type);
      } catch (error) {
        const failure = deliveryFailure(error, Number(row.attempts));
        if (failure.invalid) {
          await this.store
            .prepare(
              'DELETE FROM push_devices WHERE device_id=? AND binding_id=?',
            )
            .run(device.device_id, device.binding_id);
        }
        await this.finish(
          row,
          lease,
          failure.retry ? 'pending' : 'failed',
          failure.code,
          failure.delay,
        );
        return true;
      }
      await this.finish(row, lease, 'sent', 'accepted');
      return true;
    });
    if (!processed)
      await this.finish(row, lease, 'cancelled', 'session-revoked');
  }
}
