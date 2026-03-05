/**
 * ZALO ORACLE PRO
 * FILE: js/deriv-api.js
 *
 * NEW DERIV API ARCHITECTURE (2025):
 * ─────────────────────────────────
 * Step 1: OAuth 2.0 → user authorizes → we get JWT access_token
 * Step 2: REST GET  → /trading/v1/options/accounts (get account ID)
 * Step 3: REST POST → /trading/v1/options/accounts/{id}/otp (get WS URL)
 * Step 4: WebSocket → connect to URL from step 3 (already authenticated)
 * Step 5: Trade     → send JSON commands over the WS
 *
 * WebSocket endpoints:
 *   Public  (no auth): wss://api.derivws.com/trading/v1/options/ws/public
 *   Demo    (OTP auth): wss://api.derivws.com/trading/v1/options/ws/demo?otp=XXX
 *   Real    (OTP auth): wss://api.derivws.com/trading/v1/options/ws/real?otp=XXX
 *
 * REST base: https://api.derivws.com
 * OAuth URL: https://auth.deriv.com/oauth2/auth
 */

const DerivAPI = (() => {

  // ─── APP CONFIG (set your App ID after registering at developers.deriv.com) ──
  const APP_ID       = '32COjmsrXXrZr4vCRX7dE';   // ← PASTE YOUR APP ID HERE after registration
  const REDIRECT_URI = window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + 'index.html';
  const REST_BASE    = 'https://api.derivws.com';
  const PUBLIC_WS    = 'wss://api.derivws.com/trading/v1/options/ws/public';

  // ─── STATE ────────────────────────────────────────────────────────────────
  let socket        = null;
  let wsUrl         = null;        // Authenticated WS URL from OTP step
  let accessToken   = null;        // JWT from OAuth
  let accountId     = null;        // Deriv account ID e.g. "DOT90004580"
  let accountInfo   = null;        // Full account object
  let reconnectCount= 0;
  let maxReconnects = 5;
  let pingInterval  = null;
  let isConnected   = false;
  let pendingMsgs   = [];

  // ─── EVENT HANDLERS ───────────────────────────────────────────────────────
  const handlers = {};

  const on = (event, fn) => {
    if (!handlers[event]) handlers[event] = [];
    handlers[event].push(fn);
  };

  const emit = (event, data) => {
    (handlers[event] || []).forEach(fn => {
      try { fn(data); } catch(e) { console.error(`[DerivAPI] Handler error (${event}):`, e); }
    });
  };

  // =========================================================================
  // SECTION 1 — OAUTH 2.0 FLOW
  // =========================================================================

  /**
   * Step 1a: Generate PKCE code verifier + challenge
   */
  const generatePKCE = async () => {
    const array    = new Uint8Array(32);
    crypto.getRandomValues(array);
    const verifier = btoa(String.fromCharCode(...array))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const encoder   = new TextEncoder();
    const data      = encoder.encode(verifier);
    const digest    = await crypto.subtle.digest('SHA-256', data);
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    return { verifier, challenge };
  };

  /**
   * Step 1b: Redirect user to Deriv OAuth page
   * Called when user clicks "Login with Deriv"
   */
  const redirectToOAuth = async () => {
    if (!APP_ID) {
      alert('App ID not set. Please register at developers.deriv.com and add your App ID to js/deriv-api.js line 27.');
      return;
    }

    const { verifier, challenge } = await generatePKCE();
    const state = crypto.randomUUID();

    // Save PKCE + state for callback verification
    sessionStorage.setItem('zalo_pkce_verifier', verifier);
    sessionStorage.setItem('zalo_oauth_state',   state);

    const url = new URL('https://auth.deriv.com/oauth2/auth');
    url.searchParams.set('response_type',          'code');
    url.searchParams.set('client_id',              APP_ID);
    url.searchParams.set('redirect_uri',           REDIRECT_URI);
    url.searchParams.set('scope',                  'openid');
    url.searchParams.set('state',                  state);
    url.searchParams.set('code_challenge',         challenge);
    url.searchParams.set('code_challenge_method',  'S256');

    window.location.href = url.toString();
  };

  /**
   * Step 1c: Handle OAuth callback
   * Deriv redirects to: index.html?code=AUTH_CODE&state=STATE
   * Returns { code, state } or null
   */
  const parseOAuthCallback = () => {
    const params = new URLSearchParams(window.location.search);
    const code   = params.get('code');
    const state  = params.get('state');
    if (!code) return null;
    return { code, state };
  };

  /**
   * Step 1d: Exchange authorization code for access token
   */
  const exchangeCodeForToken = async (code) => {
    const verifier = sessionStorage.getItem('zalo_pkce_verifier');
    const savedState = sessionStorage.getItem('zalo_oauth_state');

    // Clean up session storage
    sessionStorage.removeItem('zalo_pkce_verifier');
    sessionStorage.removeItem('zalo_oauth_state');

    const body = new URLSearchParams({
      grant_type   : 'authorization_code',
      client_id    : APP_ID,
      code,
      redirect_uri : REDIRECT_URI,
      code_verifier: verifier,
    });

    const res = await fetch('https://auth.deriv.com/oauth2/token', {
      method  : 'POST',
      headers : { 'Content-Type': 'application/x-www-form-urlencoded' },
      body    : body.toString(),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error_description || `Token exchange failed: ${res.status}`);
    }

    const data   = await res.json();
    accessToken  = data.access_token;
    localStorage.setItem('zalo_jwt',         accessToken);
    localStorage.setItem('zalo_jwt_expires', Date.now() + (data.expires_in * 1000));
    return accessToken;
  };

  // =========================================================================
  // SECTION 2 — REST API CALLS (with JWT bearer token)
  // =========================================================================

  /**
   * Base REST fetch helper — adds required headers
   */
  const restFetch = async (path, method = 'GET', body = null) => {
    const token = accessToken || localStorage.getItem('zalo_jwt');
    if (!token) throw new Error('No access token. Please login.');

    const opts = {
      method,
      headers: {
        'Authorization' : `Bearer ${token}`,
        'Deriv-App-ID'  : APP_ID,
        'Content-Type'  : 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res  = await fetch(`${REST_BASE}${path}`, opts);
    const data = await res.json();

    if (!res.ok) {
      const msg = data?.errors?.[0]?.message || `REST error ${res.status}`;
      throw new Error(msg);
    }
    return data;
  };

  /**
   * Step 2a: Get all Options trading accounts
   */
  const getAccounts = async () => {
    const data = await restFetch('/trading/v1/options/accounts');
    return data.data || [];
  };

  /**
   * Step 2b: Create a demo account (if none exists)
   */
  const createDemoAccount = async () => {
    const data = await restFetch('/trading/v1/options/accounts', 'POST', {
      currency     : 'USD',
      group        : 'row',
      account_type : 'demo',
    });
    return data.data;
  };

  /**
   * Step 2c: Get OTP → returns authenticated WebSocket URL
   */
  const getOTPWebSocketUrl = async (accId) => {
    const data = await restFetch(
      `/trading/v1/options/accounts/${accId}/otp`,
      'POST'
    );
    // data.data.url = "wss://api.derivws.com/trading/v1/options/ws/demo?otp=xxx"
    return data.data.url;
  };

  // =========================================================================
  // SECTION 3 — FULL LOGIN FLOW (OAuth → REST → WebSocket)
  // =========================================================================

  /**
   * Called after OAuth callback — runs the full setup:
   * exchange code → get accounts → get OTP URL → connect WS
   */
  const completeLogin = async (code) => {
    try {
      updateStatus('connecting');

      // 1. Exchange code for JWT
      await exchangeCodeForToken(code);
      console.log('[DerivAPI] ✔ JWT obtained');

      // 2. Get accounts
      let accounts = await getAccounts();
      console.log('[DerivAPI] ✔ Accounts:', accounts);

      // 3. If no accounts, create demo
      if (!accounts || accounts.length === 0) {
        console.log('[DerivAPI] No accounts found — creating demo account...');
        await createDemoAccount();
        accounts = await getAccounts();
      }

      // 4. Use first account (prefer demo)
      const account = accounts.find(a => a.account_type === 'demo') || accounts[0];
      accountId   = account.account_id;
      accountInfo = account;

      localStorage.setItem('zalo_account_id',   accountId);
      localStorage.setItem('zalo_account_info',  JSON.stringify(account));
      localStorage.setItem('zalo_currency',      account.currency || 'USD');

      console.log(`[DerivAPI] ✔ Using account: ${accountId}`);

      // 5. Get OTP → authenticated WS URL
      wsUrl = await getOTPWebSocketUrl(accountId);
      localStorage.setItem('zalo_ws_url', wsUrl);
      console.log('[DerivAPI] ✔ WS URL obtained');

      // 6. Connect WebSocket
      await connectWebSocket(wsUrl);

      return { account, wsUrl };

    } catch(err) {
      console.error('[DerivAPI] Login failed:', err);
      updateStatus('disconnected');
      throw err;
    }
  };

  /**
   * Restore session — called on dashboard pages
   * Uses stored JWT + account to reconnect without OAuth
   */
  const restoreSession = async () => {
    const jwt    = localStorage.getItem('zalo_jwt');
    const accId  = localStorage.getItem('zalo_account_id');
    const acc    = localStorage.getItem('zalo_account_info');
    const storedWsUrl = localStorage.getItem('zalo_ws_url');

    if (!jwt || !accId) {
      throw new Error('No session found');
    }

    accessToken = jwt;
    accountId   = accId;
    accountInfo = acc ? JSON.parse(acc) : null;

    updateStatus('connecting');

    try {
      // Get a fresh OTP URL (OTPs expire, always get a new one)
      wsUrl = await getOTPWebSocketUrl(accountId);
      localStorage.setItem('zalo_ws_url', wsUrl);
      await connectWebSocket(wsUrl);
    } catch(err) {
      // If OTP call fails (expired JWT), fall back to public WS for ticks only
      console.warn('[DerivAPI] OTP failed, falling back to public WS:', err);
      await connectWebSocket(PUBLIC_WS);
    }
  };

  // =========================================================================
  // SECTION 4 — WEBSOCKET CONNECTION
  // =========================================================================

  const connectWebSocket = (url) => {
    return new Promise((resolve, reject) => {
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        resolve();
        return;
      }

      socket = new WebSocket(url);

      socket.onopen = () => {
        isConnected    = true;
        reconnectCount = 0;
        updateStatus('connected');
        startPing();

        // Flush pending messages
        while (pendingMsgs.length > 0) {
          socket.send(pendingMsgs.shift());
        }

        emit('open', {});

        // If we used authenticated URL, emit authorized immediately
        if (url !== PUBLIC_WS) {
          updateStatus('authorized');
          if (accountInfo) {
            emit('authorize',  accountInfo);
            emit('authorized', accountInfo);
          }
        }

        resolve();
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleMessage(data);
        } catch(e) {
          console.error('[DerivAPI] Parse error:', e);
        }
      };

      socket.onclose = () => {
        isConnected = false;
        updateStatus('disconnected');
        stopPing();
        emit('close', {});
        attemptReconnect();
      };

      socket.onerror = (err) => {
        console.error('[DerivAPI] WS error:', err);
        reject(err);
      };
    });
  };

  // ─── SEND MESSAGE ─────────────────────────────────────────────────────────
  const send = (obj) => {
    const msg = JSON.stringify(obj);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(msg);
    } else {
      pendingMsgs.push(msg);
    }
  };

  // ─── ROUTE INCOMING MESSAGES ──────────────────────────────────────────────
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
        break; // silently ignored

      default:
        break;
    }
  };

  // =========================================================================
  // SECTION 5 — TRADING COMMANDS (WebSocket sends)
  // =========================================================================

  const subscribeTicks = (symbol) => {
    send({ ticks: symbol, subscribe: 1 });
  };

  const unsubscribeTicks = () => {
    send({ forget_all: 'ticks' });
  };

  const getTickHistory = (symbol, count = 500) => {
    send({
      ticks_history     : symbol,
      count,
      end               : 'latest',
      style             : 'ticks',
      adjust_start_time : 1,
    });
  };

  const getProposal = ({ symbol, contractType, duration, durationUnit, stake, barrier }) => {
    const req = {
      proposal           : 1,
      subscribe          : 1,
      amount             : stake,
      basis              : 'stake',
      contract_type      : contractType,
      currency           : localStorage.getItem('zalo_currency') || 'USD',
      duration           : duration || 1,
      duration_unit      : durationUnit || 't',
      underlying_symbol  : symbol,
    };

    if (barrier !== undefined && barrier !== null && barrier !== '') {
      req.barrier = String(barrier);
    }

    send(req);
  };

  const buyContract = (proposalId, price) => {
    send({ buy: proposalId, price });
  };

  const subscribeBalance = () => {
    send({ balance: 1, subscribe: 1 });
  };

  const subscribeOpenContracts = () => {
    send({ proposal_open_contract: 1, subscribe: 1 });
  };

  // ─── PING ─────────────────────────────────────────────────────────────────
  const startPing = () => {
    stopPing();
    pingInterval = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        send({ ping: 1 });
      }
    }, 30000);
  };

  const stopPing = () => {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  };

  // ─── RECONNECT ────────────────────────────────────────────────────────────
  const attemptReconnect = () => {
    if (reconnectCount >= maxReconnects) return;
    reconnectCount++;
    const delay = reconnectCount * 3000;
    console.log(`[DerivAPI] Reconnecting in ${delay/1000}s...`);
    setTimeout(async () => {
      try {
        // Always get fresh OTP on reconnect
        const accId = localStorage.getItem('zalo_account_id');
        if (accId) {
          wsUrl = await getOTPWebSocketUrl(accId);
          await connectWebSocket(wsUrl);
        }
      } catch(e) {
        console.error('[DerivAPI] Reconnect failed:', e);
      }
    }, delay);
  };

  const disconnect = () => {
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
    stopPing();
    isConnected = false;
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

  // ─── GETTERS ──────────────────────────────────────────────────────────────
  const getAccountId   = () => accountId;
  const getAccountInfo = () => accountInfo;
  const getAccessToken = () => accessToken || localStorage.getItem('zalo_jwt');

  // ─── PUBLIC API ───────────────────────────────────────────────────────────
  return {
    // Auth
    redirectToOAuth,
    parseOAuthCallback,
    completeLogin,
    restoreSession,
    disconnect,

    // WebSocket trading
    send,
    subscribeTicks,
    unsubscribeTicks,
    getTickHistory,
    getProposal,
    buyContract,
    subscribeBalance,
    subscribeOpenContracts,

    // REST
    getAccounts,
    createDemoAccount,

    // Events
    on,

    // Getters
    getAccountId,
    getAccountInfo,
    getAccessToken,
    APP_ID,
  };

})();
