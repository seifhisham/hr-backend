import { Injectable } from '@nestjs/common';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

export const FIREBASE_PROJECT = 'wsc-hr-ebe11';

@Injectable()
export class FirebaseSender {
  private messaging?: Messaging;

  onModuleInit() {
    if (process.env.HR_PUSH_ENABLED !== 'true') return;
    if (process.env.HR_FIREBASE_PROJECT_ID !== FIREBASE_PROJECT)
      throw new Error('HR_FIREBASE_PROJECT_ID must be wsc-hr-ebe11');
    for (const name of ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT']) {
      if (process.env[name] && process.env[name] !== FIREBASE_PROJECT)
        throw new Error(`${name} conflicts with the Hodour Firebase project`);
    }
    const app =
      getApps().find((app) => app.name === 'hodour-push') ??
      initializeApp(
        {
          credential: applicationDefault(),
          projectId: FIREBASE_PROJECT,
        },
        'hodour-push',
      );
    if (app.options.projectId !== FIREBASE_PROJECT)
      throw new Error('Hodour Firebase app project mismatch');
    this.messaging = getMessaging(app);
  }

  async send(token: string, notificationId: string, type: string) {
    if (!this.messaging) throw new Error('Push sender is disabled');
    await this.messaging.send({
      token,
      notification: {
        title: 'Hodour',
        body: 'You have a new notification. Open Hodour to view it.',
      },
      data: { notificationId, type },
      android: {
        restrictedPackageName: 'com.wsc.hodour',
        ttl: 3600000,
        notification: { channelId: 'hodour_push', tag: notificationId },
      },
    });
  }
}

export function deliveryFailure(
  error: unknown,
  attempt: number,
  now = Date.now(),
) {
  const value = error as {
    code?: string;
    httpResponse?: { headers?: Record<string, string> };
  } | null;
  const code = value?.code ?? 'unknown';
  const invalid = [
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
  ].includes(code);
  const transient = [
    'messaging/server-unavailable',
    'messaging/internal-error',
    'messaging/unknown-error',
    'messaging/message-rate-exceeded',
    'messaging/device-message-rate-exceeded',
    'messaging/quota-exceeded',
    'app/network-error',
    'app/network-timeout',
  ].includes(code);
  const header = value?.httpResponse?.headers?.['retry-after'];
  const retryAfter = header
    ? /^\d+$/.test(header)
      ? Number(header) * 1000
      : Date.parse(header) - now
    : 0;
  // Firebase requires at least a minute for quota retries; jitter spreads each device's retry.
  const delay = Math.max(
    60000 * 2 ** (attempt - 1) + Math.random() * 30000,
    Number.isFinite(retryAfter) ? retryAfter : 0,
  );
  return {
    invalid,
    retry: transient && attempt < 6,
    delay,
    code: /^(messaging|app)\/[a-z-]+$/.test(code) ? code : 'unknown',
  };
}
