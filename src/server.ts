import http from 'http';
import path from 'path';
import fs from 'fs';
import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';

type NodeId = string;

type SubscribeBody = {
  name: string;
  host: string;
  rpcPort?: number;
  wsRpcPort?: number;
  wsUrl?: string;
};

type NodeSnapshot = {
  name: string;
  host: string;
  rpcPort: number;
  wsRpcPort: number;
  connected: boolean;
  latestBlock?: number;
  peerCount?: number;
  clientVersion?: string;
  syncing?: boolean;
  latencyMs?: number;
  // Extended metrics
  type?: string; // parsed client type
  mining?: boolean;
  blockTxs?: number;
  blockTimeMs?: number; // last block interval
  blockPropagationMs?: number; // now - latest block timestamp
  blockTimeAvgMs?: number; // moving average
  uptimeMs?: number; // time since connected
  gasPriceGwei?: number;
  gasLimit?: number;
  gasUsed?: number;
  lastUpdated?: number; // epoch ms
  lastError?: string;
};

type PersistedNode = {
  name: string;
  host: string;
  rpcPort: number;
  wsRpcPort: number;
};

const DATA_DIR = path.join(process.cwd(), 'data');
const NODES_DB_PATH = String(process.env.NODES_DB_PATH || path.join(DATA_DIR, 'nodes.json'));

function ensureDir(dir: string) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.error(`Failed to create directory ${dir}:`, error);
    throw new Error(`Cannot create required directory: ${dir}`);
  }
}

function readPersistedNodes(): PersistedNode[] {
  try {
    if (!fs.existsSync(NODES_DB_PATH)) return [];
    const raw = fs.readFileSync(NODES_DB_PATH, 'utf8');
    const json = JSON.parse(raw);
    const arr = Array.isArray(json?.nodes) ? json.nodes : Array.isArray(json) ? json : [];
    return arr
      .map((x: any) => ({
        name: String(x?.name || ''),
        host: String(x?.host || ''),
        rpcPort: Number(x?.rpcPort || 8545),
        wsRpcPort: Number(x?.wsRpcPort || 8546),
      }))
      .filter((n: PersistedNode) => n.name && n.host);
  } catch (error) {
    console.error(`Failed to read persisted nodes from ${NODES_DB_PATH}:`, error);
    console.warn('Returning empty node list due to read error');
    return [];
  }
}

function writeJsonAtomic(file: string, obj: any) {
  try {
    ensureDir(path.dirname(file));
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    console.error(`Failed to persist data to ${file}:`, error);
    throw new Error(`Cannot write to file: ${file}`);
  }
}

interface RpcClient {
  isConnected(): boolean;
  connect(onOpen?: () => void, onClose?: (code: number, reason: string) => void, onError?: (err: any) => void): void;
  disconnect(): void;
  call<T = any>(method: string, params?: any[]): Promise<T>;
}

class RpcWsClient implements RpcClient {
  private ws?: WebSocket;
  private url: string;
  private idCounter = 1;
  private pending = new Map<number, { 
    resolve: (v: any) => void; 
    reject: (e: any) => void; 
    timeout: NodeJS.Timeout;
    createdAt: number;
  }>();
  private connected = false;
  private connecting = false;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelay = 2000;
  private maxReconnectDelay = 30000; // 30 seconds max
  private currentReconnectDelay = 2000;
  private shouldReconnect = true;

  constructor(url: string) {
    this.url = url;
  }

  isConnected() {
    return this.connected;
  }

