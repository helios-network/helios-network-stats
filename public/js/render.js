import { state, pruneStaleNodes, isStale } from './state.js';
import * as el from './elements.js';
import { fmtNum, fmtDur, fmtGwei, fmtMs } from './format.js';
import { maybePushBlockSample } from './charts.js';

function listHeadHtml() {
  return `
    <div class="list-head">
      <div>Name</div>
      <div>Latest block</div>
      <div>Latency</div>
      <div>Status</div>
    </div>
  `;
}

function listSkeletonHtml() {
  const rows = Array.from({ length: 4 }).map(() => `
    <div class="row">
      <div class="name"><span class="skeleton skeleton-line" style="width: 140px"></span></div>
      <div class="latest"><span class="skeleton skeleton-line" style="width: 80px"></span></div>
      <div class="latency"><span class="skeleton skeleton-line" style="width: 56px"></span></div>
      <div class="status"><span class="skeleton skeleton-line" style="width: 72px"></span></div>
    </div>
  `).join('');
  return listHeadHtml() + rows;
}

function listEmptyHtml() {
  return `
    <div class="empty" role="status" aria-live="polite">
      <div class="icon" aria-hidden="true"><i class="fa-solid fa-network-wired"></i></div>
      <div class="title">No nodes yet</div>
      <div class="hint">Subscribe a node in the tools to get started.</div>
    </div>
  `;
}

function rowHtml(n) {
  const status = n.connected ? 'Online' : 'Offline';
  const pillClass = n.connected ? 'ok' : 'err';
  const lat = (() => {
    const ms = n.latencyMs;
    if (!(typeof ms === 'number' && Number.isFinite(ms))) return '—';
    const cls = ms < 100 ? 'ok' : (ms < 500 ? 'warn' : 'err');
    return `<span class="pill ${cls}">${fmtMs(ms)}</span>`;
  })();
  return `
    <div class="row" id="row-${n.name}">
      <div class="name">${n.name}</div>
      <div class="latest">${fmtNum(n.latestBlock)}</div>
      <div class="latency">${lat}</div>
      <div class="status"><span class="pill ${pillClass}">${status}</span></div>
    </div>
  `;
}

export function render(charts) {
  pruneStaleNodes();
  if (state.nodesLoading) {
    el.nodesEl.classList.add('is-loading');
    el.nodesEl.setAttribute('aria-busy', 'true');
    el.nodesEl.innerHTML = listSkeletonHtml();
  } else {
    el.nodesEl.classList.remove('is-loading');
    el.nodesEl.removeAttribute('aria-busy');
    
    let arr;
    if (state.nodes._orderedNames && Array.isArray(state.nodes._orderedNames)) {
      arr = state.nodes._orderedNames
        .map(name => state.nodes[name])
        .filter(n => n && n.name && typeof n.name === 'string');
    } else {
      arr = Object.entries(state.nodes)
        .filter(([key, node]) => key !== '_orderedNames' && node && node.name && typeof node.name === 'string')
        .map(([, node]) => node)
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    
    el.nodesEl.innerHTML = arr.length ? (listHeadHtml() + arr.map(rowHtml).join('')) : listEmptyHtml();
  }
  updateStats(charts);
}

export function renderOne(name, charts) {
  const n = state.nodes[name];
  if (!n || isStale(n)) {
    if (n && isStale(n)) {
      delete state.nodes[name];
      
      if (state.nodes._orderedNames && Array.isArray(state.nodes._orderedNames)) {
        const index = state.nodes._orderedNames.indexOf(name);
        if (index !== -1) {
          state.nodes._orderedNames.splice(index, 1);
        }
      }
    }
    const staleEl = document.getElementById(`row-${name}`);
    if (staleEl && staleEl.parentElement) staleEl.parentElement.removeChild(staleEl);
    
    const nodeCount = Object.keys(state.nodes).filter(key => key !== '_orderedNames').length;
    if (nodeCount === 0) { render(charts); return; }
    updateStats(charts);
    return;
  }
  const row = document.getElementById(`row-${name}`);
  if (!row) { render(charts); return; }
  row.outerHTML = rowHtml(n);
  updateStats(charts);
}

export function updateStats(charts) {
  if (state.nodesLoading) {
    if (el.netStatsEl) {
      el.netStatsEl.classList.add('is-loading');
      el.netStatsEl.setAttribute('aria-busy', 'true');
    }
    return;
  } else {
    if (el.netStatsEl) {
      el.netStatsEl.classList.remove('is-loading');
      el.netStatsEl.removeAttribute('aria-busy');
    }
  }

  const vals = Object.entries(state.nodes)
    .filter(([key, node]) => key !== '_orderedNames' && node && typeof node === 'object')
    .map(([, node]) => node);
    
  if (el.sNodes) {
    const total = vals.length;
    const active = vals.filter(n => n && n.connected).length;
    el.sNodes.textContent = `${active}/${total}`;
  }
  if (el.sBest) {
    const blockNumbers = vals
      .map(n => (typeof n.latestBlock === 'number' && Number.isFinite(n.latestBlock) ? n.latestBlock : -Infinity))
      .filter(num => num > -Infinity);
    
    if (blockNumbers.length > 0) {
      const best = Math.max(...blockNumbers);
      el.sBest.textContent = fmtNum(best);
      maybePushBlockSample(charts, best);
    } else {
      el.sBest.textContent = '—';
    }
  }
  if (el.sAvgT) {
    const ts = vals.map(n => n.blockTimeAvgMs).filter(x => typeof x === 'number' && Number.isFinite(x));
    const avg = ts.length ? (ts.reduce((a,b)=>a+b,0) / ts.length) : undefined;
    el.sAvgT.textContent = fmtDur(avg);
  }
  if (el.sGasP) {
    const ps = vals.map(n => n.gasPriceGwei).filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a,b)=>a-b);
    const mid = ps.length ? (ps.length % 2 ? ps[(ps.length-1)/2] : (ps[ps.length/2-1] + ps[ps.length/2]) / 2) : undefined;
    el.sGasP.textContent = fmtGwei(mid);
  }
  if (el.sGasL) {
    const ls = vals.map(n => n.gasLimit).filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a,b)=>a-b);
    const mid = ls.length ? (ls.length % 2 ? ls[(ls.length-1)/2] : (ls[ls.length/2-1] + ls[ls.length/2]) / 2) : undefined;
    el.sGasL.textContent = fmtNum(mid);
  }
}
