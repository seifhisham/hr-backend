import { FirebaseSender, FIREBASE_PROJECT } from './firebase-sender.js';

const sdk = vi.hoisted(() => ({
  apps: [] as { name: string; options: { projectId: string } }[],
  initialize: vi.fn(),
  send: vi.fn(),
}));
vi.mock('firebase-admin/app', () => ({
  applicationDefault: () => 'adc-credential',
  getApps: () => sdk.apps,
  initializeApp: sdk.initialize,
}));
vi.mock('firebase-admin/messaging', () => ({
  getMessaging: () => ({ send: sdk.send }),
}));

beforeEach(() => {
  sdk.apps.length = 0;
  sdk.initialize.mockReset().mockImplementation((options, name) => {
    const app = { options, name };
    sdk.apps.push(app);
    return app;
  });
  sdk.send.mockReset().mockResolvedValue('accepted');
  vi.stubEnv('HR_PUSH_ENABLED', 'true');
  vi.stubEnv('HR_FIREBASE_PROJECT_ID', FIREBASE_PROJECT);
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
  vi.stubEnv('GCLOUD_PROJECT', '');
});
afterEach(() => vi.unstubAllEnvs());

it('initializes once with ADC and sends generic Android notification plus string data', async () => {
  const sender = new FirebaseSender();
  sender.onModuleInit();
  new FirebaseSender().onModuleInit();
  expect(sdk.initialize).toHaveBeenCalledExactlyOnceWith(
    { credential: 'adc-credential', projectId: FIREBASE_PROJECT },
    'hodour-push',
  );
  await sender.send('registration-token', 'audit-event-id', 'request-decided');
  expect(sdk.send).toHaveBeenCalledWith({
    token: 'registration-token',
    notification: {
      title: 'Hodour',
      body: 'You have a new notification. Open Hodour to view it.',
    },
    data: { notificationId: 'audit-event-id', type: 'request-decided' },
    android: {
      restrictedPackageName: 'com.wsc.hodour',
      ttl: 3600000,
      notification: { channelId: 'hodour_push', tag: 'audit-event-id' },
    },
  });
});

it('rejects a wrong/missing Firebase project or conflicting cloud project', () => {
  vi.stubEnv('HR_FIREBASE_PROJECT_ID', 'another-project');
  expect(() => new FirebaseSender().onModuleInit()).toThrow('wsc-hr-ebe11');
  vi.stubEnv('HR_FIREBASE_PROJECT_ID', '');
  expect(() => new FirebaseSender().onModuleInit()).toThrow('wsc-hr-ebe11');
  vi.stubEnv('HR_FIREBASE_PROJECT_ID', FIREBASE_PROJECT);
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'another-project');
  expect(() => new FirebaseSender().onModuleInit()).toThrow('conflicts');
  expect(sdk.initialize).not.toHaveBeenCalled();
});

it('does not initialize credentials or send while disabled', async () => {
  vi.stubEnv('HR_PUSH_ENABLED', 'false');
  const sender = new FirebaseSender();
  sender.onModuleInit();
  expect(sdk.initialize).not.toHaveBeenCalled();
  await expect(sender.send('token', 'id', 'type')).rejects.toThrow('disabled');
  expect(sdk.send).not.toHaveBeenCalled();
});