  connect(onOpen?: () => void, onClose?: (code: number, reason: string) => void, onError?: (err: any) => void) {
    // Prevent multiple simultaneous connection attempts
    if (this.connecting || this.connected) {
      console.debug('Connection attempt blocked - already connecting or connected');
      return;
    }
    
    this.connecting = true;
    this.shouldReconnect = true;
    this.clearReconnect();
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.connected = true;
      this.connecting = false;
      this.currentReconnectDelay = this.reconnectDelay; // Reset backoff on successful connection
      onOpen?.();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const id = msg.id;
        if (typeof id === 'number' && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          clearTimeout(p.timeout); // Clean up timeout
          this.pending.delete(id);
          if ('result' in msg) p.resolve(msg.result);
          else if ('error' in msg) p.reject(new Error(msg.error?.message || 'RPC error'));
          else p.reject(new Error('Invalid RPC response'));
        }
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
        console.debug('Raw message data:', data.toString());
      }
    });

    this.ws.on('close', (code, buf) => {
      this.connected = false;
      this.connecting = false;
      const reason = buf?.toString() ?? '';
      for (const [, p] of this.pending) {
        clearTimeout(p.timeout); // Clean up all timeouts
        p.reject(new Error('Connection closed'));
      }
      this.pending.clear();
      onClose?.(code, reason);
      this.scheduleReconnect(onOpen, onClose, onError);
    });

    this.ws.on('error', (err) => {
      this.connecting = false;
      onError?.(err);
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    this.connecting = false;
    this.clearReconnect();
    try {
      this.ws?.terminate();
    } catch (error) {
      console.warn('Error during WebSocket termination:', error);
    }
    this.connected = false;
    this.cleanupOldRequests();
  }

  public cleanupOldRequests() {
    const now = Date.now();
    const maxAge = 60000; // 1 minute
    
    for (const [id, pending] of this.pending.entries()) {
      if (now - pending.createdAt > maxAge) {
        console.warn(`Cleaning up old RPC request ${id} (age: ${now - pending.createdAt}ms)`);
        clearTimeout(pending.timeout);
        pending.reject(new Error('Request cleanup - too old'));
        this.pending.delete(id);
      }
    }
  }

  private scheduleReconnect(onOpen?: () => void, onClose?: (code: number, reason: string) => void, onError?: (err: any) => void) {
    if (!this.shouldReconnect) return;
    this.clearReconnect();
    
    console.debug(`Scheduling reconnect in ${this.currentReconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(onOpen, onClose, onError), this.currentReconnectDelay);
    
    // Exponential backoff with jitter
    this.currentReconnectDelay = Math.min(
      this.currentReconnectDelay * 2 + Math.random() * 1000, 
      this.maxReconnectDelay
    );
  }

  private clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  call<T = any>(method: string, params: any[] = []): Promise<T> {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      return Promise.reject(new Error('WS not connected'));
    }
    const id = this.idCounter++;
    const payload = { jsonrpc: '2.0', id, method, params };
    
    return new Promise<T>((resolve, reject) => {
      // Set up timeout for this request (30 seconds)
      const timeout = setTimeout(() => {
        const pendingItem = this.pending.get(id);
        if (pendingItem) {
          clearTimeout(pendingItem.timeout);
          this.pending.delete(id);
          reject(new Error(`RPC request timeout for method: ${method}`));
        }
      }, 30000);

      const pendingItem = {
        resolve,
        reject,
        timeout,
        createdAt: Date.now()
      };

      this.pending.set(id, pendingItem);
      
      try {
        this.ws!.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
}

class NodeEntry {
  public name: string;
  public host: string;
  public rpcPort: number;
  public wsRpcPort: number;
  public rpc: RpcClient;
  private pollTimer?: NodeJS.Timeout;
  private pollIntervalMs = 3000;
  private polling = false;
  public snapshot: NodeSnapshot;
  private connectedSince?: number;
  private lastBlockTimestampSec?: number; // seconds
  private timesWindow: number[] = [];
  private timesWindowLimit = 20;

  constructor(name: string, host: string, rpcPort = 8545, wsRpcPort = 8546) {
    this.name = name;
    this.host = host;
    this.rpcPort = rpcPort;
    this.wsRpcPort = wsRpcPort;
    const url = this.resolveWsUrl(host, wsRpcPort);
    this.rpc = new RpcWsClient(url);
    this.snapshot = {
      name,
      host,
      rpcPort,
      wsRpcPort,
      connected: false,
    };
  }

  private resolveWsUrl(host: string, wsPort: number) {
    try {
      if (/^wss?:\/\//i.test(host)) {
        return host;
      }
    } catch {}
    return `ws://${host}:${wsPort}`;
  }

  start(onUpdate: (s: NodeSnapshot) => void) {
    const handleOpen = () => {
      this.snapshot.connected = true;
      this.snapshot.lastError = undefined;
      this.snapshot.lastUpdated = Date.now();
      this.connectedSince = Date.now();
      this.snapshot.uptimeMs = 0;
      onUpdate(this.snapshot);
      this.schedulePoll(onUpdate);
    };
    const handleClose = (code: number, reason: string) => {
      this.snapshot.connected = false;
      this.snapshot.lastError = reason && reason.length > 0 ? `WS close ${code}: ${reason}` : (this.snapshot.lastError || 'WS closed');
      this.snapshot.lastUpdated = Date.now();
      onUpdate(this.snapshot);
      this.clearPoll();
    };
    const handleError = (err: any) => {
      const msg = err?.message || err?.code || err?.name || err;
      this.snapshot.lastError = String(msg);
      this.snapshot.lastUpdated = Date.now();
      onUpdate(this.snapshot);
    };
    this.rpc.connect(handleOpen, handleClose, handleError);
  }

  stop() {
    this.polling = false;
    this.clearPoll();
    this.rpc.disconnect();
  }

  private clearPoll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private schedulePoll(onUpdate: (s: NodeSnapshot) => void) {
    this.clearPoll();
    this.pollTimer = setTimeout(() => this.poll(onUpdate), this.pollIntervalMs);
  }

  private async poll(onUpdate: (s: NodeSnapshot) => void) {
    // Prevent multiple simultaneous polls
    if (this.polling) {
      console.debug(`Skipping poll for ${this.name} - already polling`);
      this.schedulePoll(onUpdate);
      return;
    }
    
    if (!this.rpc.isConnected()) {
      this.schedulePoll(onUpdate);
      return;
    }

    this.polling = true;

    try {
      const t0 = Date.now();
      const blockHex = await this.rpc.call<string>('eth_blockNumber');
      const latencyMs = Date.now() - t0;

      const [peerHex, clientVer, syncing, mining, gasPriceHex] = await Promise.all([
        this.rpc.call<string>('net_peerCount'),
        this.rpc.call<string>('web3_clientVersion'),
        this.rpc.call<false | { startingBlock: string; currentBlock: string; highestBlock: string }>('eth_syncing'),
        this.rpc.call<boolean>('eth_mining').catch(() => false),
        this.rpc.call<string>('eth_gasPrice').catch(() => '0x0'),
      ]);

      const latestBlock = parseInt(blockHex, 16);
      const peerCount = parseInt(peerHex, 16);

      this.snapshot.latestBlock = Number.isFinite(latestBlock) ? latestBlock : undefined;
      this.snapshot.peerCount = Number.isFinite(peerCount) ? peerCount : undefined;
      this.snapshot.clientVersion = clientVer;
      this.snapshot.syncing = !!syncing;
      this.snapshot.latencyMs = latencyMs;
      this.snapshot.mining = !!mining;
      if (this.connectedSince) this.snapshot.uptimeMs = Date.now() - this.connectedSince;
      const gasWei = parseInt(gasPriceHex, 16);
      const gasGwei = Number.isFinite(gasWei) ? gasWei / 1e9 : undefined;
      this.snapshot.gasPriceGwei = gasGwei;

      if (Number.isFinite(latestBlock)) {
        const latestBlockObj = await this.rpc
          .call<any>('eth_getBlockByNumber', [toHexBlock(latestBlock), false])
          .catch(() => undefined);
        if (latestBlockObj) {
          const tsSec = parseInt(latestBlockObj.timestamp, 16) || undefined;
          const txCount = Array.isArray(latestBlockObj.transactions) ? latestBlockObj.transactions.length : undefined;
          this.snapshot.blockTxs = txCount;
          const gasLimit = parseInt(latestBlockObj.gasLimit, 16);
          this.snapshot.gasLimit = Number.isFinite(gasLimit) ? gasLimit : this.snapshot.gasLimit;
          const gasUsed = parseInt(latestBlockObj.gasUsed, 16);
          this.snapshot.gasUsed = Number.isFinite(gasUsed) ? gasUsed : this.snapshot.gasUsed;
          if (tsSec) {
            this.snapshot.blockPropagationMs = Date.now() - tsSec * 1000;
            
            if (this.lastBlockTimestampSec && tsSec > this.lastBlockTimestampSec) {
              const dt = (tsSec - this.lastBlockTimestampSec) * 1000;
              this.snapshot.blockTimeMs = dt;
              this.timesWindow.push(dt);
              if (this.timesWindow.length > this.timesWindowLimit) this.timesWindow.shift();
              this.snapshot.blockTimeAvgMs = Math.round(
                this.timesWindow.reduce((a, b) => a + b, 0) / this.timesWindow.length
              );
            }
            this.lastBlockTimestampSec = tsSec;
          }
        }
      }

      this.snapshot.connected = true;
      this.snapshot.lastError = undefined;
      this.snapshot.lastUpdated = Date.now();
    } catch (e: any) {
      this.snapshot.lastError = String(e?.message || e);
      this.snapshot.connected = this.rpc.isConnected();
      this.snapshot.lastUpdated = Date.now();
    } finally {
      this.polling = false;
      onUpdate(this.snapshot);
      this.schedulePoll(onUpdate);
    }
  }
}

function toHexBlock(n: number) {
  return '0x' + n.toString(16);
}

class Registry {
  public nodes = new Map<NodeId, NodeEntry>();
  private listeners = new Set<(s: NodeSnapshot) => void>();

  private getPersistedList(): PersistedNode[] {
    return Array.from(this.nodes.values()).map((n) => ({
      name: n.name,
      host: n.host,
      rpcPort: n.rpcPort,
      wsRpcPort: n.wsRpcPort,
    }));
  }

  private persist() {
    const nodes = this.getPersistedList();
    writeJsonAtomic(NODES_DB_PATH, { nodes });
  }

  addListener(fn: (s: NodeSnapshot) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(s: NodeSnapshot) {
    for (const l of this.listeners) {
      try { 
        l(s); 
      } catch (error) {
        console.error('Error in listener callback:', error);
      }
    }
  }

  list(): NodeSnapshot[] {
    return Array.from(this.nodes.values()).map((n) => n.snapshot);
  }

  getFirstConnected(): NodeEntry | undefined {
    for (const n of this.nodes.values()) {
      if (n.snapshot.connected) return n;
    }
    return undefined;
  }

  upsert(name: string, host: string, rpcPort = 8545, wsRpcPort = 8546) {
    const existing = this.nodes.get(name);
    if (existing) {
      existing.stop();
      setTimeout(() => {
        const entry = new NodeEntry(name, host, rpcPort, wsRpcPort);
        this.nodes.set(name, entry);
        entry.start((s) => this.emit(s));
        this.persist();
      }, 100);
    } else {
      const entry = new NodeEntry(name, host, rpcPort, wsRpcPort);
      this.nodes.set(name, entry);
      entry.start((s) => this.emit(s));
      this.persist();
    }
  }

  remove(name: string) {
    const existing = this.nodes.get(name);
    if (!existing) return false;
    existing.stop();
    this.nodes.delete(name);
    this.persist();
    return true;
  }
}

const app = express();

const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 100; // requests per minute
const RATE_WINDOW = 60000; // 1 minute in milliseconds

setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of requestCounts.entries()) {
    if (now > data.resetTime + RATE_WINDOW) {
      requestCounts.delete(ip);
    }
  }
  console.debug(`Rate limiter cleanup: ${requestCounts.size} active IPs`);
}, RATE_WINDOW);

function rateLimitMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const clientIP = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  
  for (const [ip, data] of requestCounts.entries()) {
    if (now > data.resetTime) {
      requestCounts.delete(ip);
    }
  }
  
  const clientData = requestCounts.get(clientIP);
  if (!clientData) {
    requestCounts.set(clientIP, { count: 1, resetTime: now + RATE_WINDOW });
    return next();
  }
  
  if (now > clientData.resetTime) {
    clientData.count = 1;
    clientData.resetTime = now + RATE_WINDOW;
    return next();
  }
  
  if (clientData.count >= RATE_LIMIT) {
    return res.status(429).json({ 
      error: 'Too many requests. Please try again later.',
      retryAfter: Math.ceil((clientData.resetTime - now) / 1000)
    });
  }
  
  clientData.count++;
  next();
}

app.use(rateLimitMiddleware);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const registry = new Registry();

try {
  const initial = readPersistedNodes();
  if (initial.length > 0) {
    console.log(`Loading ${initial.length} persisted node(s)`);
    for (const n of initial) {
      registry.upsert(n.name, n.host, n.rpcPort, n.wsRpcPort);
    }
  }
} catch (e) {
  console.error('Failed to load persisted nodes:', e);
}

// Resolve assets dir: prod uses minified dist/public when ASSETS_DIR is set
const assetsDir = (() => {
  const envDir = process.env.ASSETS_DIR ? path.resolve(process.cwd(), String(process.env.ASSETS_DIR)) : '';
  if (envDir && fs.existsSync(envDir)) return envDir;
  return path.join(process.cwd(), 'public');
})();

