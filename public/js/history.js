import { state, hasConnectedNode } from './state.js';
import * as el from './elements.js';
import { fmtNum, fmtDur, fmtEth } from './format.js';

export function setHistoryLoading(on) {
  const chartEls = [el.cBT, el.cBP, el.cTX, el.cGS]
    .map(c => (c && c.closest) ? c.closest('.chart') : null)
    .filter(Boolean);
  chartEls.forEach(ch => {
    if (on) {
      ch.setAttribute('data-loading', '1');
      ch.classList.add('is-loading');
      ch.setAttribute('aria-busy', 'true');
    } else {
      ch.removeAttribute('data-loading');
      ch.classList.remove('is-loading');
      ch.removeAttribute('aria-busy');
    }
  });
  [el.lBT, el.lBP, el.lTX, el.lGS].forEach(x => { if (!x) return; if (on) x.classList.add('skeleton'); else x.classList.remove('skeleton'); });
}

export function resetHistoryState() {
  state.historyState.loaded = false;
  state.historyState.loading = false;
  if (state.historyState.retryTimer) {
    clearTimeout(state.historyState.retryTimer);
    state.historyState.retryTimer = null;
  }
}

export function scheduleHistoryRetry(delayMs, maybeLoadHistory) {
  if (state.historyState.retryTimer) clearTimeout(state.historyState.retryTimer);
  state.historyState.retryTimer = setTimeout(() => {
    state.historyState.retryTimer = null;
    maybeLoadHistory();
  }, Math.max(1000, delayMs || 2000));
}

export async function loadHistory(charts) {
  if (state.historyState.loading || state.historyState.loaded) return;
  state.historyState.loading = true;
  try {
    const res = await fetch('/history?count=' + encodeURIComponent(state.chartLen));
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(errorData.error || `HTTP ${res.status}`);
    }
    const hist = await res.json();
    if (!hist) throw new Error('empty response');
    if (!hist.ok && hist.error) throw new Error(hist.error);
    if (!hist.labels || !hist.series) throw new Error('invalid history format');

    const newLabels = (hist.labels || []).slice();
    const newBT = ((hist.series && hist.series.bt) || []).slice();
    const newBP = ((hist.series && hist.series.bp) || []).slice();
    const newTX = ((hist.series && hist.series.tx) || []).slice();
    const newGS = ((hist.series && hist.series.gs) || []).slice();

    const bestFromHist = typeof hist.best === 'number' ? hist.best : null;
    const parseBn = (lab) => {
      if (!lab || typeof lab !== 'string') return NaN;
      const m = lab.startsWith('#') ? lab.slice(1) : lab;
      const v = parseInt(m, 10);
      return Number.isFinite(v) ? v : NaN;
    };
    if (bestFromHist != null && state.labels.length > 0) {
      for (let i = 0; i < state.labels.length; i++) {
        const bn = parseBn(state.labels[i]);
        if (Number.isFinite(bn) && bn > bestFromHist) {
          newLabels.push(state.labels[i]);
          newBT.push(state.series.bt[i] ?? null);
          newBP.push(state.series.bp[i] ?? null);
          newTX.push(state.series.tx[i] ?? null);
          newGS.push(state.series.gs[i] ?? null);
        }
      }
    }

    while (newLabels.length > state.chartLen) {
      newLabels.shift(); newBT.shift(); newBP.shift(); newTX.shift(); newGS.shift();
    }

    state.labels.length = 0; Array.prototype.push.apply(state.labels, newLabels);
    state.series.bt = newBT; state.series.bp = newBP; state.series.tx = newTX; state.series.gs = newGS;
    if (typeof bestFromHist === 'number') state.lastBestBlock = bestFromHist;

    if (charts && charts.chBT) { charts.chBT.data.labels = state.labels; charts.chBT.data.datasets[0].data = state.series.bt; charts.chBT.update(); if (el.lBT) { const v = state.series.bt[state.series.bt.length-1]; el.lBT.textContent = v!=null ? fmtDur(v) : '—'; } }
    if (charts && charts.chBP) { charts.chBP.data.labels = state.labels; charts.chBP.data.datasets[0].data = state.series.bp; charts.chBP.update(); if (el.lBP) { const v = state.series.bp[state.series.bp.length-1]; el.lBP.textContent = v!=null ? fmtDur(v) : '—'; } }
    if (charts && charts.chTX) { charts.chTX.data.labels = state.labels; charts.chTX.data.datasets[0].data = state.series.tx; charts.chTX.update(); if (el.lTX) { const v = state.series.tx[state.series.tx.length-1]; el.lTX.textContent = v!=null ? fmtNum(v) : '—'; } }
    if (charts && charts.chGS) { charts.chGS.data.labels = state.labels; charts.chGS.data.datasets[0].data = state.series.gs; charts.chGS.update(); if (el.lGS) { const v = state.series.gs[state.series.gs.length-1]; el.lGS.textContent = v!=null ? fmtNum(v) : '—'; } }

    state.historyState.loaded = true;
    setHistoryLoading(false);
  } catch (e) {
    console.warn('Failed to load history:', e);
    setHistoryLoading(false);
    scheduleHistoryRetry(hasConnectedNode() ? 2000 : 3000, () => maybeLoadHistory(charts));
  } finally {
    state.historyState.loading = false;
  }
}

export function maybeLoadHistory(charts) {
  if (state.historyState.loaded || state.historyState.loading) return;
  if (!hasConnectedNode()) {
    setHistoryLoading(false);
    return;
  }
  loadHistory(charts);
}
