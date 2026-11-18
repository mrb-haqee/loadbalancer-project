import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { toIso } from '../../src/backend/servers/repository';

test('datetime MariaDB (UTC tanpa zona) menjadi ISO-8601', () => {
  assert.equal(toIso('2026-11-18 01:39:55'), '2026-11-18T01:39:55Z');
  assert.equal(toIso('2026-11-18T01:39:55.000Z'), '2026-11-18T01:39:55.000Z');
  assert.equal(toIso(new Date('2026-11-18T01:39:55.000Z')), '2026-11-18T01:39:55.000Z');
});