/**
 * PrimeBot Dashboard — Express server.
 *
 * A standalone web app that lets Discord server admins log in with Discord
 * OAuth2 and configure PrimeBot for the servers they manage. It reads and
 * writes the same PostgreSQL tables the bot uses. The bot caches settings in
 * memory and re-reads the tables on a ~30s interval (see
 * SETTINGS_RELOAD_INTERVAL_MS), so dashboard saves take effect within that
 * window without a bot restart — provided the bot and dashboard point at the
 * same DATABASE_URL / WELCOME_DATABASE_URL.
 *
 * Run with:  npm run dashboard
 * Env vars:  PORT, DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET,
 *            DISCORD_REDIRECT_URI, SESSION_SECRET
 */

const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const PgSession = require('connect-pg-simple')(session);

const discord = require('./discord');
const { requireAuth, requireGuildAdmin } = require('./auth');
const dashboardDb = require('./db');
const constants = require('./constants');

// Allow a dedicated token for dashboard REST calls; fall back to DISCORD_TOKEN.
if (!process.env.DASHBOARD_BOT_TOKEN && process.env.DISCORD_TOKEN) {
    process.env.DASHBOARD_BOT_TOKEN = process.env.DISCORD_TOKEN;
}
if (process.env.DASHBOARD_BOT_TOKEN && !process.env.DISCORD_TOKEN) {
    process.env.DISCORD_TOKEN = process.env.DASHBOARD_BOT_TOKEN;
}

