import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { validateServerInput, type ServerInput, type ValidationIssue } from '../../src/backend/servers/validation';

function expectValid(input: unknown): ServerInput {
  const result = validateServerInput(input);
  if (!result.ok) throw new Error(`harus valid: ${JSON.stringify(result.errors)}`);
  return result.value;
}

function expectInvalid(input: unknown): ValidationIssue[] {
  const result = validateServerInput(input);
  if (result.ok) throw new Error('seharusnya ditolak');
  return result.errors;
}

test('input lengkap yang valid dikembalikan dalam bentuk bersih', () => {
  const value = expectValid({
    name: '  server-6  ',
    host: '  server-6  ',
    port: '3000',
    weight: '2',
    enabled: false,
    note: '  backend cadangan  ',
  });

  assert.deepEqual(value, {
    name: 'server-6',
    host: 'server-6',
    port: 3000,
    weight: 2,
    enabled: false,
    note: 'backend cadangan',
  });
});

test('weight, enabled, dan note memakai default yang aman', () => {
  const value = expectValid({ name: 'server-7', host: '10.0.0.7', port: 3000 });
  assert.equal(value.weight, 1);
  assert.equal(value.enabled, true);
  assert.equal(value.note, null);
});

test('catatan kosong disimpan sebagai null', () => {
  assert.equal(expectValid({ name: 'server-8', host: 'server-8', port: 3000, note: '   ' }).note, null);
});

test('menolak nama kosong, nama dengan spasi, dan nama kepanjangan', () => {
  for (const name of ['', '   ', 'server 9', 'server/9', 'a'.repeat(65)]) {
    assert.ok(expectInvalid({ name, host: 'server-9', port: 3000 }).some((error) => error.field === 'name'));
  }
});

test('menolak host kosong atau mengandung spasi', () => {
  for (const host of ['', 'server 1', ' ']) {
    assert.ok(expectInvalid({ name: 'server-9', host, port: 3000 }).some((error) => error.field === 'host'));
  }
});

test('menolak port di luar 1-65535 dan bukan bilangan bulat', () => {
  for (const port of [0, 65536, -1, 1.5, 'abc', null]) {
    assert.ok(expectInvalid({ name: 'server-9', host: 'server-9', port }).some((error) => error.field === 'port'));
  }
});

test('menolak bobot di luar 1-100', () => {
  for (const weight of [0, 101, 2.5, 'banyak']) {
    assert.ok(expectInvalid({ name: 'server-9', host: 'server-9', port: 3000, weight }).some((e) => e.field === 'weight'));
  }
});

test('menolak enabled yang bukan boolean dan catatan kepanjangan', () => {
  assert.ok(
    expectInvalid({ name: 'server-9', host: 'server-9', port: 3000, enabled: 'true' }).some(
      (error) => error.field === 'enabled',
    ),
  );
  assert.ok(
    expectInvalid({ name: 'server-9', host: 'server-9', port: 3000, note: 'x'.repeat(256) }).some(
      (error) => error.field === 'note',
    ),
  );
});

test('menolak body yang bukan objek JSON', () => {
  for (const body of [null, [], 'server-9', 42]) {
    assert.equal(expectInvalid(body)[0]?.field, 'body');
  }
});