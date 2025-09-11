import { Request, Response } from 'express';
import { Registry } from '../services/Registry';
import { SubscribeBody } from '../types/node';
import { 
  validateNodeName, 
  validateHost, 
  validatePort, 
  validateWebSocketUrl 
} from '../utils/validation';

export class NodeController {
  constructor(private registry: Registry) {}

  async subscribe(req: Request<{}, {}, SubscribeBody>, res: Response) {
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
        finalHost = host!;
      }

      // All validations passed - proceed with registration
      this.registry.upsert(name, finalHost, Number(rpcPort), Number(wsRpcPort));
      return res.json({ ok: true });

    } catch (error) {
      console.error('Error in /subscribe endpoint:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  async unsubscribe(req: Request<{}, {}, { name: string }>, res: Response) {
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
      const removed = this.registry.remove(name);
      return res.json({ ok: true, removed });

    } catch (error) {
      console.error('Error in /unsubscribe endpoint:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  getNodes(req: Request, res: Response) {
    res.json({ nodes: this.registry.list() });
  }

  async getHistory(req: Request, res: Response) {
    try {
      // Validate count parameter
      const countParam = req.query.count;
      let count = 60; // default value
      
      if (countParam !== undefined) {
        const parsedCount = Number(countParam);
        if (!Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount > 200) {
          return res.status(400).json({ 
            error: 'Count parameter must be an integer between 1 and 200' 
          });
        }
        count = parsedCount;
      }
      
      const entry = this.registry.getMostAdvancedConnected();
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

      const blocks = await Promise.all(
        needed.map(blockNum => 
          entry.rpc.call<any>('eth_getBlockByNumber', ['0x' + blockNum.toString(16), false])
            .catch(() => null)
        )
      );

      const labels: string[] = [];
      const bt: (number | null)[] = [];
      const bp: (number | null)[] = [];
      const tx: (number | null)[] = [];
      const gs: (number | null)[] = [];

      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const prev = i > 0 ? blocks[i - 1] : null;
        if (!b) {
          labels.push('');
          bt.push(null);
          bp.push(null);
          tx.push(null);
          gs.push(null);
          continue;
        }
        labels.push('#' + parseInt(b.number, 16));
        if (!prev) {
          bt.push(null);
          bp.push(null);
          tx.push(null);
          gs.push(null);
          continue;
        }
        const ts = parseInt(b.timestamp, 16);
        const tsPrev = parseInt(prev.timestamp, 16);
        const dtMs = (Number.isFinite(ts) && Number.isFinite(tsPrev)) ? Math.max(0, (ts - tsPrev) * 1000) : null;
        const cronCount = Array.isArray((b as any).cronTransactions) ? (b as any).cronTransactions.length : null;
        const txCount = Array.isArray(b.transactions) ? b.transactions.length : null;
        const gasUsed = parseInt(b.gasUsed, 16);
        bt.push(dtMs);
        bp.push(Number.isFinite(cronCount as any) ? (cronCount as any) : null);
        tx.push(Number.isFinite(txCount as any) ? (txCount as any) : null);
        gs.push(Number.isFinite(gasUsed) ? gasUsed : null);
      }

      return res.json({ ok: true, labels, series: { bt, bp, tx, gs }, best });
    } catch (e: any) {
      return res.status(502).json({ ok: false, error: String(e?.message || e) });
    }
  }
}