// Basic hardening and consistency
app.disable('x-powered-by');
app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // CSP tuned for our static needs
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' https://fonts.googleapis.com https://cdn.jsdelivr.net 'unsafe-inline'",
      "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:",
      "script-src 'self'",
      "connect-src 'self' ws: wss:",
    ].join('; ')
  );
  next();
});

app.use(express.static(assetsDir));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/nodes', (_req, res) => {
  res.json({ nodes: registry.list() });
});

app.get('/history', async (req: Request, res: Response) => {
  try {
    const countParam = req.query.count;
    let count = 60;
    
    if (countParam !== undefined) {
      const parsedCount = Number(countParam);
      if (!Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount > 200) {
        return res.status(400).json({ 
          error: 'Count parameter must be an integer between 1 and 200' 
        });
      }
      count = parsedCount;
    }
    
    const entry = registry.getFirstConnected();
    if (!entry) {
      return res.status(503).json({ 
        ok: false, 
        error: 'No connected nodes available for history data',
        labels: [], 
        series: { bt: [], bp: [], tx: [], gs: [] } 
      });
    }
    const bestHex = await entry.rpc.call<string>('eth_blockNumber');
    const best = parseInt(bestHex, 16);
    if (!Number.isFinite(best)) throw new Error('Invalid best block');

    const from = Math.max(0, best - count);
    const to = best;
    const needed = [] as number[];
    for (let i = from; i <= to; i++) needed.push(i);

    const blocks: any[] = [];
    for (const bn of needed) {
      const b = await entry.rpc
        .call<any>('eth_getBlockByNumber', [toHexBlock(bn), false])
        .catch(() => undefined);
      blocks.push(b);
    }

    const labels: string[] = [];
    const bt: (number|null)[] = []; 
    const bp: (number|null)[] = [];
    const tx: (number|null)[] = [];
    const gs: (number|null)[] = [];

    for (let i = 1; i < blocks.length; i++) {
      const b = blocks[i];
      const prev = blocks[i-1];
      const bn = from + i;
      labels.push(`#${bn}`);
      if (!b || !prev) {
        bt.push(null); bp.push(null); tx.push(null); gs.push(null);
        continue;
      }
      const ts = parseInt(b.timestamp, 16);
      const tsPrev = parseInt(prev.timestamp, 16);
      const dtMs = (Number.isFinite(ts) && Number.isFinite(tsPrev)) ? Math.max(0, (ts - tsPrev) * 1000) : null;
      const propMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts * 1000) : null;
      const txCount = Array.isArray(b.transactions) ? b.transactions.length : null;
      const gasUsed = parseInt(b.gasUsed, 16);
      const baseFeeWei = b.baseFeePerGas ? parseInt(b.baseFeePerGas, 16) : NaN;
      const spendEth = Number.isFinite(baseFeeWei) && Number.isFinite(gasUsed) ? (baseFeeWei * gasUsed) / 1e18 : null;
      bt.push(dtMs);
      bp.push(propMs);
      tx.push(Number.isFinite(txCount as any) ? (txCount as any) : null);
      gs.push(spendEth);
    }

    return res.json({ ok: true, labels, series: { bt, bp, tx, gs }, best });
  } catch (e: any) {
    return res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
});

