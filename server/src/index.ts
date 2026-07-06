import { buildHttpServer } from './gateway/http.js';
import { attachWsServer } from './gateway/ws.js';
import { config, dbPath } from './config.js';
import { Store } from './store/sqlite.js';

async function main(): Promise<void> {
  const store = new Store(dbPath);
  const app = await buildHttpServer();

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  attachWsServer(app.server, store);

  app.log.info(`pocket-agent listening on http://${config.host}:${config.port}`);
  app.log.info(`data dir: ${config.dataDir}`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});

// Keep a reference so tsx doesn't tree-shake Store import used by http.ts indirectly.
void Store;
