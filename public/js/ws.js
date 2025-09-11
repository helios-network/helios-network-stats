const wsUrl = (() => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
})();

export function connectWebSocket(handlers = {}) {
  let ws;
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => { if (handlers.onOpen) handlers.onOpen(); };
    ws.onclose = () => {
      if (handlers.onClose) handlers.onClose();
      setTimeout(connect, 1500);
    };
    ws.onerror = () => { if (handlers.onError) handlers.onError(); };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'snapshot') {
        if (handlers.onSnapshot) handlers.onSnapshot(msg.nodes || []);
      } else if (msg.type === 'update') {
        if (handlers.onUpdate) handlers.onUpdate(msg.node);
      }
    };
  }
  connect();
  return () => { try { ws && ws.close(); } catch {} };
}

