import { app, shutdown, startupMessage } from './app';
import { self } from './identity';
import { createLogger } from '../shared/logger';

const log = createLogger(self.id);

try {
  app.listen({ hostname: self.host, port: self.port });
  log.info(startupMessage());
} catch (error) {
  log.error(`gagal listen di ${self.host}:${self.port} -> ${(error as Error).message}`);
  process.exit(1);
}

function handleSignal(signal: string): void {
  shutdown(signal)
    .catch((error: Error) => log.warn(`gagal menutup server: ${error.message}`))
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));
