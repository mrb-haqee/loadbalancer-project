import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { measureDbQuery, renderDbMetrics, resetDbMetrics } from '../../src/backend/db-metrics';
import { driverErrorCode, isConnectionFailure } from '../../src/backend/db-errors';

test('query sukses masuk ke counter dan histogram', async () => {
  resetDbMetrics();
  const value = await measureDbQuery('list', async () => ['server-1']);
  assert.deepEqual(value, ['server-1']);

  const text = renderDbMetrics('server-1');
  assert.match(text, /lb_db_queries_total\{server="server-1",operation="list",result="success"\} 1/);
  assert.match(text, /lb_db_query_duration_seconds_count\{server="server-1"\} 1/);
  assert.match(text, /lb_db_query_duration_seconds_bucket\{server="server-1",le="\+Inf"\} 1/);
});

test('query gagal mencatat result=error dan kode driver', async () => {
  resetDbMetrics();
  await assert.rejects(
    measureDbQuery('insert', async () => {
      const error = new Error('duplikat') as Error & { code?: string };
      error.code = 'ER_DUP_ENTRY';
      throw error;
    }),
    /duplikat/,
  );

  const text = renderDbMetrics('server-2');
  assert.match(text, /lb_db_queries_total\{server="server-2",operation="insert",result="error"\} 1/);
  assert.match(text, /lb_db_errors_total\{server="server-2",code="ER_DUP_ENTRY"\} 1/);
});

test('error Drizzle dibuka sampai errno MySQL', async () => {
  resetDbMetrics();
  await assert.rejects(
    measureDbQuery('insert', async () => {
      const driver = Object.assign(new Error('Duplicate entry'), { errno: 1062 });
      throw Object.assign(new Error('Failed query'), { cause: driver });
    }),
  );

  assert.match(renderDbMetrics('server-2'), /lb_db_errors_total\{server="server-2",code="ER_DUP_ENTRY"\} 1/);
});

test('kegagalan koneksi Bun SQL dipetakan ke DATABASE_UNAVAILABLE', async () => {
  resetDbMetrics();
  await assert.rejects(
    measureDbQuery('list', async () => {
      const driver = Object.assign(new Error('Connection closed'), { code: 'ERR_MYSQL_CONNECTION_CLOSED' });
      throw Object.assign(new Error('Failed query'), { cause: driver });
    }),
  );

  assert.equal(driverErrorCode(Object.assign(new Error('x'), {
    code: 'ERR_MYSQL_CONNECTION_TIMEOUT',
  })), 'ERR_MYSQL_CONNECTION_TIMEOUT');
  assert.ok(isConnectionFailure('ERR_MYSQL_CONNECTION_TIMEOUT'));
  assert.ok(isConnectionFailure('ERR_MYSQL_CONNECTION_CLOSED'));
  assert.equal(isConnectionFailure('ER_DUP_ENTRY'), false);
  assert.equal(driverErrorCode(Object.assign(new Error('x'), { errno: 1045 })), 'ER_ACCESS_DENIED_ERROR');
});

test('kode error yang tidak ada menjadi UNKNOWN', async () => {
  resetDbMetrics();
  await assert.rejects(
    measureDbQuery('get', async () => {
      throw new Error('tanpa kode');
    }),
  );

  assert.match(renderDbMetrics('server-3'), /lb_db_errors_total\{server="server-3",code="UNKNOWN"\} 1/);
});

test('resetDbMetrics mengosongkan semua angka', async () => {
  resetDbMetrics();
  await measureDbQuery('delete', async () => true);
  resetDbMetrics();

  const text = renderDbMetrics('server-4');
  assert.doesNotMatch(text, /lb_db_queries_total\{server="server-4"/);
  assert.match(text, /lb_db_query_duration_seconds_count\{server="server-4"\} 0/);
  assert.doesNotMatch(text, /lb_db_errors_total\{server="server-4",code=/);
});