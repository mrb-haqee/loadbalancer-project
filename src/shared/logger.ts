const enabled = process.env.LOG_LEVEL !== 'silent';

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/** Logger kecil dengan prefix per service. LOG_LEVEL=silent mematikan output (dipakai test). */
export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  return {
    info: (...args) => enabled && console.log(stamp(), prefix, ...args),
    warn: (...args) => enabled && console.warn(stamp(), prefix, ...args),
    error: (...args) => enabled && console.error(stamp(), prefix, ...args),
  };
}
