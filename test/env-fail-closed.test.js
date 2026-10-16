import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectEnvErrors, isDevEnv, validateEnv } from '../src/config/env.js';

const GOOD = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db.example.com:5432/app',
  JWT_SECRET: 'a'.repeat(48),
  CEX_ENCRYPTION_KEY: 'ab'.repeat(32),
  FRONTEND_URL: 'https://app.alphabag.xyz',
  ADMIN_PORTAL_KEY: 'portal-key-placeholder',
  BAG_TOKEN_ADDRESS: '0x1111111111111111111111111111111111111111',
  TREASURY_WALLET: '0x2222222222222222222222222222222222222222',
};

function run(env) {
  let code = null;
  const originalError = console.error;
  console.error = () => {};
  try {
    validateEnv(env, (c) => { code = c; });
  } finally {
    console.error = originalError;
  }
  return code;
}

test('NODE_ENV unset is treated as production and exits on missing config', () => {
  assert.equal(isDevEnv({}), false);
  assert.equal(run({}), 1);
});

test('misspelled NODE_ENV (e.g. "prod") still fails closed with weak secret', () => {
  assert.equal(run({ ...GOOD, NODE_ENV: 'prod', JWT_SECRET: 'secret' }), 1);
});

test('the old public dev JWT secret is rejected', () => {
  assert.equal(run({ ...GOOD, NODE_ENV: undefined, JWT_SECRET: 'alphabag-dev-secret-key-32chars-min!!' }), 1);
});

test('CEX key, wildcard frontend, http frontend and zero-address token are rejected', () => {
  assert.equal(run({ ...GOOD, CEX_ENCRYPTION_KEY: '0123' }), 1);
  assert.equal(run({ ...GOOD, FRONTEND_URL: '*' }), 1);
  assert.equal(run({ ...GOOD, FRONTEND_URL: 'http://app.alphabag.xyz' }), 1);
  assert.equal(run({ ...GOOD, BAG_TOKEN_ADDRESS: '0x0000000000000000000000000000000000000000' }), 1);
  assert.equal(run({ ...GOOD, ADMIN_PORTAL_KEY: '' }), 1);
});

test('valid production config passes', () => {
  assert.deepEqual(collectEnvErrors(GOOD), []);
  assert.equal(run(GOOD), null);
});

test('NODE_ENV=development and test never exit', () => {
  assert.equal(run({ NODE_ENV: 'development' }), null);
  assert.equal(run({ NODE_ENV: 'test' }), null);
});

test('no tracked file under data/ contains credentials or user records', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', 'data'], { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/).filter((n) => n.endsWith('.json'));
  } catch {
    return; // not a git checkout (e.g. deployed artifact)
  }
  const forbidden = /"(password|passwordHash|privateKey|secret|apiKey)"\s*:/i;
  const forbiddenFiles = /(^|\/)(users|t2e_claims|t2e_payout_requests)\.json$/;
  for (const f of tracked) {
    assert.ok(!forbiddenFiles.test(f), `${f} must not be tracked`);
    const content = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!forbidden.test(content), `${f} contains a credential-like field`);
  }
});