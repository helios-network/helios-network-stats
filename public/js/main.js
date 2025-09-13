import { INCLUDE_TOOLS } from './env.js';
import * as el from './elements.js';
import { state, pruneStaleNodes, hasConnectedNode } from './state.js';
import { initTheme, toggleTheme } from './theme.js';
import { connectWebSocket } from './ws.js';
import { fetchSnapshot } from './api.js';
import { render, renderOne } from './render.js';
import { setHistoryLoading, maybeLoadHistory, resetHistoryState } from './history.js';
import { initCharts } from './charts.js';
import { setupDevtools } from './devtools.js';

// Initialize theme and UI events
initTheme();
if (el.themeToggleBtn) el.themeToggleBtn.addEventListener('click', toggleTheme);

// Charts and history loading state
setHistoryLoading(true);
const charts = initCharts();

// Dev tools
setupDevtools(charts);

// Connection status UI
if (el.connEl) { el.connEl.textContent = 'Connecting…'; el.connEl.className = 'badge warn'; }

// WebSocket live updates
connectWebSocket({
  onOpen() {
    if (el.connEl) { el.connEl.textContent = 'Connected'; el.connEl.className = 'badge ok'; }
  },
  onClose() {
    if (el.connEl) { el.connEl.textContent = 'Offline, reconnecting…'; el.connEl.className = 'badge warn'; }
  },
  onError() {
    if (el.connEl) { el.connEl.textContent = 'Connection error'; el.connEl.className = 'badge err'; }
  },
  onSnapshot(nodesArr) {
    state.nodes = {};
    const orderedNames = [];
    (nodesArr || []).forEach((n) => {
      state.nodes[n.name] = n;
      orderedNames.push(n.name);
    });
    state.nodes._orderedNames = orderedNames;
    state.nodesLoading = false;
    pruneStaleNodes();
    render(charts);
    maybeLoadHistory(charts);
  },
  onUpdate(node) {
    if (!node || !node.name) return;
    state.nodes[node.name] = node;
    renderOne(node.name, charts);
  },
});

// Initial snapshot (HTTP) as a fallback
(async () => {
  try {
    const next = await fetchSnapshot();
    state.nodes = next;
    state.nodesLoading = false;
    render(charts);
    maybeLoadHistory(charts);
  } catch {
    // ignore, WS should fill later
  }
})();

// Periodically prune stale nodes and re-render
setInterval(() => { if (pruneStaleNodes()) render(charts); }, 30 * 1000);

setInterval(() => { 
  if (!state.historyState.loaded && !state.historyState.loading && hasConnectedNode()) {
    maybeLoadHistory(charts);
  }
}, 5 * 1000);

