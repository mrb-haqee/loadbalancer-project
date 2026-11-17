const enabled = process.env.LOG_LEVEL !== 'silent';

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

/** Logger kecil dengan prefix per service. LOG_LEVEL=silent mematikan output (dipakai test). */
export function createLogger(scope) {
  const prefix = `[${scope}]`;
  return {
    info: (...args) => enabled && console.log(stamp(), prefix, ...args),
    warn: (...args) => enabled && console.warn(stamp(), prefix, ...args),
    error: (...args) => enabled && console.error(stamp(), prefix, ...args),
  };
}
