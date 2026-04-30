/*
 * IP geolocation helper.
 *
 * Uses ipapi.co's free tier (~30k requests/month, no API key required) for an
 * approximate city / region / country lookup at signature submission time.
 *
 * Wrapped in a short timeout and graceful fallback so a slow or degraded
 * geo service never blocks the user from completing their acknowledgement.
 * If the lookup fails (rate limit, network error, private IP, etc.) the caller
 * receives `null` and the receipt PDF simply omits the location line.
 *
 * Phase-2 upgrade path: swap to MaxMind GeoLite2 (self-hosted, no rate limits)
 * or a paid IP-geo provider if call volume outgrows the free tier.
 */

const LOOKUP_TIMEOUT_MS = 2000;
const CACHE_MAX = 500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ip -> { value: { city, region, regionCode, country } | null, expiresAt: number }
const cache = new Map();

function isLoopbackOrPrivate(ip) {
  if (!ip || typeof ip !== 'string') return true;
  // Strip IPv6-mapped-IPv4 prefix Express sometimes hands us (e.g. ::ffff:73.x.x.x).
  let v = ip;
  if (v.startsWith('::ffff:')) v = v.slice(7);
  if (v === '127.0.0.1' || v === '::1' || v === 'localhost') return true;
  // RFC1918 ranges + link-local + RFC6598 carrier-grade NAT.
  if (/^10\./.test(v)) return true;
  if (/^192\.168\./.test(v)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(v)) return true;
  if (/^169\.254\./.test(v)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(v)) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd]/i.test(v)) return true;
  if (/^fe80/i.test(v)) return true;
  return false;
}

function pruneCache() {
  if (cache.size <= CACHE_MAX) return;
  // Map iteration is insertion-ordered, so this drops the oldest entry.
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

export async function lookupIpLocation(ip) {
  if (isLoopbackOrPrivate(ip)) return null;

  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      cache.set(ip, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
      pruneCache();
      return null;
    }
    const data = await res.json().catch(() => null);
    if (!data || data.error) {
      cache.set(ip, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
      pruneCache();
      return null;
    }
    const result = {
      city: typeof data.city === 'string' && data.city ? data.city : null,
      region: typeof data.region === 'string' && data.region ? data.region : null,
      regionCode:
        typeof data.region_code === 'string' && data.region_code ? data.region_code : null,
      country:
        typeof data.country_code === 'string' && data.country_code
          ? data.country_code
          : (typeof data.country === 'string' && data.country ? data.country : null),
    };
    cache.set(ip, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    pruneCache();
    return result;
  } catch (err) {
    // Timeout / network error / abort — silently degrade.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function formatLocation(loc) {
  if (!loc) return null;
  const parts = [];
  if (loc.city) parts.push(loc.city);
  if (loc.regionCode) parts.push(loc.regionCode);
  else if (loc.region) parts.push(loc.region);
  if (loc.country) parts.push(loc.country);
  return parts.length ? parts.join(', ') : null;
}
