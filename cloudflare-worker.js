/**
 * NetMirror — Cloudflare Worker Reverse Proxy
 * ============================================
 * 
 * This Worker proxies ALL requests to the Railway backend.
 * Users access your-name.workers.dev → Cloudflare forwards to Railway.
 * 
 * Why: ISPs in many countries block *.railway.app at DNS level.
 * Cloudflare's IPs are never blocked, so this bypasses ISP restrictions.
 * 
 * Free tier: 100,000 requests/day (more than enough).
 * 
 * SETUP:
 * 1. Go to https://dash.cloudflare.com → Sign up (free)
 * 2. Left sidebar → Workers & Pages → Create
 * 3. Click "Create Worker"
 * 4. Name it (e.g., "netmirror-app") → Deploy
 * 5. Click "Edit code" → paste this entire file → Save and Deploy
 * 6. Your URL: https://netmirror-app.YOUR-SUBDOMAIN.workers.dev
 * 
 * OPTIONAL — Custom Domain (for a cleaner URL):
 * 1. Buy a cheap domain ($1-2/year for .xyz, .site, .online)
 * 2. In Cloudflare dashboard → add the domain
 * 3. Worker Settings → Custom Domains → add your domain
 * 4. Now users access https://yourdomain.xyz
 */

// ═══════════ CONFIGURATION ═══════════
// Change this to your Railway backend URL
const BACKEND_ORIGIN = 'https://netmirror.up.railway.app';

// Optional: add your backup server URL for automatic failover
const BACKUP_ORIGIN = ''; // e.g., 'https://netmirror-backup.onrender.com'

// GitHub Releases APK URL — if set, APK downloads redirect here (Chrome-safe, no warnings)
// This gets auto-populated when you push APK to GitHub Releases from admin panel
let GITHUB_APK_URL = ''; // e.g., 'https://github.com/vernapark/Leakspro-backend/releases/download/latest/NetMirror.apk'

// ═══════════ WORKER HANDLER ═══════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    // APK downloads: redirect to GitHub Releases (trusted domain = no Chrome warning)
    const path = url.pathname.toLowerCase();
    if (path.endsWith('.apk') && GITHUB_APK_URL) {
      return Response.redirect(GITHUB_APK_URL, 302);
    }

    // For the download URL API, dynamically inject GitHub APK URL 
    // so the landing page's smart download knows about it
    if (path === '/api/admin/apk-download-url') {
      // Proxy to backend but enhance response with GitHub URL
      try {
        const targetUrl = new URL(url.pathname + url.search, BACKEND_ORIGIN);
        const backendRes = await fetch(targetUrl.toString());
        if (backendRes.ok) {
          const data = await backendRes.json();
          // If backend has a GitHub URL, cache it for APK redirects
          if (data.github_url) GITHUB_APK_URL = data.github_url;
          return new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      } catch(_) {}
    }
    
    // Build the proxied URL — keep the path, query, hash
    const targetUrl = new URL(url.pathname + url.search, BACKEND_ORIGIN);
    
    // Clone the request with the new URL
    const modifiedHeaders = new Headers(request.headers);
    
    // Pass the original host as X-Forwarded headers
    modifiedHeaders.set('X-Forwarded-Host', url.hostname);
    modifiedHeaders.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
    modifiedHeaders.set('X-Real-IP', request.headers.get('CF-Connecting-IP') || '');
    
    // Remove headers that might cause issues
    modifiedHeaders.delete('Host');
    
    const modifiedRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: modifiedHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
      redirect: 'manual', // Don't auto-follow redirects
    });

    try {
      // Try primary backend
      let response = await fetch(modifiedRequest, { 
        cf: { cacheTtl: 0 } // Don't cache API responses
      });
      
      // If primary fails and backup is configured, try backup
      if (!response.ok && response.status >= 500 && BACKUP_ORIGIN) {
        const backupUrl = new URL(url.pathname + url.search, BACKUP_ORIGIN);
        const backupRequest = new Request(backupUrl.toString(), {
          method: request.method,
          headers: modifiedHeaders,
          body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
          redirect: 'manual',
        });
        
        try {
          const backupResponse = await fetch(backupRequest, { cf: { cacheTtl: 0 } });
          if (backupResponse.ok || backupResponse.status < 500) {
            response = backupResponse;
          }
        } catch (e) {
          // Backup also failed, return primary's error
        }
      }
      
      // Clone response and add CORS + caching headers
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', '*');
      
      // CRITICAL: Workers auto-decompress responses, but the original
      // Content-Encoding header stays. If we pass it through, the browser
      // tries to decompress already-decompressed data → garbled CSS/HTML/JS.
      responseHeaders.delete('Content-Encoding');
      responseHeaders.delete('Content-Length'); // Length changed after decompression
      
      // Cache static assets (landing page, CSS, JS, images)
      const lowerPath = url.pathname.toLowerCase();
      if (lowerPath.endsWith('.html') || lowerPath.endsWith('.css') || lowerPath.endsWith('.js') || 
          lowerPath.endsWith('.png') || lowerPath.endsWith('.jpg') || lowerPath.endsWith('.ico') ||
          lowerPath.endsWith('.svg') || lowerPath.endsWith('.woff2')) {
        responseHeaders.set('Cache-Control', 'public, max-age=3600'); // 1 hour
      }
      
      // For APK downloads, set proper content type
      if (lowerPath.endsWith('.apk')) {
        responseHeaders.set('Content-Type', 'application/vnd.android.package-archive');
        responseHeaders.set('Content-Disposition', 'attachment; filename="NetMirror.apk"');
        responseHeaders.delete('Cache-Control');
        responseHeaders.set('Cache-Control', 'no-cache'); // Always serve latest APK
      }
      
      // Fix redirect URLs (change Railway domain to Worker domain in Location header)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('Location');
        if (location) {
          const fixedLocation = location.replace(BACKEND_ORIGIN, url.origin);
          responseHeaders.set('Location', fixedLocation);
        }
      }
      
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
      
    } catch (error) {
      // Network error — backend completely unreachable
      return new Response(
        JSON.stringify({
          error: 'Server temporarily unavailable',
          message: 'The streaming server is currently down. Please try again later.',
          retry_after: 60
        }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Retry-After': '60',
          }
        }
      );
    }
  }
};

