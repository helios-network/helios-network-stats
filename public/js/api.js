export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${method} ${path} -> ${res.status} ${res.statusText} ${t}`);
  }
  return res.json();
}

export async function fetchSnapshot() {
  const res = await fetch('/nodes');
  const data = await res.json();
  const next = {};
  (data.nodes || []).forEach((n) => (next[n.name] = n));
  return next;
}

