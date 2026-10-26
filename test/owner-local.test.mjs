import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localEnvironment } from '../scripts/owner-local.mjs';

const config = {
  HR_PG_URL: 'postgresql://runtime:test@127.0.0.1:55432/local_hr',
  HR_PG_MIGRATION_URL: 'postgresql://migration:test@127.0.0.1:55432/local_hr',
  HR_OWNER_ENCRYPTION_KEY: 'a'.repeat(64),
};

await test('loads local infrastructure configuration without changing its key', () => {
  const result = localEnvironment(
    {
      HOST: '127.0.0.1',
      HR_OWNER_ENCRYPTION_KEY: config.HR_OWNER_ENCRYPTION_KEY,
    },
    config,
  );
  assert.equal(result.HR_OWNER_ENCRYPTION_KEY, config.HR_OWNER_ENCRYPTION_KEY);
  assert.equal(result.HOST, '127.0.0.1');
  assert.equal(result.HR_PG_MIGRATION_URL, config.HR_PG_MIGRATION_URL);
});

await test('refuses remote connections, mismatched databases and missing or changed keys', () => {
  for (const changed of [
    { HR_PG_URL: 'postgresql://runtime:test@remote.example:5432/local_hr' },
    {
      HR_PG_MIGRATION_URL: 'postgresql://migration:test@127.0.0.1:55432/other',
    },
    {
      HR_PG_MIGRATION_URL:
        'postgresql://migration:test@127.0.0.1:55433/local_hr',
    },
    { HR_OWNER_ENCRYPTION_KEY: '' },
  ])
    assert.throws(() => localEnvironment({}, { ...config, ...changed }));
  assert.throws(
    () => localEnvironment({ HR_OWNER_ENCRYPTION_KEY: 'b'.repeat(64) }, config),
    /inconsistent/,
  );
});