const app = express();
// Trust the TLS-terminating proxy in front of us so req.secure / req.ip
// reflect the real client connection (HTTPS). Without this, express-session
// sees plain HTTP and refuses to set Secure cookies — login silently fails.
// (Vercel, the work host, and any reverse proxy front this app.)
app.set('trust proxy', 1);
const PORT = parseInt(process.env.DASHBOARD_PORT || process.env.PORT || 3000, 10);
// Resolve the public base URL in priority order:
//   1. DASHBOARD_BASE_URL  (explicit, always wins)
//   2. VERCEL_PROJECT_PRODUCTION_URL — the STABLE production domain on Vercel
//      (e.g. cpanel-primebot.vercel.app). This is critical: VERCEL_URL is a
//      per-deployment hashed preview URL that changes every deploy, so the
//      OAuth redirect_uri it produces never matches what's registered in the
//      Discord Developer Portal → "invalid redirect_uri".
//   3. VERCEL_URL — last-resort preview host
//   4. localhost for local dev
const BASE_URL = process.env.DASHBOARD_BASE_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`));
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `${BASE_URL}/auth/callback`;

const SESSION_SECRET = process.env.SESSION_SECRET || 'primebot-dashboard-dev-secret-change-me';

// On Vercel (serverless), MemoryStore is useless because each request may run
// in a fresh instance. Store sessions in the same PostgreSQL DB the bot uses.
//
// CRITICAL: the session pool must negotiate SSL the same way the bot's main
// pool does (server/db.js). Production Postgres on Vercel (Neon, Supabase,
// Vercel Postgres, etc.) REQUIRES SSL; a bare `new Pool({ connectionString })`
// without ssl silently fails every session write. The OAuth callback then
// redirects to "/" on a save error, the session row is never persisted, the
// next /api/me returns 401, and the user lands back on the login screen —
// i.e. "login works but never reaches the dashboard". So we reuse the bot's
// already-SSL-aware pool rather than constructing a naive one.
function buildSessionStore() {
    let pool = null;
    try {
        pool = require('../server/db').pool;
    } catch (err) {
        console.warn('[SESSION] Could not import bot DB pool, falling back to a local pool:', err.message);
    }
    if (!pool && process.env.DATABASE_URL) {
        const dbUrl = process.env.DATABASE_URL;
        pool = new Pool({
            connectionString: dbUrl,
            ssl: /sslmode=require/.test(dbUrl) ? { rejectUnauthorized: false } : (process.env.DB_SSL === 'require' ? { rejectUnauthorized: false } : undefined),
        });
    }
    if (pool) {
        return new PgSession({
            pool,
            // Use a dedicated table — a generic "session" table may already
            // exist in the shared DB with a different schema (e.g. another app's
            // auth table), which would break connect-pg-simple.
            tableName: 'primebot_dashboard_session',
            createTableIfNotExists: true,
            pruneSessionInterval: false,
            // Surface connection failures instead of hanging on cold starts.
            error: (err) => console.error('[SESSION] PgSession store error:', err.message),
        });
    }
    // Local dev fallback (single process).
    return undefined;
}

// Resolved at boot via /users/@me — the real bot user ID (may differ from
// DISCORD_CLIENT_ID if the env points token + client id at different apps).
let botUserId = process.env.DISCORD_CLIENT_ID || null;
let botSelf = null;

// ── Middleware ──────────────────────────────────────────────────────────────

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Secure cookies whenever we're not on plain localhost. Vercel, the work host,
// and production all serve HTTPS, so the session cookie must be marked Secure
// or browsers will silently drop it.
const isLocalhost = BASE_URL.startsWith('http://localhost');
const cookieSecure = !isLocalhost;

const sessionStore = buildSessionStore();
app.use(session({
    name: constants.SESSION_COOKIE,
    secret: SESSION_SECRET,
    // Trust Vercel's TLS-terminating proxy so Secure cookies are set/sent
    // correctly (x-forwarded-proto: https). Without `proxy: true`,
    // express-session ignores the forward-proto header for the Secure-cookie
    // decision and login silently fails on serverless.
    proxy: true,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
        httpOnly: true,
        secure: cookieSecure,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
}));

// Expose a few constants to all templates via res.locals.
app.use((req, res, next) => {
    res.locals.botName = constants.BOT_NAME;
    res.locals.botVersion = constants.BOT_VERSION;
    res.locals.botWebsite = constants.BOT_WEBSITE;
    res.locals.botSupport = constants.BOT_SUPPORT;
    res.locals.user = req.session && req.session.user;
    next();
});

// Static frontend assets.
app.use(express.static(path.join(__dirname, 'public')));

// Request logging — opt-in via DASHBOARD_LOG_REQUESTS=true (off by default).
if (process.env.DASHBOARD_LOG_REQUESTS === 'true') {
    app.use((req, res, next) => {
        console.log(`${req.method} ${req.url} — user:${req.session && req.session.user ? req.session.user.username : 'none'}`);
        next();
    });
}

// ── Auth routes ─────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
    if (req.session && req.session.user) return res.redirect('/');
    // If we were sent back here with an error (e.g. session persistence
    // failed after a successful Discord auth), render the SPA so it can
    // surface the message instead of silently bouncing back to Discord.
    if (req.query.error) {
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    const params = new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: constants.OAUTH_SCOPE,
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/login?error=missing_code');
    try {
        const tokens = await discord.exchangeCode(code, REDIRECT_URI);
        const user = await discord.getCurrentUser(tokens.access_token);
        // Cache guild list right away so the dashboard loads fast.
        let guilds = [];
        try { guilds = await discord.getUserGuilds(tokens.access_token); } catch (err) {
            console.warn('[AUTH] Could not fetch guilds during login:', err.message);
        }

        req.session.accessToken = tokens.access_token;
        req.session.refreshToken = tokens.refresh_token;
        req.session.tokenExpiresAt = Date.now() + (tokens.expires_in * 1000);
        req.session.user = {
            id: user.id,
            username: user.username,
            discriminator: user.discriminator,
            globalName: user.global_name,
            avatar: user.avatar,
        };
        req.session.guilds = guilds;
        req.session.guildsFetchedAt = Date.now();

        console.log(`[AUTH] Login OK for ${user.username} (${user.id}); ${guilds.length} guilds`);

        // Persist the session before redirecting, otherwise the Set-Cookie
        // header is not guaranteed to be written before the browser follows
        // the redirect to "/" (causing a bounce back to /login).
        // If the session store is broken (e.g. SSL to Postgres failed), surface
        // it instead of redirecting to a dashboard that will immediately 401.
        req.session.save((err) => {
            if (err) {
                console.error('[AUTH] Session save failed — redirecting to login with error:', err.message);
                return res.redirect('/login?error=session_failed');
            }
            res.redirect('/');
        });
    } catch (err) {
        console.error('[AUTH] Callback error:', err.message);
        res.redirect('/login?error=auth_failed');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie(constants.SESSION_COOKIE);
        res.redirect('/');
    });
});

// ── API: current user ───────────────────────────────────────────────────────

app.get('/api/me', requireAuth, async (req, res) => {
    await resolveBotSelf();
    res.json({ user: req.session.user, bot: botSelf, clientId: process.env.DISCORD_CLIENT_ID });
});

// ── API: list manageable guilds (admin's guilds where the bot is present) ───

app.get('/api/guilds', requireAuth, async (req, res) => {
    try {
        const accessToken = req.session.accessToken;
        let guilds = req.session.guilds;
        const fetchedAt = req.session.guildsFetchedAt || 0;
        const cacheFresh = Array.isArray(guilds) && Date.now() - fetchedAt <= 5 * 60 * 1000;
        if (!cacheFresh) {
            if (!accessToken) {
                // No user OAuth token available (e.g. debug session or token expired
                // and can't be refreshed). Fall back to whatever is cached so the
                // dashboard can still render instead of throwing.
                if (!Array.isArray(guilds)) guilds = [];
            } else {
                try {
                    guilds = await discord.getUserGuilds(accessToken);
                } catch (err) {
                    // Access token may have expired — try a refresh once.
                    if (req.session.refreshToken) {
                        try {
                            const tokens = await discord.refreshToken(req.session.refreshToken);
                            req.session.accessToken = tokens.access_token;
                            req.session.refreshToken = tokens.refresh_token || req.session.refreshToken;
                            req.session.tokenExpiresAt = Date.now() + (tokens.expires_in * 1000);
                            guilds = await discord.getUserGuilds(tokens.access_token);
                        } catch (refreshErr) {
                            console.warn('[API] token refresh failed:', refreshErr.message);
                            if (!Array.isArray(guilds)) guilds = [];
                        }
                    } else {
                        console.warn('[API] getUserGuilds failed and no refresh token:', err.message);
                        if (!Array.isArray(guilds)) guilds = [];
                    }
                }
                req.session.guilds = guilds;
                req.session.guildsFetchedAt = Date.now();
            }
        }

        const manageable = guilds.filter(g => discord.canManageGuild(g.permissions));

        // For each manageable guild, check bot presence in parallel (with a cap).
        const result = await Promise.all(manageable.slice(0, 50).map(async (g) => {
            let botInGuild = false;
            let config = null;
            try {
                await discord.getBotGuild(g.id);
                botInGuild = true;
                // Fetch config summary for the overview cards.
                config = await dashboardDb.getGuildConfig(g.id).catch(() => null);
            } catch (err) {
                botInGuild = false;
            }
            return {
                id: g.id,
                name: g.name,
                icon: g.icon,
                owner: g.owner,
                approximate_member_count: g.approximate_member_count,
                permissions: g.permissions,
                botPresent: botInGuild,
                welcomeEnabled: config?.welcome?.enabled ?? false,
                levelingEnabled: config?.server?.leveling?.enabled ?? true,
                prefix: config?.server?.prefix ?? constants.DEFAULT_PREFIX,
            };
        }));

        res.json({ guilds: result });
    } catch (err) {
        console.error('[API] /api/guilds error:', err.message);
        res.status(500).json({ error: 'Failed to load guilds.' });
    }
});

// ── API: full guild config (settings page) ──────────────────────────────────

app.get('/api/guilds/:guildId/config', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const config = await dashboardDb.getGuildConfig(req.guild.id);
        res.json({ guild: req.guild, config });
    } catch (err) {
        console.error('[API] get config error:', err.message);
        res.status(500).json({ error: 'Failed to load configuration.' });
    }
});

// ── API: guild channels (for selectors) ─────────────────────────────────────

app.get('/api/guilds/:guildId/channels', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const channels = await discord.getGuildChannels(req.guild.id);
        res.json({ channels: channels.map(c => ({ id: c.id, name: c.name })) });
    } catch (err) {
        console.error('[API] get channels error:', err.message);
        res.status(500).json({ error: 'Failed to load channels. Make sure PrimeBot has the View Channels permission.' });
    }
});

// ── API: update welcome settings ────────────────────────────────────────────

app.patch('/api/guilds/:guildId/welcome', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const allowed = [
            'enabled', 'channelId', 'message', 'bannerUrl', 'color',
            'dmEnabled', 'dmMessage',
            'showMemberCount', 'showJoinDate', 'showAccountAge',
            'customTitle', 'customFooter',
        ];
        const patch = {};
        for (const key of allowed) {
            if (key in req.body) patch[key] = req.body[key];
        }
        // Normalize booleans.
        for (const boolKey of ['enabled', 'dmEnabled', 'showMemberCount', 'showJoinDate', 'showAccountAge']) {
            if (boolKey in patch) patch[boolKey] = Boolean(patch[boolKey]);
        }
        // Null out empty channel id.
        if ('channelId' in patch && !patch.channelId) patch.channelId = null;
        const updated = await dashboardDb.upsertWelcomeSettings(req.guild.id, patch);
        res.json({ welcome: updated });
    } catch (err) {
        console.error('[API] update welcome error:', err.message);
        res.status(500).json({ error: 'Failed to update welcome settings.' });
    }
});

// ── API: update server settings (prefix, leveling, auto-reactions, broadcast) ─

app.patch('/api/guilds/:guildId/server', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const patch = {};

        if ('prefix' in body) patch.prefix = body.prefix;
        if ('receiveBroadcasts' in body) patch.receiveBroadcasts = Boolean(body.receiveBroadcasts);
        if ('broadcastChannelId' in body) patch.broadcastChannelId = body.broadcastChannelId || null;

        // Leveling sub-object — merge with current.
        if (body.leveling && typeof body.leveling === 'object') {
            const current = await dashboardDb.getServerSettings(req.guild.id);
            patch.leveling = {
                ...(current.leveling || {}),
                ...body.leveling,
            };
            if ('enabled' in patch.leveling) patch.leveling.enabled = Boolean(patch.leveling.enabled);
            if ('xpMultiplier' in patch.leveling) {
                const m = Number(patch.leveling.xpMultiplier);
                if (!Number.isFinite(m) || m <= 0 || m > 5) {
                    return res.status(400).json({ error: 'XP multiplier must be between 0 and 5.' });
                }
                patch.leveling.xpMultiplier = Number(m.toFixed(2));
            }
            if ('xpCooldown' in patch.leveling) {
                const seconds = Number(patch.leveling.xpCooldown);
                if (!Number.isFinite(seconds) || seconds < 5 || seconds > 300) {
                    return res.status(400).json({ error: 'XP cooldown must be between 5 and 300 seconds.' });
                }
                patch.leveling.xpCooldown = Math.round(seconds * 1000);
            }
            if ('levelUpChannelId' in patch.leveling) patch.leveling.levelUpChannelId = patch.leveling.levelUpChannelId || null;
        }

        // Auto-reactions sub-object.
        if (body.autoReactions && typeof body.autoReactions === 'object') {
            const current = await dashboardDb.getServerSettings(req.guild.id);
            patch.autoReactions = {
                enabled: body.autoReactions.enabled ?? current.autoReactions?.enabled ?? false,
                reactions: Array.isArray(body.autoReactions.reactions) ? body.autoReactions.reactions : (current.autoReactions?.reactions || []),
            };
            if ('enabled' in body.autoReactions) patch.autoReactions.enabled = Boolean(body.autoReactions.enabled);
        }

        const updated = await dashboardDb.upsertServerSettings(req.guild.id, patch);
        res.json({ server: updated });
    } catch (err) {
        console.error('[API] update server error:', err.message);
        res.status(500).json({ error: 'Failed to update server settings.' });
    }
});

// ── Page routes (SPA-style: serve index.html for everything) ────────────────

app.get(['/', '/dashboard', '/docs', '/guild/:guildId'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Health check ────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({ ok: true, name: constants.BOT_NAME, version: constants.BOT_VERSION });
});

// ── 404 / error handlers ────────────────────────────────────────────────────

app.use((req, res) => {
    if (req.accepts('html')) return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
    res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
    console.error('[SERVER] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ────────────────────────────────────────────────────────────────────

function preflightCheck() {
    const missing = [];
    if (!process.env.DISCORD_TOKEN && !process.env.DASHBOARD_BOT_TOKEN) missing.push('DISCORD_TOKEN');
    if (!process.env.DISCORD_CLIENT_ID) missing.push('DISCORD_CLIENT_ID');
    if (!process.env.DISCORD_CLIENT_SECRET) missing.push('DISCORD_CLIENT_SECRET');
    if (missing.length) {
        console.warn(`⚠️  Dashboard will not work fully without: ${missing.join(', ')}`);
        if (missing.includes('DISCORD_CLIENT_SECRET')) {
            console.warn('   DISCORD_CLIENT_SECRET is required for OAuth2 login.');
            console.warn('   Get it from the Discord Developer Portal → your app → OAuth2 → Client Secret.');
        }
        if (missing.includes('DISCORD_TOKEN')) {
            console.warn('   DISCORD_TOKEN is used by the dashboard to look up guilds/channels the bot can see.');
            console.warn('   Without it, opening any server shows "bot token not configured" (HTTP 503).');
            console.warn('   On Vercel, set DISCORD_TOKEN (or DASHBOARD_BOT_TOKEN) in Settings → Environment Variables.');
        }
    }
    if (SESSION_SECRET === 'primebot-dashboard-dev-secret-change-me') {
        console.warn('⚠️  Using default SESSION_SECRET — set SESSION_SECRET in production.');
    }
    console.log(`🔗 PrimeBot Dashboard redirect URI: ${REDIRECT_URI}`);
    console.log(`   Add this to your Discord app's OAuth2 redirects.`);
}

