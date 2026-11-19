// serve.ts — local development entry: bind a port from argv (or 0) and serve until killed.
import { createApp } from './app.ts';

// Local dev only: exit cleanly on SIGINT/SIGTERM so flags like --cpu-prof flush their output.
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
const port = Number(process.argv[2] ?? 0);
const server = createApp();
server.listen(Number.isFinite(port) ? port : 0, '127.0.0.1', () => {
  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : 0;
  process.stdout.write(`[ghforge] listening on 127.0.0.1:${bound}\n`);
});
