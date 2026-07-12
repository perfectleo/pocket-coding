import { buildHttpServer } from './gateway/http.js';
import { attachWsServer } from './gateway/ws.js';
import { attachPreviewProxy } from './preview/proxy.js';
import { config, dbPath } from './config.js';
import { Store } from './store/sqlite.js';
import { PushManager } from './push/manager.js';
import { sessionManager } from './session/manager.js';

async function main(): Promise<void> {
  const store = new Store(dbPath);
  const app = await buildHttpServer();

  // Wire push notifications (no-op without APNs/FCM credentials).
  sessionManager.setPushManager(new PushManager(store));

  // Register preview reverse-proxy routes + WS upgrade handler (HMR).
  attachPreviewProxy(app, app.server, store);

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

void Store;
