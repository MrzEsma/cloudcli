(() => {
  'use strict';
  const prefix = '#beteam-session=';
  if (!window.location.hash.startsWith(prefix)) return;

  const encodedToken = window.location.hash.slice(prefix.length);
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  try {
    const token = decodeURIComponent(encodedToken);
    const tokenPattern = /^[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,2048}$/;
    if (token.length > 8192 || !tokenPattern.test(token)) return;
    window.localStorage.setItem('auth-token', token);
  } catch {
    // The fragment was already removed. Leave any existing tenant session intact.
  }
})();
