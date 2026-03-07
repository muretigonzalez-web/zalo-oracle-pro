/**
 * ZALO ORACLE PRO
 * FILE: js/deriv-api.js
 * MODE: API Token (paste token) — works without App ID registration
 * WebSocket: wss://ws.derivws.com/websockets/v3?app_id=1089
 */

const DerivAPI = (() => {

  const APP_ID = '1089';
  const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

  let socket         = null;
  let reconnectCount = 0;
  let maxReconnects  = 5;
  let pingInterval   = null;
  let isAuthorized   = false;
  let pendingMsgs    = [];

  const handlers = {};

  const on = (event, fn) => {
    if (!handlers[event]) handlers[event] = [];
    handlers[event].push(fn);
  };

  const off = (event, fn) => {
    if (!handlers[event]) return;
    if (fn) {
      handlers[event] = handlers[event].filter(f => f !== fn);
    } else {
      handlers[event] = []; // clear all listeners for this event
    }
  };

  const emit = (event, data) => {
    (handlers[event] || []).forEach(fn => {
      try { fn(data); } catch(e) { console.error(`[DerivAPI] handler error (${event}):`, e); }
    });
  };

  const connect = () => {
    if (socket && (socket.readyState === WebSocket.OPEN ||
                   socket.readyState === WebSocket.CONNECTING)) return;
    updateStatus('connecting');
    socket = new WebSocket(WS_URL);

    socket.onopen = () => {
      reconnectCount = 0;
      updateStatus('connected');
      startPing();
      while (pendingMsgs.length > 0) socket.send(pendingMsgs.shift());
      emit('open', {});
    };

    socket.onmessage = (e) => {
      try { handleMessage(JSON.parse(e.data)); }
      catch(err) { console.error('[DerivAPI] parse error:', err); }
    };

    socket.onclose = () => {
      isAuthorized = false;
      updateStatus('disconnected');
      stopPing();
      emit('close', {});
      attemptReconnect();
    };

    socket.onerror = (err) => console.error('[DerivAPI] WS error:', err);
  };

  const send = (obj) => {
    const msg = JSON.stringify(obj);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(msg);
    } else {
      pendingMsgs.push(msg);
      if (!socket || socket.readyState === WebSocket.CLOSED) connect();
    }
  };

  const handleMessage = (data) => {
    if (data.error) {
      emit('error', { type: data.msg_type || 'general', message: data.error.message, code: data.error.code });
      return;
    }
    switch (data.msg_type) {
      case 'authorize':
        isAuthorized = true;
        updateStatus('authorized');
        emit('authorize',  data.authorize);
        emit('authorized', data.authorize);
        break;
      case 'tick':
        emit('tick', { symbol: data.tick.symbol, quote: data.tick.quote, pip_size: data.tick.pip_size || 2, epoch: data.tick.epoch });
        break;
      case 'history':
        // pip_size comes from ticks_history response root level
        emit('history', {
          prices   : data.history ? data.history.prices : [],
          times    : data.history ? data.history.times  : [],
          pip_size : data.pip_size || null,
        });
        break;
      case 'proposal':
        if (data.proposal) emit('proposal', { id: data.proposal.id, ask_price: data.proposal.ask_price, payout: data.proposal.payout, longcode: data.proposal.longcode });
        break;
      case 'buy':
        if (data.buy) emit('buy', { contract_id: data.buy.contract_id, buy_price: data.buy.buy_price, payout: data.buy.payout, shortcode: data.buy.shortcode });
        break;
      case 'sell':
        emit('sell', data.sell || {});
        break;
      case 'balance':
        if (data.balance) emit('balance', { balance: data.balance.balance, currency: data.balance.currency });
        break;
      case 'proposal_open_contract':
        if (data.proposal_open_contract) {
          const c = data.proposal_open_contract;
          emit('contract_update', c);
          if (c.is_sold === 1) {
            const profit = parseFloat(c.profit || 0);
            emit('contract_settled', {
              contract_id: c.contract_id, profit,
              buy_price: parseFloat(c.buy_price || 0), payout: parseFloat(c.payout || 0),
              is_won: profit > 0, status: c.status,
              digit: c.exit_tick_display_value ? (() => { const s = String(c.exit_tick_display_value).trim(); return parseInt(s[s.length-1]); })() : null,
            });
          }
        }
        break;
      case 'ping': break;
      default: emit(data.msg_type, data); break;
    }
  };

  const authorize            = (token) => send({ authorize: token });
  const subscribeTicks       = (symbol) => send({ ticks: symbol, subscribe: 1 });
  const unsubscribeTicks     = () => send({ forget_all: 'ticks' });
  const getTickHistory       = (symbol, count = 500) => send({ ticks_history: symbol, count, end: 'latest', style: 'ticks', adjust_start_time: 1 });
  const subscribeBalance     = () => send({ balance: 1, subscribe: 1 });
  const subscribeOpenContract= (id) => send({ proposal_open_contract: 1, contract_id: id, subscribe: 1 });
  const subscribeOpenContracts = () => send({ proposal_open_contract: 1, subscribe: 1 });
  const buyContract          = (id, price) => send({ buy: id, price });
  const forget               = (id) => send({ forget: id });
  const forgetAll            = (type) => send({ forget_all: type });

  const getProposal = ({ symbol, contractType, duration, durationUnit, stake, barrier }) => {
    const req = {
      proposal: 1, subscribe: 1, amount: stake, basis: 'stake',
      contract_type: contractType, currency: localStorage.getItem('zalo_currency') || 'USD',
      duration: duration || 1, duration_unit: durationUnit || 't', symbol,
    };
    if (barrier !== undefined && barrier !== null && barrier !== '') req.barrier = String(barrier);
    send(req);
  };

  const startPing = () => {
    stopPing();
    pingInterval = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) send({ ping: 1 });
    }, 30000);
  };
  const stopPing = () => { if (pingInterval) { clearInterval(pingInterval); pingInterval = null; } };

  const attemptReconnect = () => {
    if (reconnectCount >= maxReconnects) return;
    reconnectCount++;
    setTimeout(() => {
      connect();
      const token = localStorage.getItem('zalo_api_token');
      if (token) {
        const waitOpen = setInterval(() => {
          if (socket && socket.readyState === WebSocket.OPEN) { authorize(token); clearInterval(waitOpen); }
        }, 300);
      }
    }, reconnectCount * 3000);
  };

  const disconnect = () => {
    if (socket) { socket.onclose = null; socket.close(); socket = null; }
    stopPing(); isAuthorized = false; updateStatus('disconnected');
  };

  const updateStatus = (state) => {
    const dot  = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (!dot || !text) return;
    const map = {
      connecting:   { cls: 'connecting',  label: 'Connecting...' },
      connected:    { cls: 'connected',   label: 'Connected'     },
      authorized:   { cls: 'authorized',  label: 'Authorized'    },
      disconnected: { cls: '',            label: 'Disconnected'  },
    };
    const s = map[state] || map.disconnected;
    dot.className = s.cls; text.textContent = s.label;
  };

  return {
    connect, disconnect, send, authorize, on, off,
    subscribeTicks, unsubscribeTicks, getTickHistory, getProposal,
    buyContract, subscribeBalance, subscribeOpenContract, subscribeOpenContracts,
    forget, forgetAll,
    get isAuthorized() { return isAuthorized; },
    get socket() { return socket; },
    get isConnected() { return socket && socket.readyState === WebSocket.OPEN; },
  };

})();
