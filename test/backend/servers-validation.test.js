import assert from 'node:assert/strict';
import test from 'node:test';
import { validateServerInput } from '../../src/backend/servers/validation.js';

test('input lengkap yang valid dikembalikan dalam bentuk bersih', () => {
  const result = validateServerInput({
    name: '  server-6  ',
    host: '  server-6  ',
    port: '3000',
    weight: '2',
    enabled: false,
    note: '  backend cadangan  ',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    name: 'server-6',
    host: 'server-6',
    port: 3000,
    weight: 2,
    enabled: false,
    note: 'backend cadangan',
  });
});

test('weight, enabled, dan note memakai default yang aman', () => {
  const result = validateServerInput({ name: 'server-7', host: '10.0.0.7', port: 3000 });

  assert.equal(result.ok, true);
  assert.equal(result.value.weight, 1);
  assert.equal(result.value.enabled, true);
  assert.equal(result.value.note, null);
});

test('catatan kosong disimpan sebagai null', () => {
  const result = validateServerInput({ name: 'server-8', host: 'server-8', port: 3000, note: '   ' });

  assert.equal(result.ok, true);
  assert.equal(result.value.note, null);
});

test('menolak nama kosong, nama dengan spasi, dan nama kepanjangan', () => {
  for (const name of ['', '   ', 'server 9', 'server/9', 'a'.repeat(65)]) {
    const result = validateServerInput({ name, host: 'server-9', port: 3000 });
    assert.equal(result.ok, false, `nama "${name}" seharusnya ditolak`);
    assert.ok(result.errors.some((error) => error.field === 'name'));
  }
});

test('menolak host kosong atau mengandung spasi', () => {
  for (const host of ['', 'server 1', ' ']) {
    const result = validateServerInput({ name: 'server-9', host, port: 3000 });
    assert.equal(result.ok, false, `host "${host}" seharusnya ditolak`);
    assert.ok(result.errors.some((error) => error.field === 'host'));
  }
});

test('menolak port di luar 1-65535 dan bukan bilangan bulat', () => {
  for (const port of [0, 65536, -1, 1.5, 'abc', null]) {
    const result = validateServerInput({ name: 'server-9', host: 'server-9', port });
    assert.equal(result.ok, false, `port ${port} seharusnya ditolak`);
    assert.ok(result.errors.some((error) => error.field === 'port'));
  }
});

test('menolak bobot di luar 1-100', () => {
  for (const weight of [0, 101, 2.5, 'banyak']) {
    const result = validateServerInput({ name: 'server-9', host: 'server-9', port: 3000, weight });
    assert.equal(result.ok, false, `weight ${weight} seharusnya ditolak`);
    assert.ok(result.errors.some((error) => error.field === 'weight'));
  }
});

test('menolak enabled yang bukan boolean dan catatan kepanjangan', () => {
  const enabled = validateServerInput({ name: 'server-9', host: 'server-9', port: 3000, enabled: 'true' });
  assert.equal(enabled.ok, false);
  assert.ok(enabled.errors.some((error) => error.field === 'enabled'));

  const note = validateServerInput({ name: 'server-9', host: 'server-9', port: 3000, note: 'x'.repeat(256) });
  assert.equal(note.ok, false);
  assert.ok(note.errors.some((error) => error.field === 'note'));
});

test('menolak body yang bukan objek JSON', () => {
  for (const body of [null, [], 'server-9', 42]) {
    const result = validateServerInput(body);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].field, 'body');
  }
});
