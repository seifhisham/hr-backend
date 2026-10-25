import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dashboardOrigin,
  promptOwnerSetup,
} from '../scripts/owner-setup-prompts.mjs';

await test('website validation preserves HTTPS and loopback development', () => {
  assert.equal(
    dashboardOrigin('https://hr.example.com/'),
    'https://hr.example.com',
  );
  assert.equal(
    dashboardOrigin('http://localhost:3003'),
    'http://localhost:3003',
  );
  assert.equal(
    dashboardOrigin('http://127.0.0.1:3003'),
    'http://127.0.0.1:3003',
  );
  assert.equal(dashboardOrigin('http://[::1]:3003'), 'http://[::1]:3003');
});

await test('website validation rejects insecure remote URLs and embedded credentials/tokens', () => {
  for (const value of [
    '',
    'hr.example.com',
    'http://hr.example.com',
    'ftp://hr.example.com',
    'https://user:password@hr.example.com',
    'https://hr.example.com/owner',
    'https://hr.example.com?token=secret',
    'https://hr.example.com#token=secret',
  ])
    assert.throws(() => dashboardOrigin(value), undefined, value);
});

async function prompt(answers, defaultOrigin = '') {
  const prompts = [],
    messages = [];
  let index = 0;
  const result = await promptOwnerSetup(
    async (label) => {
      prompts.push(label);
      assert.ok(index < answers.length, 'Unexpected additional prompt');
      return answers[index++];
    },
    defaultOrigin,
    (message) => messages.push(message),
  );
  assert.equal(index, answers.length);
  return { result, prompts, messages: messages.join('') };
}

await test('owner email is entered explicitly and confirmed with the configured domain', async () => {
  const { result, messages } = await prompt(
    [' Owner@Example.com ', '', 'yes'],
    'https://hr.example.com',
  );
  assert.deepEqual(result, {
    email: 'owner@example.com',
    origin: 'https://hr.example.com',
  });
  assert.match(messages, /Owner email: owner@example.com/);
  assert.match(messages, /An enrolled owner cannot be replaced/);
});

await test('invalid email and website are retried before confirmation', async () => {
  const { result, messages } = await prompt([
    'invalid',
    'owner@example.com',
    'http://remote.example',
    'https://hr.example.com',
    'y',
  ]);
  assert.deepEqual(result, {
    email: 'owner@example.com',
    origin: 'https://hr.example.com',
  });
  assert.match(messages, /valid email/);
  assert.match(messages, /HTTPS address/);
});

await test('confirmation defaults to cancellation and requires an explicit yes', async () => {
  for (const answer of ['', 'n', 'no', 'anything']) {
    const { result } = await prompt([
      'owner@example.com',
      'https://hr.example.com',
      answer,
    ]);
    assert.equal(result, null);
  }
});

await test('terminal cancellation propagates without returning account details', async () => {
  const cancelled = new Error('terminal closed');
  await assert.rejects(
    promptOwnerSetup(
      async () => {
        throw cancelled;
      },
      '',
      () => {},
    ),
    (error) => error === cancelled,
  );
});
