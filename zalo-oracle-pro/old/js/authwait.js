/**
 * ZALO ORACLE PRO
 * FILE: js/auth.js
 *
 * Auth flow with new Deriv API:
 * 1. User clicks Login → OAuth redirect
 * 2. Deriv redirects back with ?code=XXX
 * 3. We exchange code for JWT via auth.deriv.com/oauth2/token
 * 4. We call REST /trading/v1/options/accounts to get account ID
 * 5. We call REST /trading/v1/options/accounts/{id}/otp to get WS URL
 * 6. We connect WebSocket using that URL
 * 7. WS is already authenticated — no separate authorize message needed
 */

const Auth = (() => {

  // ─── STORAGE KEYS ─────────────────────────────────────────────────────────
  const K = {
    JWT         : 'zalo_jwt',
    JWT_EXPIRES : 'zalo_jwt_expires',
    ACCOUNT_ID  : 'zalo_account_id',
    ACCOUNT_INFO: 'zalo_account_info',
    CURRENCY    : 'zalo_currency',
    BALANCE     : 'zalo_balance',
    WS_URL      : 'zalo_ws_url',
  };

  // ─── STATE ────────────────────────────────────────────────────────────────
  let onLoginCbs  = [];
  let onLogoutCbs = [];

  // ─── CALLBACKS ────────────────────────────────────────────────────────────
  const onLogin  = (fn) => onLoginCbs.push(fn);
  const onLogout = (fn) => onLogoutCbs.push(fn);

  // ─── SESSION CHECK ────────────────────────────────────────────────────────
  const hasSession = () => {
    const jwt     = localStorage.getItem(K.JWT);
    const expires = parseInt(localStorage.getItem(K.JWT_EXPIRES) || 0);
    const accId   = localStorage.getItem(K.ACCOUNT_ID);
    return !!(jwt && accId && Date.now() < expires);
  };

  // ─── GETTERS ──────────────────────────────────────────────────────────────
  const getToken    = ()  => localStorage.getItem(K.JWT);
  const getCurrency = ()  => localStorage.getItem(K.CURRENCY) || 'USD';
  const getBalance  = ()  => parseFloat(localStorage.getItem(K.BALANCE))  || 0;
  const getAccountId= ()  => localStorage.getItem(K.ACCOUNT_ID);
  const getAccount  = ()  => {
    const s = localStorage.getItem(K.ACCOUNT_INFO);
    return s ? JSON.parse(s) : null;
  };

  // ─── UPDATE BALANCE ───────────────────────────────────────────────────────
  const updateBalance = (amount) => {
    const bal = parseFloat(amount).toFixed(2);
    localStorage.setItem(K.BALANCE, bal);
    const curr = getCurrency();
    document.querySelectorAll('[data-balance]').forEach(el => {
      el.textContent = `${curr} ${bal}`;
    });
  };

  // ─── LOGIN — redirect to Deriv OAuth ──────────────────────────────────────
  const login = () => {
    DerivAPI.redirectToOAuth();
  };

  // ─── HANDLE OAUTH CALLBACK (runs on index.html when ?code= is in URL) ─────
  const handleOAuthCallback = async () => {
    const cb = DerivAPI.parseOAuthCallback();
    if (!cb) return false;

    // Clean URL immediately so token isn't visible
    window.history.replaceState({}, document.title,
      window.location.pathname + window.location.hash);

    try {
      setLoginState('loading', '◌ Authorizing...');

      // Runs: exchange code → get accounts → get OTP → connect WS
      const result = await DerivAPI.completeLogin(cb.code);

      // Save account info
      const acc = result.account;
      localStorage.setItem(K.ACCOUNT_INFO, JSON.stringify(acc));
      localStorage.setItem(K.CURRENCY,     acc.currency || 'USD');
      localStorage.setItem(K.BALANCE,      acc.balance  || 0);

      // Subscribe to balance updates
      DerivAPI.subscribeBalance();

      // Handle live balance updates
      DerivAPI.on('balance', (data) => {
        updateBalance(data.balance);
      });

      setLoginState('success', '✔ Authorized!');

      console.log(`[Auth] ✔ Login complete: ${acc.account_id} | ${acc.balance} ${acc.currency}`);

      onLoginCbs.forEach(fn => fn(acc));

      // Redirect to dashboard
      setTimeout(() => {
        window.location.href = 'dashboard.html';
      }, 1000);

      return true;

    } catch(err) {
      console.error('[Auth] OAuth callback failed:', err);
      setLoginState('error', '✖ Failed — Try Again');
      showError(err.message || 'Authorization failed. Please try again.');
      return false;
    }
  };

  // ─── AUTO LOGIN (dashboard pages) ────────────────────────────────────────
  const autoLogin = () => {
    if (!hasSession()) {
      window.location.href = 'index.html';
      return;
    }

    // Restore account info from storage immediately (for UI)
    const acc  = getAccount();
    const curr = getCurrency();
    const bal  = getBalance();

    if (acc) {
      document.querySelectorAll('[data-loginid]').forEach(el => { el.textContent = acc.account_id || '--'; });
      document.querySelectorAll('[data-currency]').forEach(el => { el.textContent = curr; });
      document.querySelectorAll('[data-balance]').forEach(el => { el.textContent = `${curr} ${parseFloat(bal).toFixed(2)}`; });
    }

    // Connect fresh WS (get new OTP since OTPs expire)
    DerivAPI.restoreSession()
      .then(() => {
        // Subscribe to live balance
        DerivAPI.subscribeBalance();

        DerivAPI.on('balance', (data) => {
          updateBalance(data.balance);
        });

        onLoginCbs.forEach(fn => fn(acc || {}));
      })
      .catch(err => {
        console.error('[Auth] Auto-login failed:', err);
        // If JWT expired, force re-login
        if (err.message && err.message.includes('401')) {
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

  // ─── CLEAR SESSION ────────────────────────────────────────────────────────
  const clearSession = () => {
    Object.values(K).forEach(k => localStorage.removeItem(k));
  };

  // ─── LOGIN PAGE UI HELPERS ────────────────────────────────────────────────
  const setLoginState = (state, text) => {
    const btn = document.getElementById('login-btn');
    if (!btn) return;

    btn.textContent = text;
    btn.className   = `btn btn-primary btn-full btn-lg ${state}`;
    btn.disabled    = (state === 'loading' || state === 'success');
  };

  const showError = (msg) => {
    const el = document.getElementById('login-error');
    if (!el) return;
    el.textContent   = '⚠ ' + msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 8000);
  };

  const hideLoading = () => {
    const el = document.getElementById('auth-loading');
    if (el) el.style.display = 'none';
    const btn = document.getElementById('login-btn');
    if (btn) btn.style.display = '';
  };

  // ─── PUBLIC API ───────────────────────────────────────────────────────────
  return {
    login,
    autoLogin,
    logout,
    handleOAuthCallback,
    hasSession,
    getToken,
    getAccount,
    getAccountId,
    getCurrency,
    getBalance,
    updateBalance,
    onLogin,
    onLogout,
    showError,
    setLoginState,
    hideLoading,
  };

})();
