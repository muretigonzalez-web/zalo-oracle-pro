/**
 * ZALO ORACLE PRO
 * FILE: js/deriv-api.js
 * API: Deriv NEW API (2025)
 *
 * CORRECT FLOW:
 *   1. redirectToOAuth()         → user sees "Authorise application" on Deriv
 *   2. Deriv redirects back      → index.html?acct1=XXX&token1=YYY&cur1=USD
 *   3. parseOAuthCallback()      → extract token from URL params
 *   4. REST GET /accounts        → get account ID
 *   5. REST POST /accounts/{id}/otp → get WS URL
 *   6. new WebSocket(wsUrl)      → already authenticated, no authorize msg needed
 *   7. Trade normally
 *
 * NOTE: Deriv redirects back with query params like:
 *   ?acct1=VRTC123456&token1=a1-XXXX&cur1=USD
 * NOT with ?code= (that's a different OAuth flow)
 */

const DerivAPI = (() => {

  const APP_ID       = '32COjmsrXXrZr4vCRX7dE';
  const REST_BASE    = 'https://api.derivws.com';
  const PUBLIC_WS    = 'wss://api.derivws.com/trading/v1/options/ws/public';

  // Build redirect URI dynamically so it works on both localhost and GitHub Pages
  const getRedirectUri = () => {
    const loc = window.location;
    const path = loc.pathname.replace(/\/[^/]*$/, '/');
    return loc.origin + path + 'index.html';
  };

  // ── STATE ─────────────────────────────────────────────────────────────────
  let socket         = null;
  let wsUrl          = null;
  let apiToken       = null;   // Token from Deriv OAuth redirect
  let accountId      = null;
  let accountInfo    = null;
  let reconnectCount = 0;
  let pingInterval   = null;
  let isConnected    = false;
  let pendingMsgs    = [];
  let reqId          = 1;

  // ── EVENTS ────────────────────────────────────────────────────────────────
  const handlers = {};
  const on   = (e, fn) => { if (!handlers[e]) handlers[e] = []; handlers[e].push(fn); };
  const off  = (e, fn) => { if (handlers[e]) handlers[e] = handlers[e].filter(f => f !== fn); };
  const emit = (e, d)  => (handlers[e] || []).forEach(fn => { try { fn(d); } catch(ex) { console.error('[API] handler err:', ex); } });

  // =========================================================================
  // OAUTH — redirect to Deriv login
  // =========================================================================

  const redirectToOAuth = () => {
    const redirectUri = getRedirectUri();
    const url = new URL('https://oauth.deriv.com/oauth2/authorize');
    url.searchParams.set('app_id',        APP_ID);
    url.searchParams.set('redirect_uri',  redirectUri);
    url.searchParams.set('response_type', 'token');
    url.searchParams.set('scope',         'read,trade,payments,admin');
    console.log('[API] Redirecting to OAuth:', url.toString());
    window.location.href = url.toString();
  };

  /**
   * Deriv redirects back with:
   * ?acct1=VRTC123456&token1=a1-XXXX&cur1=USD&acct2=CR123456&token2=a1-YYYY&cur2=USD
   *
   * We parse these and return array of { account, token, currency }
   */
  const parseOAuthCallback = () => {
    const params  = new URLSearchParams(window.location.search);
    const results = [];
    let i = 1;
    while (params.get(`acct${i}`)) {
      results.push({
        account  : params.get(`acct${i}`),
        token    : params.get(`token${i}`),
        currency : params.get(`cur${i}`),
      });
      i++;
    }
    return results.length > 0 ? results : null;
  };

  // =========================================================================
  // COMPLETE LOGIN — after OAuth callback
  // =========================================================================

  const completeLogin = async (accounts) => {
    // accounts = [{ account:'VRTC123', token:'a1-XXX', currency:'USD' }, ...]
    // Prefer demo (VRTC) account, fall back to first
    const preferred = accounts.find(a => a.account.startsWith('VRTC'))
                   || accounts.find(a => a.account.startsWith('CR'))
                   || accounts[0];

    apiToken   = preferred.token;
    accountId  = preferred.account;
    accountInfo = preferred;

    // Save to localStorage
    localStorage.setItem('zalo_api_token',   apiToken);
    localStorage.setItem('zalo_account_id',  accountId);
    localStorage.setItem('zalo_account_info',JSON.stringify(preferred));
    localStorage.setItem('zalo_currency',    preferred.currency || 'USD');

    console.log('[API] ✔ OAuth accounts received:', accounts);
    console.log('[API] Using account:', accountId);

    updateStatus('connecting');

    try {
      // Try new REST API → OTP → WS flow
      await connectViaOTP(apiToken, accountId);
    } catch(err) {
      console.warn('[API] OTP flow failed, falling back to legacy WS:', err.message);
      // Fallback: use old WebSocket API with authorize message
      await connectLegacy(apiToken);
    }

    return { account: preferred };
  };

  // ── NEW API: REST → OTP → WebSocket ──────────────────────────────────────
  const connectViaOTP = async (token, accId) => {
    // Step 1: Get accounts list to confirm account ID
    const accRes = await fetch(`${REST_BASE}/trading/v1/options/accounts`, {
      headers: {
        'Authorization' : `Bearer ${token}`,
        'Deriv-App-ID'  : APP_ID,
      },
    });

    if (!accRes.ok) {
      const txt = await accRes.text();
      throw new Error(`GET /accounts failed: ${accRes.status} — ${txt}`);
    }

    const accData = await accRes.json();
    const accs    = accData.data || [];
    console.log('[API] REST accounts:', accs);

    // If no accounts, create a demo account
    let targetAccount = accs.find(a => a.account_type === 'demo') || accs[0];
    if (!targetAccount) {
      console.log('[API] No accounts found — creating demo...');
      const createRes = await fetch(`${REST_BASE}/trading/v1/options/accounts`, {
        method  : 'POST',
        headers : {
          'Authorization' : `Bearer ${token}`,
          'Deriv-App-ID'  : APP_ID,
          'Content-Type'  : 'application/json',
        },
        body: JSON.stringify({ currency:'USD', group:'row', account_type:'demo' }),
      });
      const createData = await createRes.json();
      targetAccount = createData.data;
    }

    const resolvedId = targetAccount?.account_id || accId;

    // Step 2: Get OTP → WS URL
    const otpRes = await fetch(`${REST_BASE}/trading/v1/options/accounts/${resolvedId}/otp`, {
      method  : 'POST',
      headers : {
        'Authorization' : `Bearer ${token}`,
        'Deriv-App-ID'  : APP_ID,
      },
    });

    if (!otpRes.ok) {
      const txt = await otpRes.text();
      throw new Error(`POST /otp failed: ${otpRes.status} — ${txt}`);
    }

    const otpData = await otpRes.json();
    wsUrl = otpData.data?.url;
    if (!wsUrl) throw new Error('No WS URL in OTP response');

    localStorage.setItem('zalo_ws_url',      wsUrl);
    localStorage.setItem('zalo_account_info', JSON.stringify(targetAccount));
    localStorage.setItem('zalo_currency',     targetAccount?.currency || 'USD');

    console.log('[API] ✔ OTP WS URL:', wsUrl);
    await connectWebSocket(wsUrl, false); // false = no legacy authorize needed
  };

  // ── LEGACY FALLBACK: old wss://ws.derivws.com with authorize message ──────
  const connectLegacy = async (token) => {
    const legacyUrl = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
    console.log('[API] Connecting legacy WS:', legacyUrl);
    await connectWebSocket(legacyUrl, true); // true = send authorize after open

    // Wait for open, then authorize
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Auth timeout')), 15000);
      on('authorized', (data) => {
        clearTimeout(t);
        accountInfo = data;
        localStorage.setItem('zalo_account_info', JSON.stringify(data));
        localStorage.setItem('zalo_currency',     data.currency || 'USD');
        resolve(data);
      });
      on('open', () => {
        send({ authorize: token });
      });
    });
  };

  // ── RESTORE SESSION (dashboard pages) ─────────────────────────────────────
  const restoreSession = async () => {
    const token  = localStorage.getItem('zalo_api_token');
    const accId  = localStorage.getItem('zalo_account_id');
    const storedWsUrl = localStorage.getItem('zalo_ws_url');

    if (!token) throw new Error('No token — login required');

    apiToken  = token;
    accountId = accId;

    updateStatus('connecting');

    try {
      await connectViaOTP(token, accId);
    } catch(err) {
      console.warn('[API] OTP restore failed, legacy fallback:', err.message);
      await connectLegacy(token);
    }
  };

  // =========================================================================
  // WEBSOCKET CONNECTION
  // =========================================================================

  const connectWebSocket = (url, needsAuth = false) => {
    return new Promise((resolve, reject) => {
      if (socket && socket.readyState <= WebSocket.OPEN) {
        resolve(); return;
      }

      socket = new WebSocket(url);

      const openTimer = setTimeout(() => reject(new Error('WS open timeout')), 15000);

      socket.onopen = () => {
        clearTimeout(openTimer);
        isConnected    = true;
        reconnectCount = 0;
        updateStatus(needsAuth ? 'connected' : 'authorized');
        startPing();

        while (pendingMsgs.length > 0) socket.send(pendingMsgs.shift());

        emit('open', {});

        if (!needsAuth) {
          // OTP-authenticated — already authed, emit right away
          emit('authorize',  accountInfo || {});
          emit('authorized', accountInfo || {});
        }

        resolve();
      };

      socket.onmessage = (e) => {
        try { route(JSON.parse(e.data)); } catch(ex) { console.error('[API] parse err:', ex); }
      };

      socket.onclose = () => {
        isConnected = false;
        updateStatus('disconnected');
        stopPing();
        emit('close', {});
        scheduleReconnect();
      };

      socket.onerror = (e) => {
        clearTimeout(openTimer);
        reject(e);
      };
    });
  };

  // ── SEND ──────────────────────────────────────────────────────────────────
  const send = (obj) => {
    if (!obj.req_id) obj.req_id = reqId++;
    const msg = JSON.stringify(obj);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(msg);
    } else {
      pendingMsgs.push(msg);
    }
    return obj.req_id;
  };

  // ── ROUTER ────────────────────────────────────────────────────────────────
  const route = (data) => {
    if (data.error) {
      emit('error', { type: data.msg_type || 'general', message: data.error.message, code: data.error.code });
      return;
    }

    switch (data.msg_type) {
      case 'authorize':
        isConnected = true;
        updateStatus('authorized');
        emit('authorize',  data.authorize);
        emit('authorized', data.authorize);
        break;

      case 'tick':
        emit('tick', { symbol: data.tick.symbol, quote: data.tick.quote, epoch: data.tick.epoch });
        break;

      case 'history':
        emit('history', { prices: data.history?.prices || [], times: data.history?.times || [] });
        break;

      case 'proposal':
        if (data.proposal) emit('proposal', {
          id: data.proposal.id, ask_price: data.proposal.ask_price,
          payout: data.proposal.payout, longcode: data.proposal.longcode,
        });
        break;

      case 'buy':
        if (data.buy) emit('buy', {
          contract_id: data.buy.contract_id, buy_price: data.buy.buy_price,
          payout: data.buy.payout, balance_after: data.buy.balance_after,
          transaction_id: data.buy.transaction_id,
        });
        break;

      case 'balance':
        if (data.balance) emit('balance', { balance: data.balance.balance, currency: data.balance.currency });
        break;

      case 'proposal_open_contract': {
        const c = data.proposal_open_contract;
        if (!c) break;
        emit('contract_update', c);
        if (c.is_sold === 1) {
          const profit = parseFloat(c.profit || 0);
          emit('contract_settled', {
            contract_id: c.contract_id, profit, buy_price: parseFloat(c.buy_price || 0),
            payout: parseFloat(c.payout || 0), is_won: profit > 0,
            digit: c.exit_tick_display_value ? parseInt(String(c.exit_tick_display_value).slice(-1)) : null,
            status: c.status,
          });
        }
        break;
      }

      case 'sell':
        emit('sell', data.sell || {});
        break;

      case 'transaction':
        emit('transaction', data.transaction);
        break;

      case 'ping':
        break;

      default:
        emit(data.msg_type, data);
    }
  };

  // ── TRADING ───────────────────────────────────────────────────────────────
  const subscribeTicks   = (symbol)     => send({ ticks: symbol, subscribe: 1 });
  const unsubscribeTicks = ()           => send({ forget_all: 'ticks' });
  const getTickHistory   = (sym, n=500) => send({ ticks_history: sym, count: n, end: 'latest', style: 'ticks', adjust_start_time: 1 });

  const getProposal = ({ symbol, contractType, duration, durationUnit, stake, barrier }) => {
    const req = {
      proposal: 1, amount: parseFloat(stake), basis: 'stake',
      contract_type: contractType,
      currency: localStorage.getItem('zalo_currency') || 'USD',
      duration: parseInt(duration) || 1, duration_unit: durationUnit || 't',
      underlying_symbol: symbol,
    };
    if (barrier !== undefined && barrier !== null && barrier !== '') req.barrier = String(barrier);
    return send(req);
  };

  const buyContract            = (id, price) => send({ buy: String(id), price: parseFloat(price) });
  const subscribeOpenContract  = (id)        => send({ proposal_open_contract: 1, contract_id: id, subscribe: 1 });
  const subscribeBalance       = ()          => send({ balance: 1, subscribe: 1 });
  const forget                 = (id)        => send({ forget: id });
  const forgetAll              = (type)      => send({ forget_all: type });
  const getPortfolio           = ()          => send({ portfolio: 1 });
  const getProfitTable         = (n=25)      => send({ profit_table: 1, description: 1, limit: n, offset: 0 });
  const getStatement           = (n=50)      => send({ statement: 1, description: 1, limit: n });

  // ── PING / RECONNECT ──────────────────────────────────────────────────────
  const startPing = () => {
    stopPing();
    pingInterval = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) send({ ping: 1 });
    }, 25000);
  };
  const stopPing = () => { if (pingInterval) { clearInterval(pingInterval); pingInterval = null; } };

  const scheduleReconnect = () => {
    if (reconnectCount >= 8) return;
    reconnectCount++;
    const delay = Math.min(reconnectCount * 2500, 15000);
    setTimeout(() => restoreSession().catch(e => console.error('[API] Reconnect fail:', e)), delay);
  };

  const disconnect = () => {
    if (socket) { socket.onclose = null; socket.close(1000); socket = null; }
    stopPing();
    isConnected = false;
    updateStatus('disconnected');
  };

  // ── STATUS UI ─────────────────────────────────────────────────────────────
  const updateStatus = (state) => {
    const dot  = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (!dot || !text) return;
    const map = {
      connecting   : { cls:'connecting',  label:'Connecting...' },
      connected    : { cls:'connected',   label:'Connected'     },
      authorized   : { cls:'authorized',  label:'Authorized'    },
      disconnected : { cls:'',            label:'Disconnected'  },
    };
    const s = map[state] || map.disconnected;
    dot.className    = s.cls;
    text.textContent = s.label;
  };

  return {
    redirectToOAuth, parseOAuthCallback, completeLogin, restoreSession, disconnect,
    send, on, off,
    subscribeTicks, unsubscribeTicks, getTickHistory,
    getProposal, buyContract, subscribeOpenContract,
    subscribeBalance, forget, forgetAll,
    getPortfolio, getProfitTable, getStatement,
    get isAuthorized() { return isConnected; },
  };

})();
