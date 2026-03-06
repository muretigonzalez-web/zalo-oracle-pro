/**
 * ZALO ORACLE PRO — js/auth.js
 * Session management. Works with deriv-api.js v4 flow.
 */

const Auth = (() => {

  const K = {
    TOKEN    : 'zalo_api_token',
    ALL_ACCS : 'zalo_all_accounts',
    ACC_INFO : 'zalo_account_info',
    LOGINID  : 'zalo_loginid',
    CURRENCY : 'zalo_currency',
    BALANCE  : 'zalo_balance',
  };

  // ── GETTERS ─────────────────────────────────────────────────────────────
  const getToken      = ()  => localStorage.getItem(K.TOKEN);
  const hasSession    = ()  => !!getToken();
  const getCurrency   = ()  => localStorage.getItem(K.CURRENCY) || 'USD';
  const getBalance    = ()  => parseFloat(localStorage.getItem(K.BALANCE) || 0);
  const getLoginId    = ()  => localStorage.getItem(K.LOGINID)  || '';
  const getAllAccounts = ()  => {
    try { return JSON.parse(localStorage.getItem(K.ALL_ACCS) || '[]'); }
    catch { return []; }
  };
  const getAccountInfo = () => {
    try { return JSON.parse(localStorage.getItem(K.ACC_INFO) || 'null'); }
    catch { return null; }
  };

  // ── UPDATE BALANCE EVERYWHERE ────────────────────────────────────────────
  const updateBalance = (amount) => {
    const bal  = parseFloat(amount).toFixed(2);
    const curr = getCurrency();
    localStorage.setItem(K.BALANCE, bal);
    document.querySelectorAll('[data-balance]').forEach(el => {
      el.textContent = `${curr} ${bal}`;
    });
  };

  // ── AUTO LOGIN — call on every inner page ─────────────────────────────────
  // Uses DerivAPI.restoreSession() which handles the full v4 OTP flow
  const autoLogin = () => {
    if (!hasSession()) {
      window.location.href = 'index.html';
      return;
    }

    // Restore UI immediately from cached values
    const curr = getCurrency();
    const bal  = getBalance();
    const id   = getLoginId();

    document.querySelectorAll('[data-balance]').forEach(el => {
      el.textContent = `${curr} ${parseFloat(bal).toFixed(2)}`;
    });
    document.querySelectorAll('[data-loginid]').forEach(el => {
      el.textContent = id || '--';
    });
    document.querySelectorAll('[data-currency]').forEach(el => {
      el.textContent = curr;
    });

    // Connect via v4 REST → OTP → WS
    DerivAPI.restoreSession()
      .then(() => {
        // Subscribe to live balance once connected
        DerivAPI.subscribeBalance();
      })
      .catch(err => {
        console.error('[Auth] Session restore failed:', err.message);
        // If it's an auth error, clear and redirect
        if (err.message?.includes('401') || err.message?.includes('token') ||
            err.message?.includes('auth')) {
          clearSession();
          window.location.href = 'index.html';
        }
        // Otherwise just log — might be a temporary network issue
      });

    // Listen for live data
    DerivAPI.on('authorize', (data) => {
      if (data?.balance !== undefined) updateBalance(data.balance);
      if (data?.loginid) {
        localStorage.setItem(K.LOGINID, data.loginid);
        document.querySelectorAll('[data-loginid]').forEach(el => {
          el.textContent = data.loginid;
        });
      }
      if (data?.currency) {
        localStorage.setItem(K.CURRENCY, data.currency);
        document.querySelectorAll('[data-currency]').forEach(el => {
          el.textContent = data.currency;
        });
      }
    });

    DerivAPI.on('balance', (data) => {
      if (data?.balance !== undefined) updateBalance(data.balance);
    });

    DerivAPI.on('error', (err) => {
      if (err.code === 'AuthorizationRequired' || err.code === 'InvalidToken' ||
          err.code === 'Unauthorized') {
        clearSession();
        window.location.href = 'index.html';
      }
    });
  };

  // ── LOGOUT ──────────────────────────────────────────────────────────────
  const logout = () => {
    clearSession();
    DerivAPI.disconnect();
    window.location.href = 'index.html';
  };

  const clearSession = () => Object.values(K).forEach(k => localStorage.removeItem(k));

  // ── PUBLIC ───────────────────────────────────────────────────────────────
  return {
    autoLogin,
    logout,
    hasSession,
    getToken,
    getCurrency,
    getBalance,
    getLoginId,
    getAllAccounts,
    getAccountInfo,
    updateBalance,
    clearSession,
  };

})();
