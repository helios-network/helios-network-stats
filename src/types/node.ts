export interface NodeSnapshot {
  name: string;
  host: string;
  rpcPort: number;
  wsRpcPort: number;
  connected: boolean;
  lastError?: string;
  latestBlock?: number;
  peerCount?: number;
  clientVersion?: string;
  syncing?: boolean | { startingBlock: string; currentBlock: string; highestBlock: string };
  mining?: boolean;
  latencyMs?: number;
  gasPriceGwei?: number;
  gasLimit?: number;
  gasUsed?: number;
  blockTimeMs?: number;
  blockTimeAvgMs?: number;
  blockPropagationMs?: number;
  blockTxs?: number;
  cronTxs?: string[];
  cronTxsCount?: number;
  lastUpdated?: number;
  uptimeMs?: number;
}

export interface PersistedNode {
  name: string;
  host: string;
  rpcPort: number;
  wsRpcPort: number;
}

export interface SubscribeBody {
  name: string;
  port?: number;
}

export type NodeId = string;