// Input validation functions
interface ValidationResult {
  isValid: boolean;
  error?: string;
}

function validateNodeName(name: any): ValidationResult {
  if (typeof name !== 'string') {
    return { isValid: false, error: 'Name must be a string' };
  }
  if (name.length === 0 || name.length > 50) {
    return { isValid: false, error: 'Name must be between 1 and 50 characters' };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return { isValid: false, error: 'Name contains invalid characters. Only alphanumeric, dots, underscores and hyphens allowed' };
  }
  return { isValid: true };
}

function validateHost(host: any): ValidationResult {
  if (typeof host !== 'string') {
    return { isValid: false, error: 'Host must be a string' };
  }
  if (host.length === 0 || host.length > 253) {
    return { isValid: false, error: 'Host must be between 1 and 253 characters' };
  }
  // Basic hostname/IP validation
  const hostnameRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  
  if (!hostnameRegex.test(host) && !ipRegex.test(host)) {
    return { isValid: false, error: 'Invalid hostname or IP address format' };
  }
  return { isValid: true };
}

function validatePort(port: any): ValidationResult {
  const numPort = Number(port);
  if (!Number.isInteger(numPort)) {
    return { isValid: false, error: 'Port must be an integer' };
  }
  if (numPort < 1 || numPort > 65535) {
    return { isValid: false, error: 'Port must be between 1 and 65535' };
  }
  return { isValid: true };
}

