import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

// Import our modular services and types
import { Registry } from './services/Registry';
import { RateLimiter } from './services/RateLimiter';
import { RpcWsClient } from './services/RpcWsClient';
import { NodeController } from './controllers/NodeController';
import { config } from './config/environment';
import { ensureDir } from './utils/file';

class HeliosNetworkServer {
  private app: express.Application;
  private server: http.Server;
  private wss: WebSocketServer;
  private registry: Registry;
  private rateLimiter: RateLimiter;
  private nodeController: NodeController;
  private cleanupInterval?: NodeJS.Timeout;
  private memoryMonitorInterval?: NodeJS.Timeout;
  private offlineCleanupInterval?: NodeJS.Timeout;
  private cleanupRunning = false;

  constructor() {
    this.app = express();
    this.registry = new Registry();
    this.rateLimiter = new RateLimiter();
    this.nodeController = new NodeController(this.registry);
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSockets();
    this.setupPeriodicTasks();
    this.setupGracefulShutdown();
  }

  private setupMiddleware() {
    this.app.use(this.rateLimiter.middleware());
    this.app.use(cors());
    this.app.use(express.json({ limit: '1mb' }));
  }

  private setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => res.json({ ok: true }));

    // Node management routes
    this.app.get('/nodes', (req, res) => this.nodeController.getNodes(req, res));
    this.app.get('/history', (req, res) => this.nodeController.getHistory(req, res));
    this.app.post('/subscribe', (req, res) => this.nodeController.subscribe(req, res));
    this.app.post('/unsubscribe', (req, res) => this.nodeController.unsubscribe(req, res));

    // Static files
    this.app.use(express.static(config.assetsDir));
  }

  private setupWebSockets() {
    // Add listener for real-time updates
    this.registry.addListener((s) => {
      const msg = JSON.stringify({ type: 'update', node: s });
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          try { 
            client.send(msg); 
          } catch (error) {
            console.error('Error sending WebSocket message:', error);
          }
        }
      }
    });
  }

  private setupPeriodicTasks() {
    // Offline node cleanup
    this.offlineCleanupInterval = setInterval(() => {
      if (this.cleanupRunning) {
        console.debug('Skipping offline cleanup - already running');
        return;
      }
      
      this.cleanupRunning = true;
      try {
        const now = Date.now();
        let removedAny = false;        
        for (const n of this.registry.list()) {
          if (!n.connected) {
            if (typeof n.lastDisconnected === 'number' && Number.isFinite(n.lastDisconnected)) {
              const age = now - n.lastDisconnected;
              const ageSeconds = Math.round(age/1000);
              const thresholdSeconds = Math.round(config.offlineUnsubscribeMs/1000);
              if (age > config.offlineUnsubscribeMs) {
                const ok = this.registry.remove(n.name);
                if (ok) {
                  removedAny = true;
                } else {
                  console.error(`*** Failed to remove node "${n.name}" ***`);
                }
              } else {
                console.log(`Node "${n.name}" not old enough: ${ageSeconds}s < ${Math.round(config.offlineUnsubscribeMs/1000)}s`);
              }
            } else {
              console.log(`Node "${n.name}": offline but no lastDisconnected timestamp`);
            }
          }
        }
        if (removedAny) this.broadcastSnapshot();
      } finally {
        this.cleanupRunning = false;
      }
    }, config.offlineSweepIntervalMs);

    // Global memory leak prevention system
    this.memoryMonitorInterval = setInterval(() => {
      // Force cleanup of old RPC requests in all nodes
      for (const [, node] of this.registry.nodes.entries()) {
        if (node.rpc instanceof RpcWsClient) {
          node.rpc.cleanupOldRequests();
        }
      }
      
      // Memory usage monitoring
      const memUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
      const rateLimiterStats = this.rateLimiter.getStats();
      
      console.debug(`Memory: ${heapUsedMB}MB/${heapTotalMB}MB | Nodes: ${this.registry.nodes.size} | Rate limiter IPs: ${rateLimiterStats.activeIPs}`);
      
      // Alert if memory usage is high
      if (heapUsedMB > 500) {
        console.warn(`High memory usage detected: ${heapUsedMB}MB`);
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  private broadcastSnapshot() {
    const payload = JSON.stringify({ type: 'snapshot', nodes: this.registry.list() });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { 
          client.send(payload); 
        } catch (error) {
          console.error('Error broadcasting snapshot:', error);
        }
      }
    }
  }

  private setupGracefulShutdown() {
    const gracefulShutdown = () => {
      console.log('Received shutdown signal, cleaning up...');
      
      // Stop all periodic tasks
      if (this.offlineCleanupInterval) clearInterval(this.offlineCleanupInterval);
      if (this.memoryMonitorInterval) clearInterval(this.memoryMonitorInterval);
      
      // Stop all nodes and clean up resources
      for (const [name, node] of this.registry.nodes.entries()) {
        console.log(`Stopping node: ${name}`);
        node.stop();
      }
      
      // Clean up services
      this.registry.nodes.clear();
      this.rateLimiter.cleanup();
      
      console.log('Cleanup completed, exiting...');
      process.exit(0);
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
  }

  async start() {
    // Ensure data directory exists
    ensureDir(config.dataDir);
    
    // Initialize registry with persisted nodes
    this.registry.initialize();

    // Start server
    return new Promise<void>((resolve) => {
      this.server.listen(config.port, () => {
        console.log(`Server listening on http://localhost:${config.port}`);
        resolve();
      });
    });
  }
}

// Start the server
const server = new HeliosNetworkServer();
server.start().catch(console.error);