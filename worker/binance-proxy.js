/**
 * Silver Ops - Cloudflare Worker Proxy
 * 
 * Proxies Binance Futures API requests to bypass CORS restrictions
 * Deploy to Cloudflare Workers (free tier: 100,000 requests/day)
 * 
 * Environment Variables (set in Cloudflare Dashboard):
 * - PROXY_SERVER: Your proxy server URL (e.g., https://your-proxy.com:3128)
 * - PROXY_SECRET: Secret token for proxy authentication
 */

const BINANCE_BASE = 'https://fapi.binance.com';

// Whitelist of allowed Binance API paths for security
const ALLOWED_PATHS = [
    '/fapi/v1/ticker/price',
    '/fapi/v1/ticker/24hr',
    '/fapi/v1/openInterest',
    '/fapi/v1/fundingRate',
    '/fapi/v1/depth',
    '/fapi/v1/exchangeInfo',
    '/futures/data/globalLongShortAccountRatio',
    '/futures/data/topLongShortAccountRatio',
    '/futures/data/topLongShortPositionRatio'
];

// Rate limiting configuration
const RATE_LIMIT = {
    maxRequests: 100,
    windowMs: 60000 // 1 minute
};

// Simple in-memory rate limiting (resets on worker restart)
const requestCounts = new Map();

function isRateLimited(ip) {
    const now = Date.now();
    const record = requestCounts.get(ip);

    if (!record || now - record.timestamp > RATE_LIMIT.windowMs) {
        requestCounts.set(ip, { count: 1, timestamp: now });
        return false;
    }

    record.count++;
    if (record.count > RATE_LIMIT.maxRequests) {
        return true;
    }

    return false;
}

function isAllowedPath(pathname) {
    return ALLOWED_PATHS.some(allowed => pathname.startsWith(allowed));
}

export default {
    async fetch(request, env, ctx) {
        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Access-Control-Max-Age': '86400'
                }
            });
        }

        // Only allow GET requests
        if (request.method !== 'GET') {
            return new Response(JSON.stringify({ error: 'Method not allowed' }), {
                status: 405,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }

        // Get client IP for rate limiting
        const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

        // Check rate limit
        if (isRateLimited(clientIP)) {
            return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
                status: 429,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Retry-After': '60'
                }
            });
        }

        const url = new URL(request.url);
        const path = url.pathname + url.search;

        // Health check endpoint
        if (url.pathname === '/health' || url.pathname === '/') {
            return new Response(JSON.stringify({
                status: 'ok',
                service: 'Silver Ops Binance Proxy',
                timestamp: new Date().toISOString(),
                allowedPaths: ALLOWED_PATHS,
                proxyConfigured: !!env.PROXY_SERVER,
                proxyServer: env.PROXY_SERVER ? env.PROXY_SERVER.replace(/\/\/.*@/, '//***@') : 'not set'
            }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }

        // Security check: Only allow whitelisted paths
        if (!isAllowedPath(url.pathname)) {
            return new Response(JSON.stringify({
                error: 'Forbidden path',
                allowedPaths: ALLOWED_PATHS
            }), {
                status: 403,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }

        try {
            const binanceUrl = BINANCE_BASE + path;

            // Fetch from Binance through proxy with timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            // Always use proxy server
            const proxyServer = env.PROXY_SERVER;
            const proxySecret = env.PROXY_SECRET || '';

            if (!proxyServer) {
                throw new Error('Proxy server not configured. Set PROXY_SERVER environment variable.');
            }

            // Send request through proxy with secret token
            const proxyUrl = `${proxyServer}/?url=${encodeURIComponent(binanceUrl)}`;

            let response;
            let fetchError = null;
            try {
                response = await fetch(proxyUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*',
                        'X-Proxy-Secret': proxySecret,
                        'X-Target-URL': binanceUrl
                    },
                    signal: controller.signal
                });
            } catch (proxyError) {
                fetchError = proxyError;
                throw new Error(`Proxy fetch failed: ${proxyError.name}: ${proxyError.message}`);
            }

            clearTimeout(timeoutId);

            // Get response details for debugging
            const responseHeaders = {};
            response.headers.forEach((value, key) => {
                responseHeaders[key] = value;
            });

            // Check if API returned an error
            if (!response.ok) {
                const errorText = await response.text();
                return new Response(JSON.stringify({
                    error: 'API error',
                    status: response.status,
                    statusText: response.statusText,
                    message: errorText,
                    debug: {
                        proxyServer: proxyServer,
                        proxyUrl: proxyUrl,
                        targetUrl: binanceUrl,
                        responseHeaders: responseHeaders,
                        responseType: response.type,
                        responseUrl: response.url
                    }
                }), {
                    status: response.status,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                });
            }

            const data = await response.text();

            // Return proxied response with CORS headers
            return new Response(data, {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'X-Proxy-By': 'Silver-Ops',
                    'X-Binance-Endpoint': url.pathname
                }
            });

        } catch (error) {
            // Handle timeout or other errors
            const isTimeout = error.name === 'AbortError';
            const proxyServer = env.PROXY_SERVER || 'not set';

            return new Response(JSON.stringify({
                error: isTimeout ? 'Request timeout' : 'Proxy error',
                errorName: error.name,
                errorMessage: error.message,
                errorStack: error.stack,
                debug: {
                    proxyServer: proxyServer,
                    proxySecret: env.PROXY_SECRET ? 'set' : 'not set',
                    timestamp: new Date().toISOString()
                }
            }), {
                status: isTimeout ? 504 : 500,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
    }
};
