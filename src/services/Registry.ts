import * as fs from 'fs';
import { NodeId, NodeSnapshot, PersistedNode } from '../types/node';
import { NodeEntry } from './NodeEntry';
import { writeJsonAtomic } from '../utils/file';
import { config } from '../config/environment';

export class Registry {
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
    writeJsonAtomic(config.nodesDbPath, { nodes });
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
    const snapshots = Array.from(this.nodes.values()).map((n) => n.snapshot);
    snapshots.sort((a, b) => {
      const ac = a.connected ? 0 : 1;
      const bc = b.connected ? 0 : 1;
      if (ac !== bc) return ac - bc;
      
      const al = Number.isFinite(a.latencyMs as any) && (a.latencyMs as number) >= 0 ? (a.latencyMs as number) : Number.POSITIVE_INFINITY;
      const bl = Number.isFinite(b.latencyMs as any) && (b.latencyMs as number) >= 0 ? (b.latencyMs as number) : Number.POSITIVE_INFINITY;
      if (al !== bl) return al - bl;
      
      const au = Number.isFinite(a.lastUpdated as any) ? (a.lastUpdated as number) : -Infinity;
      const bu = Number.isFinite(b.lastUpdated as any) ? (b.lastUpdated as number) : -Infinity;
      if (au !== bu) return bu - au;
      return a.name.localeCompare(b.name);
    });
    return snapshots;
  }

  getFirstConnected(): NodeEntry | undefined {
    for (const n of this.nodes.values()) {
      if (n.snapshot.connected) return n;
    }
    return undefined;
  }

  getMostAdvancedConnected(): NodeEntry | undefined {
    let best: NodeEntry | undefined;
    let bestBlock = -Infinity;
    let bestUpdated = -Infinity;
    for (const n of this.nodes.values()) {
      const s = n.snapshot;
      if (!s.connected) continue;
      const lb = typeof s.latestBlock === 'number' ? s.latestBlock : -Infinity;
      const lu = typeof s.lastUpdated === 'number' ? s.lastUpdated : -Infinity;
      if (lb > bestBlock || (lb === bestBlock && lu > bestUpdated)) {
        best = n; bestBlock = lb; bestUpdated = lu;
      }
    }
    return best || this.getFirstConnected();
  }

  getLowestLatencyConnected(): NodeEntry | undefined {
    let best: NodeEntry | undefined;
    let bestLatency = Number.POSITIVE_INFINITY;
    let bestUpdated = -Infinity;
    for (const n of this.nodes.values()) {
      const s = n.snapshot;
      if (!s.connected) continue;
      const lat = Number.isFinite(s.latencyMs as any) && (s.latencyMs as number) >= 0 ? (s.latencyMs as number) : Number.POSITIVE_INFINITY;
      const lu = Number.isFinite(s.lastUpdated as any) ? (s.lastUpdated as number) : -Infinity;
      if (lat < bestLatency || (lat === bestLatency && lu > bestUpdated)) {
        best = n;
        bestLatency = lat;
        bestUpdated = lu;
      }
    }
    return best || this.getFirstConnected();
  }

  upsert(name: string, host: string, rpcPort = 8545, wsRpcPort = 8546) {
    const existing = this.nodes.get(name);
    if (existing) {
      existing.stop();
      // Small delay to ensure clean shutdown before starting new connection
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

  // Method to load persisted nodes
  loadPersistedNodes(): PersistedNode[] {
    try {
      if (!fs.existsSync(config.nodesDbPath)) return [];
      const raw = fs.readFileSync(config.nodesDbPath, 'utf8');
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
      console.error(`Failed to read persisted nodes from ${config.nodesDbPath}:`, error);
      console.warn('Returning empty node list due to read error');
      return [];
    }
  }

  // Initialize with persisted nodes
  initialize() {
    try {
      const initial = this.loadPersistedNodes();
      if (initial.length > 0) {
        console.log(`Loading ${initial.length} persisted node(s)`);
        for (const n of initial) {
          this.upsert(n.name, n.host, n.rpcPort, n.wsRpcPort);
        }
      }
    } catch (e) {
      console.error('Failed to load persisted nodes:', e);
    }
  }
}
