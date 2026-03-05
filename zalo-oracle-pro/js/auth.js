/**
 * ZALO ORACLE PRO
 * FILE: js/auth.js
 * MODE: API Token paste — user gets token from app.deriv.com/account/api-token
 */

const Auth = (() => {

  const K = {
    TOKEN    : 'zalo_api_token',
    ACCOUNT  : 'zalo_account',
    CURRENCY : 'zalo_currency',
    BALANCE  : 'zalo_balance',
    LOGIN_ID : 'zalo_loginid',
  };

  let onLoginCbs  = [];
  let onLogoutCbs = [];

  // ─── CALLBACKS ────────────────────────────────────────────────────────────
  const onLogin  = (fn) => onLoginCbs.push(fn);
  const onLogout = (fn) => onLogoutCbs.push(fn);

  // ─── GETTERS ──────────────────────────────────────────────────────────────
  const getToken    = ()  => localStorage.getItem(K.TOKEN);
  const hasSession  = ()  => !!getToken();
  const getCurrency = ()  => localStorage.getItem(K.CURRENCY) || 'USD';
  const getBalance  = ()  => parseFloat(localStorage.getItem(K.BALANCE)) || 0;
  const getLoginId  = ()  => localStorage.getItem(K.LOGIN_ID) || '';
  const getAccount  = ()  => {
    const s = localStorage.getItem(K.ACCOUNT);
    return s ? JSON.parse(s) : null;
  };

  // ─── UPDATE BALANCE EVERYWHERE ────────────────────────────────────────────
  const updateBalance = (amount) => {
    const bal  = parseFloat(amount).toFixed(2);
    const curr = getCurrency();
    localStorage.setItem(K.BALANCE, bal);
    document.querySelectorAll('[data-balance]').forEach(el => {
      el.textContent = `${curr} ${bal}`;
    });
  };

  // ─── LOGIN — called by login button on index.html ─────────────────────────
  const login = () => {
    const tokenInput = document.getElementById('api-token-input');
    const token      = tokenInput ? tokenInput.value.trim() : '';

    if (!token) {
      showError('Please enter your API token');
      return;
    }

    setLoginState('loading');

    // Connect WebSocket then authorize
    DerivAPI.connect();

    DerivAPI.on('open', () => {
      DerivAPI.authorize(token);
    });

    DerivAPI.on('authorize', (data) => {
      // Save session
      localStorage.setItem(K.TOKEN,    token);
      localStorage.setItem(K.ACCOUNT,  JSON.stringify(data));
      localStorage.setItem(K.CURRENCY, data.currency || 'USD');
      localStorage.setItem(K.LOGIN_ID, data.loginid  || '');
      localStorage.setItem(K.BALANCE,  data.balance  || 0);

      DerivAPI.subscribeBalance();

      setLoginState('success');
      console.log(`[Auth] ✔ Login: ${data.loginid} | ${data.balance} ${data.currency}`);

      onLoginCbs.forEach(fn => fn(data));

      setTimeout(() => {
        window.location.href = 'dashboard.html';
      }, 800);
    });

    DerivAPI.on('error', (err) => {
      if (err.type === 'authorize' || err.code === 'InvalidToken' || err.code === 'AuthorizationRequired') {
        setLoginState('error');
        showError('Invalid token. Get yours from app.deriv.com → Account Settings → API Token');
      }
    });
  };

  // ─── AUTO LOGIN (used on dashboard/analysis/etc pages) ────────────────────
  const autoLogin = () => {
    const token = getToken();
    if (!token) {
      window.location.href = 'index.html';
      return;
    }

    // Restore stored values immediately for instant UI
    const acc  = getAccount();
    const curr = getCurrency();
    const bal  = getBalance();

    if (acc) {
      document.querySelectorAll('[data-loginid]').forEach(el => { el.textContent = acc.loginid  || '--'; });
      document.querySelectorAll('[data-currency]').forEach(el => { el.textContent = curr; });
    }
    document.querySelectorAll('[data-balance]').forEach(el => {
      el.textContent = `${curr} ${parseFloat(bal).toFixed(2)}`;
    });

    // Connect fresh WS
    DerivAPI.connect();

    DerivAPI.on('open', () => DerivAPI.authorize(token));

    DerivAPI.on('authorize', (data) => {
      // Refresh stored data
      localStorage.setItem(K.ACCOUNT,  JSON.stringify(data));
      localStorage.setItem(K.CURRENCY, data.currency || 'USD');
      localStorage.setItem(K.BALANCE,  data.balance  || 0);
      localStorage.setItem(K.LOGIN_ID, data.loginid  || '');

      updateBalance(data.balance);

      document.querySelectorAll('[data-loginid]').forEach(el => { el.textContent = data.loginid  || '--'; });
      document.querySelectorAll('[data-currency]').forEach(el => { el.textContent = data.currency || '--'; });

      DerivAPI.subscribeBalance();

      onLoginCbs.forEach(fn => fn(data));
    });

    DerivAPI.on('balance', (data) => updateBalance(data.balance));

    DerivAPI.on('error', (err) => {
      if (err.type === 'authorize') {
        clearSession();
        window.location.href = 'index.html';
      }
    });
  };

  // ─── LOGOUT ───────────────────────────────────────────────────────────────
  const logout = () => {
    clearSession();
    DerivAPI.disconnect();
    onLogoutCbs.forEach(fn => fn());
    window.location.href = 'index.html';
  };

  const clearSession = () => Object.values(K).forEach(k => localStorage.removeItem(k));

  // ─── LOGIN PAGE UI ────────────────────────────────────────────────────────
  const setLoginState = (state) => {
    const btn = document.getElementById('login-btn');
    if (!btn) return;
    const map = {
      idle    : { text: '🔐 Connect Account', disabled: false, cls: ''        },
      loading : { text: '◌ Connecting...',     disabled: true,  cls: 'loading' },
      success : { text: '✔ Connected!',         disabled: true,  cls: 'success' },
      error   : { text: '✖ Try Again',          disabled: false, cls: 'error'   },
    };
    const s = map[state] || map.idle;
    btn.textContent = s.text;
    btn.disabled    = s.disabled;
    btn.className   = `btn btn-primary btn-full btn-lg ${s.cls}`;
  };

  const showError = (msg) => {
    const el = document.getElementById('login-error');
    if (!el) return;
    el.textContent   = '⚠ ' + msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 8000);
  };

  // ─── PUBLIC ───────────────────────────────────────────────────────────────
  return {
    login, autoLogin, logout,
    hasSession, getToken, getAccount, getCurrency,
    getBalance, getLoginId, updateBalance,
    onLogin, onLogout,
  };

})();
