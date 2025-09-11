import { INCLUDE_TOOLS } from './env.js';
import * as el from './elements.js';
import { api, fetchSnapshot } from './api.js';
import { state } from './state.js';
import { resetHistoryState, maybeLoadHistory } from './history.js';
import { render } from './render.js';

export function setupDevtools(charts) {
  if (!INCLUDE_TOOLS) return;

  function setMsg(kind, text) {
    if (!el.subMsg) return;
    el.subMsg.className = `sub-msg ${kind}`;
    el.subMsg.textContent = text || '';
  }

  async function onSubscribe(e) {
    e.preventDefault();
    const name = (el.fName && el.fName.value || '').trim();
    const host = (el.fHost && el.fHost.value || '').trim();
    const wsUrl = (el.fWsUrl && el.fWsUrl.value || '').trim();
    const rpcPort = Number((el.fRpc && el.fRpc.value) || 8545);
    const wsRpcPort = Number((el.fWs && el.fWs.value) || 8546);

    if (!name) { setMsg('err', 'Name is required'); return; }
    if (!host && !wsUrl) { setMsg('err', 'Host or WS URL is required'); return; }
    try {
      await api('POST', '/subscribe', { name, host, rpcPort, wsRpcPort, wsUrl });
      setMsg('ok', `Subscribed ${name}`);

      try {
        localStorage.setItem('helios:lastNodeName', name);
        localStorage.setItem('helios:lastHost', host);
        localStorage.setItem('helios:lastWsUrl', wsUrl);
        localStorage.setItem('helios:lastRpc', String(rpcPort));
        localStorage.setItem('helios:lastWs', String(wsRpcPort));
      } catch {}

      resetHistoryState();
      const next = await fetchSnapshot();
      state.nodes = next;
      state.nodesLoading = false;
      render(charts);
      maybeLoadHistory(charts);
    } catch (e) {
      setMsg('err', (e && e.message) || String(e));
    }
  }

  async function onUnsubscribe() {
    const name = (el.fName && el.fName.value || '').trim();
    if (!name) { setMsg('err', 'Name is required to unsubscribe'); return; }
    try {
      await api('POST', '/unsubscribe', { name });
      setMsg('ok', `Unsubscribed ${name}`);
      resetHistoryState();
      const next = await fetchSnapshot();
      state.nodes = next;
      state.nodesLoading = false;
      render(charts);
      maybeLoadHistory(charts);
    } catch (e) {
      setMsg('err', (e && e.message) || String(e));
    }
  }

  if (el.formEl) el.formEl.addEventListener('submit', onSubscribe);
  if (el.unsubBtn) el.unsubBtn.addEventListener('click', onUnsubscribe);
  if (el.toggleDevBtn && el.devPanel) {
    const updateDevBtn = () => {
      el.toggleDevBtn.textContent = el.devPanel.classList.contains('hidden') ? 'Show tools' : 'Hide tools';
    };
    try {
      const pref = localStorage.getItem('helios:showDevPanel');
      if (pref === '1') el.devPanel.classList.remove('hidden');
      else el.devPanel.classList.add('hidden');
    } catch {}
    updateDevBtn();
    el.toggleDevBtn.addEventListener('click', () => {
      el.devPanel.classList.toggle('hidden');
      updateDevBtn();
      try { localStorage.setItem('helios:showDevPanel', el.devPanel.classList.contains('hidden') ? '0' : '1'); } catch {}
    });
  }

  // Restore last form values
  try {
    if (el.fName) el.fName.value = localStorage.getItem('helios:lastNodeName') || '';
    if (el.fHost) el.fHost.value = localStorage.getItem('helios:lastHost') || '';
    if (el.fWsUrl) el.fWsUrl.value = localStorage.getItem('helios:lastWsUrl') || '';
    if (el.fRpc) el.fRpc.value = localStorage.getItem('helios:lastRpc') || '8545';
    if (el.fWs) el.fWs.value = localStorage.getItem('helios:lastWs') || '8546';
  } catch {}
}

