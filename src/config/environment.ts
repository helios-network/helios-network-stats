import * as path from 'path';

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  port: Number(process.env.PORT || 8081),
  dataDir: path.join(process.cwd(), 'data'),
  nodesDbPath: String(process.env.NODES_DB_PATH || path.join(process.cwd(), 'data', 'nodes.json')),
  assetsDir: String(
    process.env.ASSETS_DIR || path.join(process.cwd(), isProd ? 'dist' : '', isProd ? 'public' : 'public')
  ),
  offlineUnsubscribeMs: Number(process.env.OFFLINE_UNSUBSCRIBE_MS || 10 * 60 * 1000), // 10 minutes
  offlineSweepIntervalMs: Number(process.env.OFFLINE_SWEEP_INTERVAL_MS || 30 * 1000), // 30 seconds
  rateLimitRequests: 100, // requests per minute
  rateLimitWindowMs: 60000, // 1 minute
};
