import WebSocket from 'ws';
import { RpcClient, PendingRequest } from '../types/rpc';

export class RpcWsClient implements RpcClient {
  private ws?: WebSocket;
  private url: string;
  private idCounter = 1;
  private pending = new Map<number, PendingRequest>();
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
    if (!this.shouldReconnect) {
      return;
    }
    this.clearReconnect();
    
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

  call<T = any>(method: string, params: any[] = [], timeoutMs: number = 15000): Promise<T> {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      return Promise.reject(new Error('WS not connected'));
    }
    const id = this.idCounter++;
    const payload = { jsonrpc: '2.0', id, method, params };
    
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pendingItem = this.pending.get(id);
        if (pendingItem) {
          clearTimeout(pendingItem.timeout);
          this.pending.delete(id);
          reject(new Error(`RPC request timeout for method: ${method} (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      const pendingItem: PendingRequest = {
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