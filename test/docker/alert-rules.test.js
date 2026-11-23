// Guard regresi: `or vector(0)` pada agregasi `by (node)` menambah seri hantu
// berlabel {} bernilai 0 (label tidak pernah cocok), membuat threshold `< 1`
// firing terus di cluster sehat. Pola itu hanya sah untuk agregasi tanpa label
// (count/sum). Static check — tidak butuh Docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rules = readFileSync(resolve(ROOT, 'monitoring/grafana/provisioning/alerting/rules.yml'), 'utf8');

test('tidak ada expr alert menggabungkan by (...) dengan or vector(0)', () => {
  const offenders = rules
    .split(/\r?\n/)
    .filter((line) => /^\s*expr:/.test(line) && /by\s*\(/.test(line) && /or\s+vector\s*\(/.test(line));
  assert.deepEqual(offenders, [], `seri hantu {} akan selalu firing:\n${offenders.join('\n')}`);
});