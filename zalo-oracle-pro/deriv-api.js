/**
 * ZALO ORACLE PRO
 * FILE: js/deriv-api.js
 * API: Deriv WebSocket v3 — wss://ws.derivws.com/websockets/v3
 *
 * CORRECT TRADING FLOW:
 *   1. connect()
 *   2. authorize(token)          → 'authorize' event
 *   3. getProposal(params)       → 'proposal' event  (has proposal.id)
 *   4. buyContract(id, price)    → 'buy' event       (has contract_id)
 *   5. subscribeOpenContract(id) → 'contract_update' events
 *                                   when is_sold=1   → 'contract_settled' event
 *                                   profit > 0 = WIN, profit <= 0 = LOSS
 */

const DerivAPI = (() => {

  const APP_ID = '32COjmsrXXrZr4vCRX7dE';
  const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

  let socket         = null;
  let reconnectCount = 0;
  let pingInterval   = null;
  let isAuthorized   = false;
  let pendingQueue   = [];
  let reqId          = 1;

  const handlers = {};

  const on = (event, fn) => {
    if (!handlers[event]) handlers[event] = [];
    if (!handlers[event].includes(fn)) handlers[event].push(fn);
  };

  const off = (event, fn) => {
    if (!handlers[event]) return;
    handlers[event] = handlers[event].filter(f => f !== fn);
  };

  const emit = (event, data) => {
    (handlers[event] || []).forEach(fn => {
      try { fn(data); } catch(e) { console.error(`[API] handler error (${event}):`, e); }
    });
  };

  // ── CONNECT ─────────────────────────────────────────────────────────────
  const connect = () => {
    if (socket && (socket.readyState === WebSocket.OPEN ||
                   socket.readyState === WebSocket.CONNECTING)) return;

    updateStatus('connecting');
    socket = new WebSocket(WS_URL);

    socket.onopen = () => {
      console.log('[API] Connected ✔');
      reconnectCount = 0;
      updateStatus('connected');
      startPing();
      const q = [...pendingQueue];
      pendingQueue = [];
      q.forEach(m => socket.send(m));
      emit('open', {});
    };

    socket.onmessage = (e) => {
      try { route(JSON.parse(e.data)); }
      catch(err) { console.error('[API] parse error:', err); }
    };

    socket.onclose = (e) => {
      isAuthorized = false;
      updateStatus('disconnected');
      stopPing();
      emit('close', {});
      if (e.code !== 1000) reconnect();
    };

    socket.onerror = () => {};
  };

  // ── SEND ────────────────────────────────────────────────────────────────
  const send = (obj) => {
    if (!obj.req_id) obj.req_id = reqId++;
    const msg = JSON.stringify(obj);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(msg);
    } else {
      pendingQueue.push(msg);
      if (!socket || socket.readyState > WebSocket.OPEN) connect();
    }
    return obj.req_id;
  };

  // ── MESSAGE ROUTER ──────────────────────────────────────────────────────
  const route = (data) => {
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
          prices : data.history?.prices || [],
          times  : data.history?.times  || [],
        });
        break;

      case 'proposal':
        if (data.proposal) emit('proposal', {
          id        : data.proposal.id,
          ask_price : data.proposal.ask_price,
          payout    : data.proposal.payout,
          longcode  : data.proposal.longcode,
        });
        break;

      case 'buy':
        if (data.buy) emit('buy', {
          contract_id   : data.buy.contract_id,
          buy_price     : data.buy.buy_price,
          payout        : data.buy.payout,
          balance_after : data.buy.balance_after,
          transaction_id: data.buy.transaction_id,
        });
        break;

      case 'sell':
        emit('sell', data.sell || {});
        break;

      case 'balance':
        if (data.balance) emit('balance', {
          balance  : data.balance.balance,
          currency : data.balance.currency,
        });
        break;

      // ── THE CRITICAL ONE: contract result ─────────────────────────────
      case 'proposal_open_contract': {
        const c = data.proposal_open_contract;
        if (!c) break;

        emit('contract_update', c);

        // is_sold = 1 means the contract has settled — we now know win/loss
        if (c.is_sold === 1) {
          const profit  = parseFloat(c.profit || 0);
          const isWon   = profit > 0;
          const lastDigit = c.exit_tick_display_value
            ? parseInt(String(c.exit_tick_display_value).slice(-1))
            : null;

          emit('contract_settled', {
            contract_id : c.contract_id,
            profit      : profit,
            buy_price   : parseFloat(c.buy_price || 0),
            payout      : parseFloat(c.payout || 0),
            is_won      : isWon,
            digit       : lastDigit,
            status      : c.status,
          });
        }
        break;
      }

      case 'transaction':
        emit('transaction', data.transaction);
        break;

      case 'ping':
        break; // Just a keepalive response

      default:
        emit(data.msg_type, data);
        break;
    }
  };

  // ── AUTH ────────────────────────────────────────────────────────────────
  const authorize = (token) => send({ authorize: token });

  // ── TICKS ───────────────────────────────────────────────────────────────
  const subscribeTicks   = (symbol)       => send({ ticks: symbol, subscribe: 1 });
  const unsubscribeTicks = ()             => send({ forget_all: 'ticks' });
  const getTickHistory   = (symbol, n=500)=> send({
    ticks_history: symbol, count: n, end: 'latest', style: 'ticks', adjust_start_time: 1,
  });

  // ── TRADING ─────────────────────────────────────────────────────────────
  /**
   * Step 1: Get proposal → fires 'proposal' event with id + ask_price
   */
  const getProposal = ({ symbol, contractType, duration, durationUnit, stake, barrier }) => {
    const req = {
      proposal      : 1,
      amount        : parseFloat(stake),
      basis         : 'stake',
      contract_type : contractType,
      currency      : localStorage.getItem('zalo_currency') || 'USD',
      duration      : parseInt(duration) || 1,
      duration_unit : durationUnit || 't',
      symbol        : symbol,
    };
    if (barrier !== undefined && barrier !== null && barrier !== '') {
      req.barrier = String(barrier);
    }
    return send(req);
  };

  /**
   * Step 2: Buy contract using proposal id → fires 'buy' event with contract_id
   */
  const buyContract = (proposalId, price) => send({
    buy   : String(proposalId),
    price : parseFloat(price),
  });

  /**
   * Step 3: Subscribe to the open contract → fires 'contract_settled' when done
   * This is the ONLY reliable way to know win/loss
   */
  const subscribeOpenContract = (contractId) => send({
    proposal_open_contract : 1,
    contract_id            : contractId,
    subscribe              : 1,
  });

  const forget    = (id)   => send({ forget: id });
  const forgetAll = (type) => send({ forget_all: type });

  // ── ACCOUNT ─────────────────────────────────────────────────────────────
  const subscribeBalance = () => send({ balance: 1, subscribe: 1 });
  const getPortfolio     = () => send({ portfolio: 1 });
  const getProfitTable   = (limit=25) => send({ profit_table:1, description:1, limit, offset:0 });
  const getStatement     = (limit=50) => send({ statement:1, description:1, limit });

  // ── PING / RECONNECT ────────────────────────────────────────────────────
  const startPing = () => {
    stopPing();
    pingInterval = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) send({ ping: 1 });
    }, 25000);
  };
  const stopPing = () => { if (pingInterval) { clearInterval(pingInterval); pingInterval = null; } };

  const reconnect = () => {
    if (reconnectCount >= 10) return;
    reconnectCount++;
    const delay = Math.min(reconnectCount * 2000, 15000);
    setTimeout(() => {
      connect();
      const token = localStorage.getItem('zalo_api_token');
      if (token) {
        const t = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            clearInterval(t);
            authorize(token);
          }
        }, 200);
      }
    }, delay);
  };

  const disconnect = () => {
    if (socket) { socket.onclose = null; socket.close(1000); socket = null; }
    stopPing();
    isAuthorized = false;
    updateStatus('disconnected');
  };

  // ── STATUS UI ───────────────────────────────────────────────────────────
  const updateStatus = (state) => {
    const dot  = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (!dot || !text) return;
    const map = {
      connecting   : { cls:'connecting', label:'Connecting...' },
      connected    : { cls:'connected',  label:'Connected'     },
      authorized   : { cls:'authorized', label:'Authorized'    },
      disconnected : { cls:'',           label:'Disconnected'  },
    };
    const s = map[state] || map.disconnected;
    dot.className = s.cls; text.textContent = s.label;
  };

  return {
    connect, disconnect, send, on, off,
    authorize,
    subscribeTicks, unsubscribeTicks, getTickHistory,
    getProposal, buyContract, subscribeOpenContract,
    forget, forgetAll,
    subscribeBalance, getPortfolio, getProfitTable, getStatement,
    get isAuthorized() { return isAuthorized; },
  };

})();