// Resolve the bot's real user ID once (idempotent). Runs eagerly on boot and is
// also called lazily by /api/me so serverless cold starts still resolve it.
let botSelfPromise = null;
function resolveBotSelf() {
    if (botSelfPromise) return botSelfPromise;
    if (!process.env.DISCORD_TOKEN && !process.env.DASHBOARD_BOT_TOKEN) return Promise.resolve(null);
    botSelfPromise = (async () => {
        try {
            const self = await discord.getBotSelf();
            botSelf = self;
            botUserId = self.id;
            console.log(`🤖 Connected as bot user ${self.username} (${self.id})`);
            if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_ID !== self.id) {
                console.warn(`⚠️  DISCORD_CLIENT_ID (${process.env.DISCORD_CLIENT_ID}) does not match the bot token's user id (${self.id}).`);
                console.warn('   OAuth2 login uses DISCORD_CLIENT_ID; guild/channel lookups use the token.');
                console.warn('   Make sure both belong to the same application, or set DASHBOARD_BOT_TOKEN to the matching token.');
            }
            return self;
        } catch (err) {
            console.warn(`⚠️  Could not verify bot token (${err.message}). Guild/channel lookups may fail.`);
            return null;
        }
    })();
    return botSelfPromise;
}

// Kick off resolution immediately (safe — awaited lazily where needed).
resolveBotSelf();

// Only bind a listening socket when run directly (`npm run dashboard` / node).
// On Vercel the app is imported as a serverless handler — no listen() call.
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(` PrimeBot Dashboard running at ${BASE_URL}`);
        preflightCheck();
    });
}

// Exposed for Vercel's serverless runtime (@vercel/node) and for tests.
module.exports = app;
