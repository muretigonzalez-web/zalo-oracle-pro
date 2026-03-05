/**
 * ZALO ORACLE PRO
 * FILE: js/deriv-api.js
 * MODE: API Token (paste token) — works without App ID registration
 * WebSocket: wss://ws.derivws.com/websockets/v3?app_id=1089
 * Auth: send { authorize: "YOUR_TOKEN" } after connection opens
 */

const DerivAPI = (() => {

  const APP_ID  = '1089'; // Public demo app_id — works for token auth
  const WS_URL  = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

  // ─── STATE ────────────────────────────────────────────────────────────────
  let socket         = null;
  let reconnectCount = 0;
  let maxReconnects  = 5;
  let pingInterval   = null;
  let isAuthorized   = false;
  let pendingMsgs    = [];

  // ─── EVENT HANDLERS ───────────────────────────────────────────────────────
  const handlers = {};

  const on = (event, fn) => {
    if (!handlers[event]) handlers[event] = [];
    handlers[event].push(fn);
  };

  const emit = (event, data) => {
    (handlers[event] || []).forEach(fn => {
      try { fn(data); } catch(e) { console.error(`[DerivAPI] handler error (${event}):`, e); }
    });
  };

  // ─── CONNECT ──────────────────────────────────────────────────────────────
  const connect = () => {
    if (socket && (socket.readyState === WebSocket.OPEN ||
                   socket.readyState === WebSocket.CONNECTING)) return;

    updateStatus('connecting');
    socket = new WebSocket(WS_URL);

    socket.onopen = () => {
      console.log('[DerivAPI] Connected');
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
      console.warn('[DerivAPI] Disconnected');
      isAuthorized = false;
      updateStatus('disconnected');
      stopPing();
      emit('close', {});
      attemptReconnect();
    };

    socket.onerror = (err) => console.error('[DerivAPI] WS error:', err);
  };

  // ─── SEND ─────────────────────────────────────────────────────────────────
  const send = (obj) => {
    const msg = JSON.stringify(obj);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(msg);
    } else {
      pendingMsgs.push(msg);
      if (!socket || socket.readyState === WebSocket.CLOSED) connect();
    }
  };

  // ─── MESSAGE ROUTER ───────────────────────────────────────────────────────
  const handleMessage = (data) => {
    if (data.error) {
      emit('error', {
        type    : data.msg_type || 'general',
        message : data.error.message,
        code    : data.error.code,
      });
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
        emit('tick', {
          symbol : data.tick.symbol,
          quote  : data.tick.quote,
          epoch  : data.tick.epoch,
        });
        break;

      case 'history':
        emit('history', {
          prices : data.history ? data.history.prices : [],
          times  : data.history ? data.history.times  : [],
        });
        break;

      case 'proposal':
        if (data.proposal) {
          emit('proposal', {
            id        : data.proposal.id,
            ask_price : data.proposal.ask_price,
            payout    : data.proposal.payout,
            longcode  : data.proposal.longcode,
          });
        }
        break;

      case 'buy':
        if (data.buy) {
          emit('buy', {
            contract_id : data.buy.contract_id,
            buy_price   : data.buy.buy_price,
            payout      : data.buy.payout,
            shortcode   : data.buy.shortcode,
          });
        }
        break;

      case 'balance':
        if (data.balance) {
          emit('balance', {
            balance  : data.balance.balance,
            currency : data.balance.currency,
          });
        }
        break;

      case 'proposal_open_contract':
        if (data.proposal_open_contract) {
          emit('contract_update', data.proposal_open_contract);
        }
        break;

      case 'ping':
        break;

      default:
        break;
    }
  };

  // ─── AUTH ─────────────────────────────────────────────────────────────────
  const authorize = (token) => send({ authorize: token });

  // ─── TRADING METHODS ──────────────────────────────────────────────────────
  const subscribeTicks = (symbol) => send({ ticks: symbol, subscribe: 1 });

  const unsubscribeTicks = () => send({ forget_all: 'ticks' });

  const getTickHistory = (symbol, count = 500) => send({
    ticks_history     : symbol,
    count,
    end               : 'latest',
    style             : 'ticks',
    adjust_start_time : 1,
  });

  const getProposal = ({ symbol, contractType, duration, durationUnit, stake, barrier }) => {
    const req = {
      proposal          : 1,
      subscribe         : 1,
      amount            : stake,
      basis             : 'stake',
      contract_type     : contractType,
      currency          : localStorage.getItem('zalo_currency') || 'USD',
      duration          : duration || 1,
      duration_unit     : durationUnit || 't',
      symbol            : symbol,
    };
    if (barrier !== undefined && barrier !== null && barrier !== '') {
      req.barrier = String(barrier);
    }
    send(req);
  };

  const buyContract      = (id, price) => send({ buy: id, price });
  const subscribeBalance = ()           => send({ balance: 1, subscribe: 1 });
  const subscribeOpenContracts = ()     => send({ proposal_open_contract: 1, subscribe: 1 });

  // ─── PING / RECONNECT ─────────────────────────────────────────────────────
  const startPing = () => {
    stopPing();
    pingInterval = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) send({ ping: 1 });
    }, 30000);
  };

  const stopPing = () => {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  };

  const attemptReconnect = () => {
    if (reconnectCount >= maxReconnects) return;
    reconnectCount++;
    const delay = reconnectCount * 3000;
    console.log(`[DerivAPI] Reconnecting in ${delay/1000}s (attempt ${reconnectCount})`);
    setTimeout(() => {
      connect();
      // Re-authorize after reconnect if token exists
      const token = localStorage.getItem('zalo_api_token');
      if (token) {
        const waitOpen = setInterval(() => {
          if (socket && socket.readyState === WebSocket.OPEN) {
            authorize(token);
            clearInterval(waitOpen);
          }
        }, 300);
      }
    }, delay);
  };

  const disconnect = () => {
    if (socket) { socket.onclose = null; socket.close(); socket = null; }
    stopPing();
    isAuthorized = false;
    updateStatus('disconnected');
  };

  // ─── STATUS UI ────────────────────────────────────────────────────────────
  const updateStatus = (state) => {
    const dot  = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (!dot || !text) return;
    const map = {
      connecting   : { cls: 'connecting',  label: 'Connecting...' },
      connected    : { cls: 'connected',   label: 'Connected'     },
      authorized   : { cls: 'authorized',  label: 'Authorized'    },
      disconnected : { cls: '',            label: 'Disconnected'  },
    };
    const s = map[state] || map.disconnected;
    dot.className    = s.cls;
    text.textContent = s.label;
  };

  // ─── PUBLIC ───────────────────────────────────────────────────────────────
  return {
    connect, disconnect, send, authorize,
    subscribeTicks, unsubscribeTicks,
    getTickHistory, getProposal,
    buyContract, subscribeBalance, subscribeOpenContracts,
    on,
  };

})();
