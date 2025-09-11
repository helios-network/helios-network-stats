export function fmtNum(n) { return typeof n === 'number' ? n.toLocaleString() : '—'; }

export function fmtDur(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${(ms/1000).toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtGwei(n) { return typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(1)} Gwei` : '—'; }
export function fmtEth(n) { return typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(4)} ETH` : '—'; }

