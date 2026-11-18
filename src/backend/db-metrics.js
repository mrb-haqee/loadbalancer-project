// Metrik query database yang diekspor lewat /metrics backend.
// Tujuan: kendala CRUD terlihat dari sisi aplikasi (bukan hanya exporter
// MariaDB), termasuk saat database mati dan exporter ikut tidak bisa connect.
//
// Nama metrik sengaja stabil dan kecil kardinalitasnya:
// - lb_db_queries_total{operation,result}
// - lb_db_query_duration_seconds (histogram)
// - lb_db_errors_total{code}

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

const queryCounts = new Map();
const errorCounts = new Map();
const durationBucketCounts = new Array(DURATION_BUCKETS.length).fill(0);
let durationSum = 0;
let durationCount = 0;

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Kode error dibatasi panjangnya; kode tak dikenal tetap terlihat sebagai UNKNOWN. */
function normalizeCode(code) {
  return code ? String(code).slice(0, 48) : 'UNKNOWN';
}

function record(operation, result, seconds, code) {
  const key = `${operation}|${result}`;
  queryCounts.set(key, (queryCounts.get(key) ?? 0) + 1);

  if (result === 'error') {
    const label = normalizeCode(code);
    errorCounts.set(label, (errorCounts.get(label) ?? 0) + 1);
  }

  durationSum += seconds;
  durationCount += 1;
  for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
    if (seconds <= DURATION_BUCKETS[i]) durationBucketCounts[i] += 1;
  }
}

/**
 * Menjalankan satu query dan mencatat durasi + hasilnya.
 * `operation` adalah nama pendek: list, get, insert, update, delete.
 */
export async function measureDbQuery(operation, run) {
  const startedAt = process.hrtime.bigint();
  try {
    const value = await run();
    record(operation, 'success', Number(process.hrtime.bigint() - startedAt) / 1e9);
    return value;
  } catch (error) {
    record(operation, 'error', Number(process.hrtime.bigint() - startedAt) / 1e9, error?.code);
    throw error;
  }
}

/** Hanya dipakai unit test supaya tiap test mulai dari nol. */
export function resetDbMetrics() {
  queryCounts.clear();
  errorCounts.clear();
  durationBucketCounts.fill(0);
  durationSum = 0;
  durationCount = 0;
}

export function renderDbMetrics(serverId) {
  const server = `server="${escapeLabel(serverId)}"`;
  const lines = [
    '# HELP lb_db_queries_total Query database yang dijalankan backend ini.',
    '# TYPE lb_db_queries_total counter',
  ];

  const queryKeys = [...queryCounts.keys()].sort();
  for (const key of queryKeys) {
    const [operation, result] = key.split('|');
    lines.push(
      `lb_db_queries_total{${server},operation="${escapeLabel(operation)}",result="${escapeLabel(result)}"} ${queryCounts.get(key)}`,
    );
  }

  lines.push(
    '# HELP lb_db_errors_total Query database yang gagal, per kode error driver.',
    '# TYPE lb_db_errors_total counter',
  );
  for (const code of [...errorCounts.keys()].sort()) {
    lines.push(`lb_db_errors_total{${server},code="${escapeLabel(code)}"} ${errorCounts.get(code)}`);
  }

  lines.push(
    '# HELP lb_db_query_duration_seconds Durasi query database (detik).',
    '# TYPE lb_db_query_duration_seconds histogram',
  );
  DURATION_BUCKETS.forEach((le, index) => {
    lines.push(`lb_db_query_duration_seconds_bucket{${server},le="${le}"} ${durationBucketCounts[index]}`);
  });
  lines.push(`lb_db_query_duration_seconds_bucket{${server},le="+Inf"} ${durationCount}`);
  lines.push(`lb_db_query_duration_seconds_sum{${server}} ${durationSum}`);
  lines.push(`lb_db_query_duration_seconds_count{${server}} ${durationCount}`);

  return `${lines.join('\n')}\n`;
}
