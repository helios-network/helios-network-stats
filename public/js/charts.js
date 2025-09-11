import { fmtNum, fmtDur, fmtEth } from './format.js';
import { state } from './state.js';
import * as el from './elements.js';

const gridColor = 'rgba(4,15,52,0.06)';

function hexToRgb(hex) {
  const m = (hex || '').trim().replace('#','');
  if (m.length === 3) {
    const r = parseInt(m[0]+m[0],16), g=parseInt(m[1]+m[1],16), b=parseInt(m[2]+m[2],16);
    return {r,g,b};
  }
  const r = parseInt(m.slice(0,2),16), g = parseInt(m.slice(2,4),16), b = parseInt(m.slice(4,6),16);
  return {r,g,b};
}

function rgbaStr({r,g,b}, a) { return `rgba(${r},${g},${b},${a})`; }

export function makeChart(canvas, formatLabel, opts = {}) {
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const stateLocal = { labels: [], data: [], hover: -1 };
  const pad = { top: 8, right: 10, bottom: 18, left: 10 };
  const catPct = 0.7, barPct = 0.7;
  const maxBarThickness = 22;
  const colorHex = opts.color || '#002DCB';
  const colorRGB = hexToRgb(colorHex);
  const cornerRadius = Number.isFinite(opts.radius) ? opts.radius : 3;
  const fmt = typeof formatLabel === 'function' ? formatLabel : (v) => (typeof v === 'number' ? String(v) : '—');

  // Lazily sized canvas
  function resizeCtx() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 150;
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function roundRect(x, y, w, h, r) {
    let tl, tr, br, bl;
    if (typeof r === 'number') { tl = tr = br = bl = r; }
    else { r = r || {}; tl = r.tl || 0; tr = r.tr || 0; br = r.br || 0; bl = r.bl || 0; }
    const clamp = (v) => Math.max(0, Math.min(v, Math.min(w / 2, h / 2)));
    tl = clamp(tl); tr = clamp(tr); br = clamp(br); bl = clamp(bl);
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    ctx.lineTo(x + bl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
    ctx.lineTo(x, y + tl);
    ctx.quadraticCurveTo(x, y, x + tl, y);
    ctx.closePath();
  }

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.style.display = 'none';
  document.body.appendChild(tip);

  function showTip(html, px, py) {
    tip.innerHTML = html;
    tip.style.display = 'block';
    const rect = tip.getBoundingClientRect();
    let left = px + 12; let top = py + 12;
    if (left + rect.width + 8 > window.innerWidth) left = px - rect.width - 12;
    if (top + rect.height + 8 > window.innerHeight) top = py - rect.height - 12;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  function hideTip() { tip.style.display = 'none'; }

  function draw() {
    const { w, h } = resizeCtx();
    ctx.clearRect(0, 0, w, h);
    const area = { x: pad.left, y: pad.top, w: w - pad.left - pad.right, h: h - pad.top - pad.bottom };
    const barAreaH = area.h;
    const barAreaY = area.y;

    // grid
    ctx.save();
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    const ticks = 4;
    const vals = stateLocal.data.filter(v => typeof v === 'number' && Number.isFinite(v));
    const dataMax = Math.max(0, ...vals);
    const scaleMax = dataMax > 0 ? dataMax : 1;
    for (let i = 0; i <= ticks; i++) {
      const ty = area.y + area.h - (i / ticks) * area.h + 0.5;
      ctx.beginPath(); ctx.moveTo(area.x, ty); ctx.lineTo(area.x + area.w, ty); ctx.stroke();
    }
    ctx.restore();

    // bars
    const n = stateLocal.data.length;
    if (!n) return;
    const slot = area.w / n;
    const catW = slot * catPct;
    const barW = Math.min(catW * barPct, maxBarThickness);
    const barOffset = (slot - barW) / 2;

    const grd = ctx.createLinearGradient(0, barAreaY, 0, barAreaY + barAreaH);
    grd.addColorStop(0, rgbaStr(colorRGB, 0.85));
    grd.addColorStop(1, rgbaStr(colorRGB, 0.25));

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.06)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = grd;
    ctx.strokeStyle = rgbaStr(colorRGB, 0.9);
    for (let i = 0; i < n; i++) {
      const v = stateLocal.data[i];
      if (!(typeof v === 'number' && Number.isFinite(v))) continue;
      const x = area.x + i * slot + barOffset;
      const hVal = Math.max(0, Math.min(1, v / scaleMax)) * barAreaH;
      const y = barAreaY + barAreaH - hVal;
      roundRect(x, y, barW, hVal, { tl: cornerRadius, tr: cornerRadius, br: 0, bl: 0 });
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    // hover outline
    if (stateLocal.hover >= 0 && stateLocal.hover < n) {
      const slot2 = area.w / n;
      const barW2 = Math.min(slot2 * catPct * barPct, maxBarThickness);
      const barOffset2 = (slot2 - barW2) / 2;
      const i = stateLocal.hover;
      const v = stateLocal.data[i];
      if (typeof v === 'number' && Number.isFinite(v)) {
        const x = area.x + i * slot2 + barOffset2;
        const hVal = Math.max(0, Math.min(1, v / scaleMax)) * barAreaH;
        const y = barAreaY + barAreaH - hVal;
        ctx.save();
        ctx.lineWidth = 2;
        ctx.strokeStyle = rgbaStr(colorRGB, 1);
        roundRect(x - 1, y - 1, barW2 + 2, Math.max(hVal + 2, 6), { tl: Math.max(1, cornerRadius), tr: Math.max(1, cornerRadius), br: 0, bl: 0 });
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  function handleMove(ev) {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width; const h = rect.height;
    const area = { x: pad.left, y: pad.top, w: w - pad.left - pad.right, h: h - pad.top - pad.bottom };
    const x = ev.clientX - rect.left - area.x;
    if (x < 0 || x > area.w) { if (stateLocal.hover !== -1) { stateLocal.hover = -1; hideTip(); draw(); } return; }
    const n = stateLocal.data.length || 1;
    const slot = area.w / n;
    const idx = Math.max(0, Math.min(n - 1, Math.floor(x / slot)));
    if (idx !== stateLocal.hover) { stateLocal.hover = idx; draw(); }
    const v = stateLocal.data[idx];
    const label = stateLocal.labels[idx] || '';
    const vStr = fmt(v);
    showTip(`<span class="k">${label}</span><strong>${vStr}</strong>`, ev.clientX, ev.clientY);
  }

  function handleLeave() { if (stateLocal.hover !== -1) { stateLocal.hover = -1; draw(); } hideTip(); }
  canvas.addEventListener('mousemove', handleMove);
  canvas.addEventListener('mouseleave', handleLeave);

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
  } else {
    window.addEventListener('resize', draw);
  }

  const chart = {
    data: { labels: [], datasets: [{ data: [] }] },
    update() {
      stateLocal.labels = chart.data.labels || [];
      stateLocal.data = (chart.data.datasets && chart.data.datasets[0] && chart.data.datasets[0].data) || [];
      draw();
    },
  };
  return chart;
}

export function initCharts() {
  const chBT = makeChart(el.cBT, (v) => fmtDur(v), { color: '#2E5BFF', radius: 3 });
  const chBP = makeChart(el.cBP, (v) => fmtDur(v), { color: '#64748B', radius: 3 });
  const chTX = makeChart(el.cTX, (v) => fmtNum(v), { color: '#16A34A', radius: 3 });
  const chGS = makeChart(el.cGS, (v) => fmtEth(v), { color: '#EF4444', radius: 3 });
  return { chBT, chBP, chTX, chGS };
}

function median(arr) {
  const xs = arr.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a,b)=>a-b);
  if (!xs.length) return undefined;
  const mid = xs.length>>1;
  return xs.length%2 ? xs[mid] : (xs[mid-1]+xs[mid])/2;
}

export function maybePushBlockSample(charts, bestBlock) {
  if (!(typeof bestBlock === 'number' && Number.isFinite(bestBlock))) return;
  if (bestBlock === state.lastBestBlock) return;
  state.lastBestBlock = bestBlock;

  const vals = Object.values(state.nodes);
  const atBest = vals.filter(n => n && typeof n.latestBlock === 'number' && n.latestBlock === bestBlock);
  const sampleFrom = atBest.length ? atBest : vals; // fallback if no node at best yet

  const bt = median(sampleFrom.map(n => n.blockTimeMs ?? n.blockTimeAvgMs));
  const bp = median(sampleFrom.map(n => n.blockPropagationMs));
  const tx = median(sampleFrom.map(n => n.blockTxs));
  const gsEth = median(sampleFrom.map(n => (typeof n.gasPriceGwei==='number' && typeof n.gasUsed==='number') ? (n.gasPriceGwei * n.gasUsed / 1e9) : undefined));

  const label = `#${bestBlock}`;
  state.labels.push(label); if (state.labels.length > state.chartLen) state.labels.shift();
  const push = (arr, v) => { arr.push(typeof v === 'number' && Number.isFinite(v) ? v : null); if (arr.length>state.chartLen) arr.shift(); };
  push(state.series.bt, bt);
  push(state.series.bp, bp);
  push(state.series.tx, tx);
  push(state.series.gs, gsEth);

  if (charts && charts.chBT) { charts.chBT.data.labels = state.labels; charts.chBT.data.datasets[0].data = state.series.bt; charts.chBT.update(); if (el.lBT) el.lBT.textContent = bt!==undefined ? fmtDur(bt) : '—'; }
  if (charts && charts.chBP) { charts.chBP.data.labels = state.labels; charts.chBP.data.datasets[0].data = state.series.bp; charts.chBP.update(); if (el.lBP) el.lBP.textContent = bp!==undefined ? fmtDur(bp) : '—'; }
  if (charts && charts.chTX) { charts.chTX.data.labels = state.labels; charts.chTX.data.datasets[0].data = state.series.tx; charts.chTX.update(); if (el.lTX) el.lTX.textContent = tx!==undefined ? fmtNum(tx) : '—'; }
  if (charts && charts.chGS) { charts.chGS.data.labels = state.labels; charts.chGS.data.datasets[0].data = state.series.gs; charts.chGS.update(); if (el.lGS) el.lGS.textContent = gsEth!==undefined ? fmtEth(gsEth) : '—'; }
}

