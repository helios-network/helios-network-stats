import { NodeSnapshot } from '../types/node';
import { RpcClient } from '../types/rpc';
import { RpcWsClient } from './RpcWsClient';
import { toHexBlock } from '../utils/file';

export class NodeEntry {
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

  constructor(name: string, host: string, rpcPort: number, wsRpcPort: number) {
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
      const gasPrice = parseInt(gasPriceHex, 16);
      const gasGwei = Number.isFinite(gasPrice) ? gasPrice / 1e9 : undefined;

      this.snapshot.latestBlock = Number.isFinite(latestBlock) ? latestBlock : this.snapshot.latestBlock;
      this.snapshot.peerCount = Number.isFinite(peerCount) ? peerCount : this.snapshot.peerCount;
      this.snapshot.clientVersion = clientVer || this.snapshot.clientVersion;
      this.snapshot.syncing = syncing || this.snapshot.syncing;
      this.snapshot.mining = mining;
      this.snapshot.latencyMs = latencyMs;
      this.snapshot.gasPriceGwei = gasGwei;

      if (Number.isFinite(latestBlock)) {
        const latestBlockObj = await this.rpc
          .call<any>('eth_getBlockByNumber', [toHexBlock(latestBlock), false])
          .catch(() => undefined);
        if (latestBlockObj) {
          const tsSec = parseInt(latestBlockObj.timestamp, 16) || undefined;
          const txCount = Array.isArray(latestBlockObj.transactions) ? latestBlockObj.transactions.length : undefined;
          this.snapshot.blockTxs = txCount;
          const gasUsed = parseInt(latestBlockObj.gasUsed, 16);
          this.snapshot.gasUsed = Number.isFinite(gasUsed) ? gasUsed : this.snapshot.gasUsed;
          const gasLimit = parseInt(latestBlockObj.gasLimit, 16);
          this.snapshot.gasLimit = Number.isFinite(gasLimit) ? gasLimit : this.snapshot.gasLimit;
          if (tsSec) {
            this.snapshot.blockPropagationMs = Date.now() - tsSec * 1000;
            
            if (this.lastBlockTimestampSec && tsSec > this.lastBlockTimestampSec) {
              const dt = (tsSec - this.lastBlockTimestampSec) * 1000;
              this.snapshot.blockTimeMs = dt;
              this.timesWindow.push(dt);
              if (this.timesWindow.length > 10) this.timesWindow.shift();
            }
            this.lastBlockTimestampSec = tsSec;
            if (this.timesWindow.length) {
              const sum = this.timesWindow.reduce((a, b) => a + b, 0);
              this.snapshot.blockTimeAvgMs = sum / this.timesWindow.length;
            }
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
