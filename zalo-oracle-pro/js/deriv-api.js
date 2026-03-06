/**
 * ZALO ORACLE PRO — js/deriv-api.js
 *
 * ═══════════════════════════════════════════════════════════
 * DERIV API v4 — THE CORRECT FULL FLOW (from official docs)
 * ═══════════════════════════════════════════════════════════
 *
 * STEP 1 — OAUTH REDIRECT
 *   → https://oauth.deriv.com/oauth2/authorize?app_id=APP_ID
 *   → Deriv redirects back: ?acct1=VRTC123&token1=a1-xxx&cur1=USD
 *
 * STEP 2 — GET OTP FROM REST API
 *   POST https://api.derivws.com/trading/v1/options/accounts/{accountId}/otp
 *   Header: Authorization: Bearer {oauth_token}
 *   Header: Deriv-App-ID: {APP_ID}
 *   → Returns: { data: { url: "wss://api.derivws.com/...?otp=xxx" } }
 *
 * STEP 3 — CONNECT TO NEW WEBSOCKET
 *   new WebSocket(otpUrl)  ← already authenticated, NO authorize message needed
 *
 * STEP 4 — TRADE
 *   Use "underlying_symbol" (NOT "symbol") in proposal requests
 *   The rest of the WebSocket messages are same structure
 *
 * ═══════════════════════════════════════════════════════════
 * App ID: 32COjmsrXXrZr4vCRX7dE  (alphanumeric — new v4 format)
 * REST Base: https://api.derivws.com
 * ═══════════════════════════════════════════════════════════
 */

