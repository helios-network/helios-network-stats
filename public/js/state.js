export const state = {
  nodes: {},
  nodesLoading: true,
  OFFLINE_PRUNE_MS: 10 * 60 * 1000,
  chartLen: 30,
  labels: [],
  series: { bt: [], bp: [], tx: [], gs: [] },
  lastBestBlock: null,
  historyState: { loaded: false, loading: false, retryTimer: null, lastLoadTime: 0, cacheValidMs: 60000 },
};

export function isStale(n) {
  if (!n) return false;
  if (n.connected) return false;
  
  const ts = typeof n.lastDisconnected === 'number' && Number.isFinite(n.lastDisconnected) 
    ? n.lastDisconnected 
    : n.lastUpdated;
    
  return typeof ts === 'number' && Number.isFinite(ts) && (Date.now() - ts > state.OFFLINE_PRUNE_MS);
}

export function pruneStaleNodes() {
  let changed = false;
  for (const [name, n] of Object.entries(state.nodes)) {
    if (name === '_orderedNames') continue;
    
    if (isStale(n)) {
      const ts = typeof n.lastDisconnected === 'number' && Number.isFinite(n.lastDisconnected) 
        ? n.lastDisconnected 
        : n.lastUpdated;
      const ageMs = Date.now() - ts;
      console.log(`Pruning stale node "${name}" (offline for ${Math.round(ageMs/1000)}s)`);
      
      delete state.nodes[name];
      if (state.nodes._orderedNames && Array.isArray(state.nodes._orderedNames)) {
        const index = state.nodes._orderedNames.indexOf(name);
        if (index !== -1) {
          state.nodes._orderedNames.splice(index, 1);
        }
      }
      const el = document.getElementById(`row-${name}`);
      if (el && el.parentElement) el.parentElement.removeChild(el);
      changed = true;
    }
  }
  return changed;
}

export function hasConnectedNode() {
  try { 
    return Object.entries(state.nodes)
      .filter(([key]) => key !== '_orderedNames')
      .some(([, n]) => n && n.connected); 
  } catch { 
    return false; 
  }
}

