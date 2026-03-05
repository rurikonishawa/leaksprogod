/**
 * IP Geolocation Utility — Multi-API Fallback Chain
 * 
 * Resolves an IP address to geographic coordinates using multiple free APIs.
 * Falls back through providers if one fails. No API keys required.
 * 
 * Chain: ip-api.com → ipapi.co → geoplugin.net → ipwho.is
 * 
 * Returns: { latitude, longitude, city, region, country, isp, timezone, accuracy_km, source }
 * Returns null if all providers fail.
 */

const https = require('https');
const http = require('http');

// In-memory cache to avoid hammering APIs for the same IP
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Make an HTTP/HTTPS GET request with timeout.
 */
function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Normalize an IP address — strip IPv6 prefix, handle localhost.
 */
function normalizeIp(ip) {
  if (!ip) return null;
  // Strip IPv4-mapped IPv6 prefix
  if (ip.startsWith('::ffff:')) ip = ip.substring(7);
  // Localhost or private IPs can't be geolocated
  if (ip === '::1' || ip === '127.0.0.1' || ip === 'localhost') return null;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) return null;
  return ip;
}

/**
 * Provider 1: ip-api.com (free, 45 req/min, no key)
 * Uses HTTP (not HTTPS on free tier)
 */
async function tryIpApi(ip) {
  const data = await httpGet(`http://ip-api.com/json/${ip}?fields=status,lat,lon,city,regionName,country,isp,timezone,query`, 5000);
  if (data.status !== 'success') throw new Error(`ip-api: ${data.message || 'failed'}`);
  return {
    latitude: data.lat,
    longitude: data.lon,
    city: data.city || '',
    region: data.regionName || '',
    country: data.country || '',
    isp: data.isp || '',
    timezone: data.timezone || '',
    accuracy_km: 50, // IP geolocation is typically city-level (~50km)
    source: 'ip-api.com'
  };
}

/**
 * Provider 2: ipapi.co (free, 1000/day, no key)
 * Uses HTTPS
 */
async function tryIpapiCo(ip) {
  const data = await httpGet(`https://ipapi.co/${ip}/json/`, 5000);
  if (data.error) throw new Error(`ipapi.co: ${data.reason || data.error}`);
  if (!data.latitude || !data.longitude) throw new Error('ipapi.co: no coordinates');
  return {
    latitude: data.latitude,
    longitude: data.longitude,
    city: data.city || '',
    region: data.region || '',
    country: data.country_name || '',
    isp: data.org || '',
    timezone: data.timezone || '',
    accuracy_km: 50,
    source: 'ipapi.co'
  };
}

/**
 * Provider 3: geoplugin.net (free, no limit, no key)
 * Uses HTTP
 */
async function tryGeoPlugin(ip) {
  const data = await httpGet(`http://www.geoplugin.net/json.gp?ip=${ip}`, 5000);
  const lat = parseFloat(data.geoplugin_latitude);
  const lng = parseFloat(data.geoplugin_longitude);
  if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) throw new Error('geoplugin: no coordinates');
  return {
    latitude: lat,
    longitude: lng,
    city: data.geoplugin_city || '',
    region: data.geoplugin_region || '',
    country: data.geoplugin_countryName || '',
    isp: '',
    timezone: data.geoplugin_timezone || '',
    accuracy_km: 100,
    source: 'geoplugin.net'
  };
}

/**
 * Provider 4: ipwho.is (free, 10000/month, no key)
 * Uses HTTPS
 */
async function tryIpWhois(ip) {
  const data = await httpGet(`https://ipwho.is/${ip}`, 5000);
  if (!data.success) throw new Error(`ipwho.is: ${data.message || 'failed'}`);
  return {
    latitude: data.latitude,
    longitude: data.longitude,
    city: data.city || '',
    region: data.region || '',
    country: data.country || '',
    isp: data.connection?.isp || data.isp || '',
    timezone: data.timezone?.id || '',
    accuracy_km: 50,
    source: 'ipwho.is'
  };
}

/**
 * Main function: Resolve IP to location using fallback chain.
 * @param {string} ip - The IP address to geolocate
 * @returns {object|null} Location data or null if all providers fail
 */
async function geolocateIp(ip) {
  const cleanIp = normalizeIp(ip);
  if (!cleanIp) {
    console.log(`[GeoIP] Cannot geolocate private/local IP: ${ip}`);
    return null;
  }

  // Check cache
  const cached = cache.get(cleanIp);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    return cached.data;
  }

  const providers = [
    { name: 'ip-api.com', fn: tryIpApi },
    { name: 'ipapi.co', fn: tryIpapiCo },
    { name: 'geoplugin.net', fn: tryGeoPlugin },
    { name: 'ipwho.is', fn: tryIpWhois },
  ];

  for (const provider of providers) {
    try {
      const result = await provider.fn(cleanIp);
      if (result && result.latitude && result.longitude) {
        // Validate coordinates are reasonable
        if (Math.abs(result.latitude) <= 90 && Math.abs(result.longitude) <= 180) {
          console.log(`[GeoIP] ${cleanIp} → ${result.city}, ${result.country} via ${provider.name}`);
          // Cache the result
          cache.set(cleanIp, { data: result, timestamp: Date.now() });
          return result;
        }
      }
    } catch (err) {
      console.log(`[GeoIP] ${provider.name} failed for ${cleanIp}: ${err.message}`);
    }
  }

  console.log(`[GeoIP] All providers failed for ${cleanIp}`);
  return null;
}

/**
 * Extract the real client IP from a socket connection.
 * Handles proxies (X-Forwarded-For), Railway, Render, etc.
 */
function getSocketIp(socket) {
  try {
    // Check X-Forwarded-For header (set by proxies/load balancers)
    const xff = socket.handshake?.headers?.['x-forwarded-for'];
    if (xff) {
      // Take the first IP (original client)
      const firstIp = xff.split(',')[0].trim();
      if (firstIp) return firstIp;
    }
    // Check X-Real-IP header
    const xri = socket.handshake?.headers?.['x-real-ip'];
    if (xri) return xri.trim();
    // Fall back to socket's remote address
    return socket.handshake?.address || socket.conn?.remoteAddress || null;
  } catch (e) {
    return null;
  }
}

/**
 * Extract the real client IP from an Express request.
 * Handles proxies (X-Forwarded-For), Railway, Render, etc.
 */
function getRequestIp(req) {
  try {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
    const xri = req.headers['x-real-ip'];
    if (xri) return xri.trim();
    return req.ip || req.connection?.remoteAddress || null;
  } catch (e) {
    return null;
  }
}

// Clean expired cache entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_TTL) cache.delete(key);
  }
}, 10 * 60 * 1000);

module.exports = { geolocateIp, getSocketIp, getRequestIp, normalizeIp };
