// Histogram durasi request untuk /metrics (format Prometheus).
// Health check dan /metrics sendiri tidak dihitung agar angkanya tidak tercemar
// probe 2 detik milik Traefik.

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];
const durationBucketCounts = new Array<number>(DURATION_BUCKETS.length).fill(0);
let durationSum = 0;
let durationCount = 0;

export function recordRequestDuration(seconds: number): void {
  durationSum += seconds;
  durationCount += 1;
  for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
    if (seconds <= DURATION_BUCKETS[i]) durationBucketCounts[i] += 1;
  }
}

export function renderRequestMetrics(serverId: string, requestCount: number, slowRequestCount: number): string {
  const labels = `server="${serverId}"`;
  const histogram = DURATION_BUCKETS.map(
    (le, index) => `lb_backend_request_duration_seconds_bucket{${labels},le="${le}"} ${durationBucketCounts[index]}`,
  );
  histogram.push(`lb_backend_request_duration_seconds_bucket{${labels},le="+Inf"} ${durationCount}`);
  return [
    '# HELP lb_backend_requests_total Total request aplikasi yang diterima backend ini.',
    '# TYPE lb_backend_requests_total counter',
    `lb_backend_requests_total{${labels}} ${requestCount}`,
    '# HELP lb_backend_slow_requests_total Total request ke /slow.',
    '# TYPE lb_backend_slow_requests_total counter',
    `lb_backend_slow_requests_total{${labels}} ${slowRequestCount}`,
    '# HELP lb_backend_request_duration_seconds Durasi request yang dilayani (detik).',
    '# TYPE lb_backend_request_duration_seconds histogram',
    ...histogram,
    `lb_backend_request_duration_seconds_sum{${labels}} ${durationSum}`,
    `lb_backend_request_duration_seconds_count{${labels}} ${durationCount}`,
  ].join('\n');
}
