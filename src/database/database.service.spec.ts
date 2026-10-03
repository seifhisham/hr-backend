import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from './database.service.js';

it('persists committed data across restarts and rolls back failed changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hr-store-test-'));
  vi.stubEnv('HR_DATABASE_PATH', join(directory, 'test.sqlite'));
  let store = new DatabaseService();
  try {
    store.transaction(() =>
      store.db
        .prepare('INSERT INTO settings VALUES (?, ?)')
        .run('test', 'saved'),
    );
    expect(() =>
      store.transaction(() => {
        store.db.prepare('UPDATE settings SET value = ?').run('unsaved');
        throw new Error('Failed');
      }),
    ).toThrow('Failed');
    store.db
      .prepare('INSERT INTO employees VALUES (?, ?, ?, ?)')
      .run('employee', 'EMP-1', 'employee@test.local', '{}');
    store.db
      .prepare('INSERT INTO employee_requests VALUES (?, ?, ?, ?)')
      .run(
        'request',
        'employee',
        'pending',
        JSON.stringify({ reason: 'Persist this request' }),
      );
    store.onModuleDestroy();
    store = new DatabaseService();
    expect(
      store.db.prepare('SELECT value FROM settings WHERE key = ?').get('test')
        ?.value,
    ).toBe('saved');
    expect(
      store.db
        .prepare('SELECT data FROM employee_requests WHERE id = ?')
        .get('request')?.data,
    ).toBe(JSON.stringify({ reason: 'Persist this request' }));
  } finally {
    store.onModuleDestroy();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