function validateWebSocketUrl(wsUrl: any): ValidationResult {
  if (typeof wsUrl !== 'string') {
    return { isValid: false, error: 'WebSocket URL must be a string' };
  }
  if (wsUrl.length === 0 || wsUrl.length > 500) {
    return { isValid: false, error: 'WebSocket URL must be between 1 and 500 characters' };
  }
  
  try {
    const url = new URL(wsUrl);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return { isValid: false, error: 'WebSocket URL must use ws:// or wss:// protocol' };
    }
    // Block localhost and private IPs for security
    const hostname = url.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return { isValid: false, error: 'Localhost connections not allowed' };
    }
    // Block private IP ranges
    if (/^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(hostname)) {
      return { isValid: false, error: 'Private IP addresses not allowed' };
    }
    // Block other problematic ranges
    if (/^(169\.254\.|224\.|240\.)/.test(hostname)) {
      return { isValid: false, error: 'Invalid IP address range' };
    }
    // Ensure port is reasonable for WebSocket
    const port = url.port ? parseInt(url.port, 10) : (url.protocol === 'wss:' ? 443 : 80);
    if (port < 1 || port > 65535) {
      return { isValid: false, error: 'Invalid port number' };
    }
  } catch (error) {
    return { isValid: false, error: 'Invalid WebSocket URL format' };
  }
  
  return { isValid: true };
}