const DerivAPI = (() => {

  // ── CONFIG ─────────────────────────────────────────────────────────────────
  const APP_ID   = '32COjmsrXXrZr4vCRX7dE';
  const REST_URL = 'https://api.derivws.com';

  // ── STATE ──────────────────────────────────────────────────────────────────
  let socket      = null;
  let isAuth      = false;
  let pingTimer   = null;
  let retryCount  = 0;
  let reqId       = 1;
  let queue       = [];
  let activeToken = null;   // The OAuth token we're using
  let activeAccId = null;   // The account ID we're connected to

  // ── EVENTS ─────────────────────────────────────────────────────────────────
  const handlers = {};
  const on   = (e, fn) => { if (!handlers[e]) handlers[e] = []; if (!handlers[e].includes(fn)) handlers[e].push(fn); };
  const off  = (e, fn) => { if (handlers[e]) handlers[e] = handlers[e].filter(f => f !== fn); };
  const emit = (e, d)  => (handlers[e]||[]).forEach(fn => { try { fn(d); } catch(ex) { console.error('[API]', e, ex); } });

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1 — OAUTH REDIRECT
  // ═══════════════════════════════════════════════════════════════════════════
  const redirectToOAuth = () => {
    const url = `https://oauth.deriv.com/oauth2/authorize?app_id=${APP_ID}`;
    console.log('[API] → OAuth redirect:', url);
    window.location.href = url;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // PARSE OAUTH CALLBACK
  // Deriv returns: ?acct1=VRTC123&token1=a1-xxx&cur1=USD&acct2=CR456&token2=...
  // ═══════════════════════════════════════════════════════════════════════════
  const parseOAuthCallback = () => {
    const p = new URLSearchParams(window.location.search);
    if (!p.get('token1')) return null;

    const accounts = [];
    let i = 1;
    while (p.get(`token${i}`)) {
      accounts.push({
        loginid  : p.get(`acct${i}`)  || '',
        token    : p.get(`token${i}`),
        currency : (p.get(`cur${i}`) || 'USD').toUpperCase(),
      });
      i++;
    }

    // Clean URL immediately — remove ?acct1=...&token1=... etc
    window.history.replaceState({}, document.title, window.location.pathname);
    return accounts.length ? accounts : null;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2+3 — GET OTP THEN OPEN WEBSOCKET
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Gets OTP from REST API, then opens authenticated WebSocket
   * token: OAuth token from callback
   * accountId: e.g. "VRTC965733" or "CR123456"
   */
  const connectWithOTP = async (token, accountId) => {
    console.log('[API] Getting OTP for account:', accountId);
    updateStatus('connecting');

    const res = await fetch(
      `${REST_URL}/trading/v1/options/accounts/${accountId}/otp`,
      {
        method  : 'POST',
        headers : {
          'Authorization' : `Bearer ${token}`,
          'Deriv-App-ID'  : APP_ID,
        }
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OTP request failed (${res.status}): ${err}`);
    }

    const data  = await res.json();
    const wsUrl = data?.data?.url;
    if (!wsUrl) throw new Error('No WebSocket URL in OTP response');

    console.log('[API] ✔ Got OTP WS URL');
    activeToken = token;
    activeAccId = accountId;

    await openSocket(wsUrl);
    // Connection is already authenticated via OTP — no authorize msg needed
    isAuth = true;
    updateStatus('authorized');
  };

  /**
   * Get list of accounts from REST API
   * Used to find the accountId needed for OTP
   */
  const getAccounts = async (token) => {
    const res = await fetch(
      `${REST_URL}/trading/v1/options/accounts`,
      {
        headers : {
          'Authorization' : `Bearer ${token}`,
          'Deriv-App-ID'  : APP_ID,
        }
      }
    );

    if (!res.ok) throw new Error(`GET accounts failed: ${res.status}`);
    const data = await res.json();
    return data?.data || [];
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // COMPLETE LOGIN — called from index.html after OAuth callback
  // ═══════════════════════════════════════════════════════════════════════════
  const completeLogin = async (oauthAccounts) => {
    // oauthAccounts = [{ loginid, token, currency }, ...]
    // Prefer demo (VRTC) first
    const preferred = oauthAccounts.find(a => a.loginid.toUpperCase().startsWith('VRT'))
                   || oauthAccounts.find(a => a.loginid.toUpperCase().startsWith('CR'))
                   || oauthAccounts[0];

    const token    = preferred.token;
    const loginid  = preferred.loginid;
    const currency = preferred.currency;

    // Save session
    localStorage.setItem('zalo_all_accounts', JSON.stringify(oauthAccounts));
    localStorage.setItem('zalo_api_token',    token);
    localStorage.setItem('zalo_loginid',      loginid);
    localStorage.setItem('zalo_currency',     currency);

    console.log('[API] OAuth accounts:', oauthAccounts.map(a => a.loginid).join(', '));
    console.log('[API] Using:', loginid, currency);

    updateStatus('connecting');

    // Try new v4 flow: REST → OTP → new WS
    try {
      // Get DOT account ID from REST API
      const restAccounts = await getAccounts(token);
      console.log('[API] REST accounts:', restAccounts.map(a => a.account_id).join(', '));

      // Pick demo DOT account if available
      const restAcc = restAccounts.find(a => a.account_type === 'demo') || restAccounts[0];

      if (restAcc) {
        // Save full account info
        localStorage.setItem('zalo_account_info', JSON.stringify({
          ...restAcc,
          loginid,
          currency,
        }));
        localStorage.setItem('zalo_balance', restAcc.balance || 0);

        await connectWithOTP(token, restAcc.account_id);

        // Emit authorize-compatible event for Auth.js listeners
        emit('authorize',  { loginid, currency, balance: restAcc.balance, account_id: restAcc.account_id });
        emit('authorized', { loginid, currency, balance: restAcc.balance, account_id: restAcc.account_id });

      } else {
        // No accounts yet — create one
        console.log('[API] No accounts found, creating demo account...');
        await createDemoAccount(token);
        const newAccounts = await getAccounts(token);
        const newAcc = newAccounts[0];
        if (!newAcc) throw new Error('Could not create demo account');

        localStorage.setItem('zalo_account_info', JSON.stringify({ ...newAcc, loginid, currency }));
        localStorage.setItem('zalo_balance', newAcc.balance || 0);

        await connectWithOTP(token, newAcc.account_id);
        emit('authorize',  { loginid, currency, balance: newAcc.balance });
        emit('authorized', { loginid, currency, balance: newAcc.balance });
      }

    } catch (err) {
      console.error('[API] v4 flow failed:', err.message);
      updateStatus('disconnected');
      throw err;
    }

    return { account: preferred };
  };

  // Create demo account via REST
  const createDemoAccount = async (token) => {
    await fetch(`${REST_URL}/trading/v1/options/accounts`, {
      method  : 'POST',
      headers : {
        'Authorization' : `Bearer ${token}`,
        'Deriv-App-ID'  : APP_ID,
        'Content-Type'  : 'application/json',
      },
      body: JSON.stringify({ currency: 'USD', group: 'row', account_type: 'demo' })
    });
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // RESTORE SESSION — for inner pages (dashboard, analysis, bot)
  // ═══════════════════════════════════════════════════════════════════════════
  const restoreSession = async () => {
    const token = localStorage.getItem('zalo_api_token');
    if (!token) throw new Error('No saved token');

    updateStatus('connecting');

    try {
      const accounts = await getAccounts(token);
      const acc      = accounts.find(a => a.account_type === 'demo') || accounts[0];
      if (!acc) throw new Error('No accounts found on restore');

      await connectWithOTP(token, acc.account_id);

      const loginid  = localStorage.getItem('zalo_loginid')  || '';
      const currency = localStorage.getItem('zalo_currency') || acc.currency || 'USD';
      const balance  = acc.balance || parseFloat(localStorage.getItem('zalo_balance') || 0);

      // Update stored balance
      localStorage.setItem('zalo_balance', balance);

      emit('authorize',  { loginid, currency, balance, account_id: acc.account_id });
      emit('authorized', { loginid, currency, balance, account_id: acc.account_id });

    } catch (err) {
      console.error('[API] restoreSession failed:', err.message);
      updateStatus('disconnected');
      throw err;
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════
  const openSocket = (url) => new Promise((resolve, reject) => {
    if (socket && socket.readyState <= WebSocket.OPEN) {
      socket.onclose = null;
      socket.close();
    }

    socket = new WebSocket(url);
    const timeout = setTimeout(() => reject(new Error('WS connection timeout')), 15000);

    socket.onopen = () => {
      clearTimeout(timeout);
      retryCount = 0;
      updateStatus('connected');
      startPing();
      const q = [...queue]; queue = [];
      q.forEach(m => socket.send(m));
      emit('open', {});
      resolve();
    };

    socket.onmessage = (e) => {
      try { route(JSON.parse(e.data)); }
      catch (ex) { console.error('[API] parse error', ex); }
    };

    socket.onclose = (e) => {
      console.warn('[API] WS closed', e.code, e.reason);
      isAuth = false;
      stopPing();
      updateStatus('disconnected');
      emit('close', {});
      if (e.code !== 1000) scheduleRetry();
    };

    socket.onerror = (e) => {
      clearTimeout(timeout);
      reject(new Error('WebSocket error'));
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGE ROUTER
  // ═══════════════════════════════════════════════════════════════════════════
  const route = (data) => {
    if (data.error) {
      console.warn('[API] Error:', data.error.code, '—', data.error.message);
      emit('error', {
        type    : data.msg_type || 'general',
        code    : data.error.code,
        message : data.error.message,
      });
      return;
    }

    switch (data.msg_type) {

      // Note: new v4 WS connected via OTP doesn't need authorize msg
      // But it still sends an authorize response sometimes — handle it
      case 'authorize':
        isAuth = true;
        updateStatus('authorized');
        if (data.authorize?.balance !== undefined) {
          localStorage.setItem('zalo_balance', data.authorize.balance);
        }
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
          contract_id    : data.buy.contract_id,
          buy_price      : data.buy.buy_price,
          payout         : data.buy.payout,
          balance_after  : data.buy.balance_after,
          transaction_id : data.buy.transaction_id,
        });
        break;

      case 'sell':
        emit('sell', data.sell || {});
        break;

      case 'balance':
        if (data.balance) {
          localStorage.setItem('zalo_balance', data.balance.balance);
          emit('balance', {
            balance  : data.balance.balance,
            currency : data.balance.currency,
          });
        }
        break;

      // THE CRITICAL EVENT — fires when contract settles (win or loss)
      case 'proposal_open_contract': {
        const c = data.proposal_open_contract;
        if (!c) break;
        emit('contract_update', c);

        // is_sold = 1 means the contract has expired and we know the result
        if (c.is_sold === 1) {
          const profit = parseFloat(c.profit || 0);
          emit('contract_settled', {
            contract_id : c.contract_id,
            profit      : profit,
            buy_price   : parseFloat(c.buy_price  || 0),
            payout      : parseFloat(c.payout     || 0),
            is_won      : profit > 0,
            status      : c.status,
            // Last digit of exit tick — used for digit analysis
            digit       : c.exit_tick_display_value
                            ? parseInt(String(c.exit_tick_display_value).slice(-1))
                            : null,
          });
        }
        break;
      }

      case 'transaction':
        emit('transaction', data.transaction);
        break;

      case 'logout':
        isAuth = false;
        emit('logout', {});
        break;

      case 'ping':
        break;

      default:
        emit(data.msg_type, data);
        break;
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // SEND
  // ═══════════════════════════════════════════════════════════════════════════
  const send = (obj) => {
    if (!obj.req_id) obj.req_id = reqId++;
    const msg = JSON.stringify(obj);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(msg);
    } else {
      queue.push(msg);
    }
    return obj.req_id;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // TRADING COMMANDS
  // IMPORTANT: v4 uses "underlying_symbol" not "symbol" in proposal
  // ═══════════════════════════════════════════════════════════════════════════

  const subscribeTicks   = (sym)        => send({ ticks: sym, subscribe: 1 });
  const unsubscribeTicks = ()           => send({ forget_all: 'ticks' });
  const getTickHistory   = (sym, n=500) => send({
    ticks_history     : sym,
    count             : n,
    end               : 'latest',
    style             : 'ticks',
    adjust_start_time : 1,
  });

  /**
   * Get price proposal — note: v4 uses "underlying_symbol" not "symbol"
   */
  const getProposal = ({ symbol, contractType, duration, durationUnit, stake, barrier }) => {
    const req = {
      proposal            : 1,
      amount              : parseFloat(stake),
      basis               : 'stake',
      contract_type       : contractType,
      currency            : localStorage.getItem('zalo_currency') || 'USD',
      duration            : parseInt(duration) || 1,
      duration_unit       : durationUnit || 't',
      underlying_symbol   : symbol,   // ← v4 uses underlying_symbol
    };
    if (barrier !== undefined && barrier !== null && barrier !== '') {
      req.barrier = String(barrier);
    }
    return send(req);
  };

  const buyContract           = (id, price) => send({ buy: String(id), price: parseFloat(price) });
  const subscribeOpenContract = (id)        => send({ proposal_open_contract: 1, contract_id: id, subscribe: 1 });
  const subscribeBalance      = ()          => send({ balance: 1, subscribe: 1 });
  const forget                = (id)        => send({ forget: id });
  const forgetAll             = (type)      => send({ forget_all: type });
  const getPortfolio          = ()          => send({ portfolio: 1 });
  const getProfitTable        = (n=25)      => send({ profit_table: 1, description: 1, limit: n, offset: 0 });
  const getStatement          = (n=50)      => send({ statement: 1, description: 1, limit: n });

  // ═══════════════════════════════════════════════════════════════════════════
  // PING / RETRY / DISCONNECT
  // ═══════════════════════════════════════════════════════════════════════════
  const startPing = () => {
    stopPing();
    pingTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) send({ ping: 1 });
    }, 25000);
  };
  const stopPing = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  };

  const scheduleRetry = () => {
    if (retryCount >= 6) return;
    retryCount++;
    const delay = Math.min(retryCount * 3000, 15000);
    console.log(`[API] Retry ${retryCount} in ${delay/1000}s`);
    setTimeout(() => {
      restoreSession().catch(err => console.warn('[API] Retry failed:', err.message));
    }, delay);
  };

  const disconnect = () => {
    if (socket) { socket.onclose = null; socket.close(1000); socket = null; }
    stopPing();
    isAuth = false;
    activeToken = null;
    activeAccId = null;
    updateStatus('disconnected');
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS UI
  // ═══════════════════════════════════════════════════════════════════════════
  const updateStatus = (state) => {
    const dot  = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (!dot || !text) return;
    const map = {
      connecting   : { cls: 'connecting', label: 'Connecting...' },
      connected    : { cls: 'connected',  label: 'Connected'     },
      authorized   : { cls: 'authorized', label: 'Authorized'    },
      disconnected : { cls: '',           label: 'Disconnected'  },
    };
    const s = map[state] || map.disconnected;
    dot.className    = s.cls;
    text.textContent = s.label;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  return {
    redirectToOAuth,
    parseOAuthCallback,
    completeLogin,
    restoreSession,
    disconnect,
    send, on, off,
    subscribeTicks, unsubscribeTicks, getTickHistory,
    getProposal, buyContract, subscribeOpenContract,
    subscribeBalance, forget, forgetAll,
    getPortfolio, getProfitTable, getStatement,
    get isAuthorized() { return isAuth; },
    get appId()        { return APP_ID; },
  };

})();