/**
 * ═══════════════════════════════════════════════════════
 * QUICK SETUP GUIDE
 * ═══════════════════════════════════════════════════════
 * 
 * 1. SIGN UP (2 min)
 *    - Go to https://dash.cloudflare.com/sign-up
 *    - Create a free account (email + password)
 * 
 * 2. CREATE WORKER (1 min)
 *    - Left sidebar → "Workers & Pages"
 *    - Click "Create" → "Create Worker"
 *    - Name: "netmirror-app" (or anything you like)
 *    - Click "Deploy"
 * 
 * 3. PASTE CODE (1 min)
 *    - After deploy, click "Edit code"
 *    - Select all → delete → paste this entire file
 *    - Click "Save and Deploy"
 * 
 * 4. TEST IT
 *    - Your URL: https://netmirror-app.YOUR-SUBDOMAIN.workers.dev
 *    - Open it on any phone browser — the landing page loads!
 *    - APK download works: https://netmirror-app.YOUR-SUBDOMAIN.workers.dev/downloadapp/Netmirror.apk
 *    - Admin panel works: https://netmirror-app.YOUR-SUBDOMAIN.workers.dev/admin
 * 
 * 5. UPDATE ADMIN PANEL
 *    - Go to Admin Panel → System & Recovery
 *    - Set the worker URL as your domain
 *    - All apps will auto-discover the new URL
 * 
 * ═══════════════════════════════════════════════════════
 * OPTIONAL — CUSTOM DOMAIN ($1-2/year)
 * ═══════════════════════════════════════════════════════
 * 
 * For a professional URL like netmirror.xyz instead of *.workers.dev:
 * 
 * 1. Buy a domain at Namecheap, Porkbun, or Cloudflare Registrar
 *    - .xyz domains: ~$1/year
 *    - .site domains: ~$1/year  
 *    - .online domains: ~$1/year
 * 
 * 2. Add domain to Cloudflare:
 *    - Dashboard → "Add a site" → enter your domain
 *    - Change nameservers at the registrar to Cloudflare's
 *    - Wait for DNS propagation (5-30 min)
 * 
 * 3. Attach domain to Worker:
 *    - Workers & Pages → your worker → Settings → Domains & Routes
 *    - "Add" → Custom Domain → enter your domain
 *    - Cloudflare handles SSL automatically
 * 
 * 4. Users now access: https://yourdomain.xyz
 *    - Landing page: https://yourdomain.xyz/downloadapp
 *    - Admin panel: https://yourdomain.xyz/admin
 *    - API: https://yourdomain.xyz/api/...
 * 
 * ═══════════════════════════════════════════════════════
 */
