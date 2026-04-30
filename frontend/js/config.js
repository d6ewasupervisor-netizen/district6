// Frontend config. Edit API_BASE to point at your deployed backend.
window.D6_CONFIG = {
  // Override via the URL hash for ad-hoc testing, e.g. #api=http://localhost:3000
  API_BASE: (function () {
    const hashApi = (location.hash.match(/api=([^&]+)/) || [])[1];
    if (hashApi) return decodeURIComponent(hashApi).replace(/\/+$/, '');
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return 'http://localhost:3000';
    }
    // Production backend (Railway). Replace with your deployed URL.
    return 'https://district6-compliance-api.up.railway.app';
  })(),
};
