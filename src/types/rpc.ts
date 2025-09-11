export interface RpcClient {
  isConnected(): boolean;
  connect(onOpen?: () => void, onClose?: (code: number, reason: string) => void, onError?: (err: any) => void): void;
  disconnect(): void;
  call<T = any>(method: string, params?: any[]): Promise<T>;
  cleanupOldRequests(): void;
}

export interface PendingRequest {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timeout: NodeJS.Timeout;
  createdAt: number;
}