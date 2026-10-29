// Request rate limits and client-address trust. server.js creates the limiters with
// rateLimit(limiterOptions(kind)) and decides WHERE each one is mounted; this module only holds
// the fixed limits, the bucket keys and the 429 response, so the tests exercise the same options.
// In-memory store: fine for the single-instance deployment this app targets.

const fs = require('fs');
const { ipKeyGenerator } = require('express-rate-limit');

const WINDOW_MS = 60_000;
// Requests per WINDOW_MS. Fixed on purpose (no env overrides).
//   auth - per client IP: /login, /callback, /logout, and every unauthenticated request that
//          requiresAuth() would answer by starting a login.
//   api  - per signed-in user (else per client IP): everything under /api.
//   spa  - per signed-in user (else per client IP): the app shell, /version.txt and other
//          static files; the content-hashed build assets under /assets are exempt.
const LIMITS = Object.freeze({ auth: 30, api: 600, spa: 300 });
const MESSAGE = 'Too many requests - try again in a moment';

// TRUST_PROXY → Express 'trust proxy'. Default: trust nobody, so req.ip is the TCP peer and a
// client can't pick its own address with an X-Forwarded-For header. Accepts a hop count or a
// comma-separated list of addresses / CIDRs / Express names (loopback, linklocal, uniquelocal).
// 'true' (trust every hop) is refused: it would make every per-IP limit spoofable.
function parseTrustProxy(raw) {
    const v = String(raw ?? '').trim();
    if (!v || v.toLowerCase() === 'false') return false;
    if (/^\d+$/.test(v)) return Number(v);
    if (v.toLowerCase() === 'true') {
        console.error('TRUST_PROXY=true is not accepted (any client could spoof its address) - set the proxy address or CIDR instead. Trusting no proxy.');
        return false;
    }
    return v.split(',').map(s => s.trim()).filter(Boolean);
}

// The signed-in user (the OIDC subject from the verified session) when there is one, else the
// client IP (IPv6 grouped by subnet). Never the tenant header: one user managing several tenants
// still has ONE bucket.
function clientKey(req) {
    if (req.oidc && req.oidc.isAuthenticated() && req.oidc.user && req.oidc.user.sub) {
        return `user:${req.oidc.user.sub}`;
    }
    return `ip:${ipKeyGenerator(req.ip || '')}`;
}

// The auth limiter is mounted twice: on /login, /callback and /logout BEFORE the OIDC middleware
// (no req.oidc yet, always counted), and again just before requiresAuth() (counted only when the
// visitor is not signed in). A request is charged at most once.
const AUTH_CHARGED = Symbol('authBudgetCharged');
function skipAuthBudget(req) {
    if (req[AUTH_CHARGED]) return true;
    if (req.oidc && req.oidc.isAuthenticated()) return true;
    req[AUTH_CHARGED] = true;
    return false;
}

const API_PATH = /^\/api(\/|$)/i;

// The hashed build assets that exist on disk at startup (a page load fetches several; they are
// immutable and cached forever). Anything else under /assets falls through to the SPA fallback,
// so it stays limited.
function buildAssetNames(assetsDir) {
    try { return new Set(fs.readdirSync(assetsDir)); } catch { return new Set(); }
}

function tooManyRequests(req, res, next, options) {
    res.status(options.statusCode);
    if (API_PATH.test(req.originalUrl) || !req.accepts('html')) return res.json({ error: MESSAGE });
    return res.type('text/plain').send(MESSAGE);
}

// Options for rateLimit(). `windowMs` is only overridden by the tests.
function limiterOptions(kind, { windowMs = WINDOW_MS, assetsDir = '' } = {}) {
    const base = {
        windowMs,
        limit: LIMITS[kind],
        identifier: kind,
        standardHeaders: 'draft-8', // RateLimit + RateLimit-Policy; Retry-After on a 429
        legacyHeaders: false,
        handler: tooManyRequests,
    };
    if (kind === 'auth') {
        return { ...base, keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip || '')}`, skip: skipAuthBudget };
    }
    if (kind === 'api') return { ...base, keyGenerator: clientKey };
    if (kind === 'spa') {
        const assets = buildAssetNames(assetsDir);
        const isBuildAsset = (p) => p.startsWith('/assets/') && assets.has(p.slice('/assets/'.length));
        return { ...base, keyGenerator: clientKey, skip: (req) => API_PATH.test(req.path) || isBuildAsset(req.path) };
    }
    throw new Error(`Unknown rate limiter: ${kind}`);
}

module.exports = { WINDOW_MS, LIMITS, MESSAGE, parseTrustProxy, clientKey, limiterOptions };