app.post('/subscribe', (req: Request<{}, {}, SubscribeBody>, res: Response) => {
  try {
    // Check if body exists
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Request body is required and must be valid JSON' });
    }

    const { name, host, rpcPort = 8545, wsRpcPort = 8546, wsUrl } = req.body;

    // Validate name (required)
    const nameValidation = validateNodeName(name);
    if (!nameValidation.isValid) {
      return res.status(400).json({ error: nameValidation.error });
    }

    // Validate ports
    const rpcPortValidation = validatePort(rpcPort);
    if (!rpcPortValidation.isValid) {
      return res.status(400).json({ error: `RPC port invalid: ${rpcPortValidation.error}` });
    }

    const wsPortValidation = validatePort(wsRpcPort);
    if (!wsPortValidation.isValid) {
      return res.status(400).json({ error: `WebSocket port invalid: ${wsPortValidation.error}` });
    }

    // Validate connection parameters (either host or wsUrl required)
    if (!host && !wsUrl) {
      return res.status(400).json({ error: 'Either host or wsUrl is required' });
    }

    let finalHost: string;
    
    if (wsUrl) {
      const wsValidation = validateWebSocketUrl(wsUrl);
      if (!wsValidation.isValid) {
        return res.status(400).json({ error: `WebSocket URL invalid: ${wsValidation.error}` });
      }
      finalHost = wsUrl;
    } else {
      const hostValidation = validateHost(host);
      if (!hostValidation.isValid) {
        return res.status(400).json({ error: `Host invalid: ${hostValidation.error}` });
      }
      finalHost = host;
    }

    // All validations passed - proceed with registration
    registry.upsert(name, finalHost, Number(rpcPort), Number(wsRpcPort));
    return res.json({ ok: true });

  } catch (error) {
    console.error('Error in /subscribe endpoint:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/unsubscribe', (req: Request<{}, {}, { name: string }>, res: Response) => {
  try {
    // Check if body exists
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Request body is required and must be valid JSON' });
    }

    const { name } = req.body;

    // Validate name
    const nameValidation = validateNodeName(name);
    if (!nameValidation.isValid) {
      return res.status(400).json({ error: nameValidation.error });
    }

    // Proceed with removal
    const removed = registry.remove(name);

    if (removed) {
      broadcastSnapshot();
    }

    return res.json({ ok: true, removed });

  } catch (error) {
    console.error('Error in /unsubscribe endpoint:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'snapshot', nodes: registry.list() }));
});

registry.addListener((s) => {
  const msg = JSON.stringify({ type: 'update', node: s });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch {}
    }
  }
});

const OFFLINE_UNSUBSCRIBE_MS = Number(process.env.OFFLINE_UNSUBSCRIBE_MS || 10 * 60 * 1000); // 10 minutes
const OFFLINE_SWEEP_INTERVAL_MS = Number(process.env.OFFLINE_SWEEP_INTERVAL_MS || 30 * 1000); // 30 seconds

function broadcastSnapshot() {
  const payload = JSON.stringify({ type: 'snapshot', nodes: registry.list() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch {}
    }
  }
}

let cleanupRunning = false;
setInterval(() => {
  if (cleanupRunning) {
    console.debug('Skipping offline cleanup - already running');
    return;
  }
  
  cleanupRunning = true;
  try {
    const now = Date.now();
    let removedAny = false;
    for (const n of registry.list()) {
      if (!n.connected && typeof n.lastUpdated === 'number' && Number.isFinite(n.lastUpdated)) {
        const age = now - n.lastUpdated;
        if (age > OFFLINE_UNSUBSCRIBE_MS) {
          const ok = registry.remove(n.name);
          if (ok) removedAny = true;
        }
      }
    }
    if (removedAny) broadcastSnapshot();
  } finally {
    cleanupRunning = false;
  }
}, OFFLINE_SWEEP_INTERVAL_MS);

setInterval(() => {
  for (const [, node] of registry.nodes.entries()) {
    if (node.rpc instanceof RpcWsClient) {
      node.rpc.cleanupOldRequests();
    }
  }
  
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
  
  console.debug(`Memory: ${heapUsedMB}MB/${heapTotalMB}MB | Nodes: ${registry.nodes.size} | Rate limiter IPs: ${requestCounts.size}`);
  
  // Alert if memory usage is high
  if (heapUsedMB > 500) {
    console.warn(`High memory usage detected: ${heapUsedMB}MB`);
  }
}, 5 * 60 * 1000); // Every 5 minutes

// Graceful shutdown handling
function gracefulShutdown() {
  console.log('Received shutdown signal, cleaning up...');
  
  // Stop all nodes and clean up resources
  for (const [name, node] of registry.nodes.entries()) {
    console.log(`Stopping node: ${name}`);
    node.stop();
  }
  
  // Clear all maps and sets
  registry.nodes.clear();
  requestCounts.clear();
  
  console.log('Cleanup completed, exiting...');
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

const PORT = Number(process.env.PORT || 8081);
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
