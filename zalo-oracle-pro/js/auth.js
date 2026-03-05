/**
 * ZALO ORACLE PRO — auth.js
 * Handles OAuth callback from Deriv and session management
 */

const Auth = (() => {

  const K = {
    TOKEN    : 'zalo_api_token',
    ACCOUNT  : 'zalo_account_info',
    CURRENCY : 'zalo_currency',
    BALANCE  : 'zalo_balance',
    ACCOUNT_ID: 'zalo_account_id',
  };

  let onLoginCbs  = [];
  let onLogoutCbs = [];

  const onLogin  = (fn) => onLoginCbs.push(fn);
  const onLogout = (fn) => onLogoutCbs.push(fn);

  const getToken    = ()  => localStorage.getItem(K.TOKEN);
  const hasSession  = ()  => !!getToken();
  const getCurrency = ()  => localStorage.getItem(K.CURRENCY) || 'USD';
  const getBalance  = ()  => parseFloat(localStorage.getItem(K.BALANCE)) || 0;
  const getLoginId  = ()  => localStorage.getItem(K.ACCOUNT_ID) || '';
  const getAccount  = ()  => {
    const s = localStorage.getItem(K.ACCOUNT);
    return s ? JSON.parse(s) : null;
  };

  const updateBalance = (amount) => {
    const bal  = parseFloat(amount).toFixed(2);
    const curr = getCurrency();
    localStorage.setItem(K.BALANCE, bal);
    document.querySelectorAll('[data-balance]').forEach(el => {
      el.textContent = `${curr} ${bal}`;
    });
  };

  // ── LOGIN: redirect to Deriv OAuth ────────────────────────────────────────
  const login = () => DerivAPI.redirectToOAuth();

  // ── HANDLE OAUTH CALLBACK ─────────────────────────────────────────────────
  // Deriv redirects back with ?acct1=VRTCXXX&token1=a1-XXX&cur1=USD
  const handleOAuthCallback = async () => {
    const accounts = DerivAPI.parseOAuthCallback();
    if (!accounts) return false;

    // Clean URL — remove OAuth params
    window.history.replaceState({}, document.title, window.location.pathname);

    try {
      setLoginState('loading', '◌ Connecting...');

      const result = await DerivAPI.completeLogin(accounts);
      const acc    = result.account;

      localStorage.setItem(K.BALANCE, 0);

      // Subscribe to live balance
      DerivAPI.subscribeBalance();
      DerivAPI.on('balance', (data) => updateBalance(data.balance));

      setLoginState('success', '✔ Connected!');

      // Update UI
      document.querySelectorAll('[data-loginid]').forEach(el => { el.textContent = acc.account || '--'; });
      document.querySelectorAll('[data-currency]').forEach(el => { el.textContent = acc.currency || '--'; });

      onLoginCbs.forEach(fn => fn(acc));

      setTimeout(() => { window.location.href = 'dashboard.html'; }, 800);
      return true;

    } catch(err) {
      console.error('[Auth] Callback failed:', err);
      setLoginState('error', '✖ Failed — Try Again');
      showError(err.message || 'Authorization failed. Please try again.');
      return false;
    }
  };

  // ── AUTO LOGIN (inner pages) ───────────────────────────────────────────────
  const autoLogin = () => {
    const token = getToken();
    if (!token) { window.location.href = 'index.html'; return; }

    // Restore stored values for instant UI
    const acc  = getAccount();
    const curr = getCurrency();
    const bal  = getBalance();

    if (acc) {
      document.querySelectorAll('[data-loginid]').forEach(el => { el.textContent = acc.account || '--'; });
      document.querySelectorAll('[data-currency]').forEach(el => { el.textContent = curr; });
    }
    document.querySelectorAll('[data-balance]').forEach(el => {
      el.textContent = `${curr} ${parseFloat(bal).toFixed(2)}`;
    });

    DerivAPI.restoreSession()
      .then(() => {
        DerivAPI.subscribeBalance();
        DerivAPI.on('balance', (data) => updateBalance(data.balance));
        onLoginCbs.forEach(fn => fn(acc || {}));
      })
      .catch(err => {
        console.error('[Auth] Auto-login failed:', err);
        clearSession();
        window.location.href = 'index.html';
      });
  };

  // ── LOGOUT ────────────────────────────────────────────────────────────────
  const logout = () => {
    clearSession();
    DerivAPI.disconnect();
    onLogoutCbs.forEach(fn => fn());
    window.location.href = 'index.html';
  };

  const clearSession = () => Object.values(K).forEach(k => localStorage.removeItem(k));

  // ── UI HELPERS ────────────────────────────────────────────────────────────
  const setLoginState = (state, text) => {
    const btn = document.getElementById('login-btn');
    if (!btn) return;
    btn.textContent = text;
    btn.disabled    = (state === 'loading' || state === 'success');
    btn.className   = `btn btn-primary btn-full ${state}`;
  };

  const showError = (msg) => {
    const el = document.getElementById('login-error');
    if (!el) return;
    el.textContent   = '⚠ ' + msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 10000);
  };

  return {
    login, autoLogin, logout, handleOAuthCallback,
    hasSession, getToken, getAccount, getCurrency,
    getBalance, getLoginId, updateBalance,
    onLogin, onLogout, showError, setLoginState,
  };

})();
