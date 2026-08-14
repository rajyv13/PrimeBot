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
const { requireAuth, requireGuildAdmin, requireGuildAdminPage } = require('./auth');
const dashboardDb = require('./db');
const constants = require('./constants');
const pages = require('./render/pages');
const guildPages = require('./render/guild-pages');

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
    // Render the server-side login page; if ?error=... is present it shows a
    // human-readable reason (e.g. session persistence failed after Discord auth)
    // instead of silently bouncing back to Discord.
    res.type('html').send(pages.loginPage({ errorKey: req.query.error }));
});

// Starts the Discord OAuth2 flow. The login page's "Login with Discord" button
// points here (separate from /login, which now renders the page).
app.get('/auth/discord', (req, res) => {
    if (req.session && req.session.user) return res.redirect('/');
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

// ── API: public platform stats (login screen, no auth required) ─────────────
//
// Aggregated adoption numbers pulled from the bot's settings tables. Used to
// render the animated stat cards + donut charts on the login page. Every query
// degrades to zero on failure, so a DB hiccup never blocks the login screen.

app.get('/api/stats', async (req, res) => {
    try {
        await resolveBotSelf();
        // The authoritative server count is "how many guilds the bot is in",
        // fetched from Discord via REST. server_settings rows are created
        // lazily and undercount guilds that were never configured. Fall back to
        // the DB count if the REST call fails (e.g. token issue) so the page
        // never renders a misleading 0.
        const restCount = await discord.getBotGuildCount();
        const stats = await dashboardDb.getPlatformStats(restCount);
        res.json({ ...stats, bot: botSelf, clientId: process.env.DISCORD_CLIENT_ID });
    } catch (err) {
        console.error('[API] /api/stats error:', err.message);
        // Return neutral stats so the login page still renders its graphic shell.
        res.json({
            servers: 0,
            botName: constants.BOT_NAME,
            botVersion: constants.BOT_VERSION,
            features: {
                leveling: { count: 0, percent: 0 },
                welcome: { count: 0, percent: 0 },
                autoReactions: { count: 0, percent: 0 },
                broadcasts: { count: 0, percent: 0 },
            },
            welcomeBanners: 0,
            bot: botSelf,
            clientId: process.env.DISCORD_CLIENT_ID,
        });
    }
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

// ── API: update logging settings (channel, webhook, events) ─────────────────

app.patch('/api/guilds/:guildId/logging', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const allowed = [
            'enabled', 'channelId', 'webhookUrl', 'webhookName',
            'events', 'includeBots', 'color',
        ];
        const patch = {};
        for (const key of allowed) {
            if (key in req.body) patch[key] = req.body[key];
        }
        if ('enabled' in patch)     patch.enabled = Boolean(patch.enabled);
        if ('includeBots' in patch) patch.includeBots = Boolean(patch.includeBots);
        if ('channelId' in patch)   patch.channelId = patch.channelId || null;
        if ('webhookUrl' in patch)  patch.webhookUrl = patch.webhookUrl || null;
        // Basic webhook URL sanity check — must be a Discord webhook if provided.
        if (patch.webhookUrl && !/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(patch.webhookUrl)) {
            return res.status(400).json({ error: 'Webhook URL must be a valid Discord webhook URL.' });
        }
        if ('color' in patch && patch.color && !/^#[0-9a-fA-F]{6}$/.test(patch.color)) {
            return res.status(400).json({ error: 'Color must be a hex color like #5865F2.' });
        }
        const updated = await dashboardDb.upsertLoggingSettings(req.guild.id, patch);
        res.json({ logging: updated });
    } catch (err) {
        console.error('[API] update logging error:', err.message);
        res.status(500).json({ error: 'Failed to update logging settings.' });
    }
});

// ── API: Premium Automod settings + warnings ─────────────────────────────────

app.patch('/api/guilds/:guildId/automod', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const allowed = [
            'enabled', 'logChannelId', 'muteRoleId',
            'exemptRoleIds', 'exemptChannelIds', 'rules',
            'warnThreshold', 'warnAction', 'warnActions',
            'dmEnabled', 'dmMessages', 'appealChannelId',
        ];
        const patch = {};
        for (const key of allowed) {
            if (key in req.body) patch[key] = req.body[key];
        }
        if ('enabled' in patch) patch.enabled = Boolean(patch.enabled);
        if ('logChannelId' in patch) patch.logChannelId = patch.logChannelId || null;
        if ('muteRoleId' in patch) patch.muteRoleId = patch.muteRoleId || null;
        if ('warnThreshold' in patch) patch.warnThreshold = parseInt(patch.warnThreshold, 10) || 3;
        if ('warnAction' in patch && !['warn', 'timeout', 'kick', 'ban'].includes(patch.warnAction)) {
            return res.status(400).json({ error: 'warnAction must be warn, timeout, kick, or ban.' });
        }
        if ('warnActions' in patch) {
            const wa = Array.isArray(patch.warnActions) ? patch.warnActions : [];
            const valid = wa.filter(a => ['warn', 'timeout', 'kick', 'ban'].includes(a));
            if (valid.length === 0) {
                return res.status(400).json({ error: 'warnActions must contain at least one of warn, timeout, kick, ban.' });
            }
            patch.warnActions = valid;
        }
        if ('dmEnabled' in patch) patch.dmEnabled = patch.dmEnabled !== false;
        if ('appealChannelId' in patch) patch.appealChannelId = patch.appealChannelId || null;
        const updated = await dashboardDb.upsertAutomodSettings(req.guild.id, patch);
        res.json({ automod: updated });
    } catch (err) {
        console.error('[API] update automod error:', err.message);
        res.status(500).json({ error: 'Failed to update automod settings.' });
    }
});

app.get('/api/guilds/:guildId/automod/warnings', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const warnings = await dashboardDb.getAutomodWarnings(req.guild.id);
        res.json({ warnings });
    } catch (err) {
        console.error('[API] get automod warnings error:', err.message);
        res.status(500).json({ error: 'Failed to load warnings.' });
    }
});

app.delete('/api/guilds/:guildId/automod/warnings', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const userId = req.query.userId || null;
        await dashboardDb.clearAutomodWarnings(req.guild.id, userId);
        res.json({ ok: true });
    } catch (err) {
        console.error('[API] clear automod warnings error:', err.message);
        res.status(500).json({ error: 'Failed to clear warnings.' });
    }
});

// ── API: Automod appeals ─────────────────────────────────────────────────────

app.get('/api/guilds/:guildId/automod/appeals', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const status = req.query.status || null;
        const appeals = await dashboardDb.getAutomodAppeals(req.guild.id, { status });
        res.json({ appeals });
    } catch (err) {
        console.error('[API] get automod appeals error:', err.message);
        res.status(500).json({ error: 'Failed to load appeals.' });
    }
});

app.post('/api/guilds/:guildId/automod/appeals', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const userId = String(req.body?.userId || '').trim();
        const action = String(req.body?.action || '').trim();
        const reason = String(req.body?.reason || '').trim();
        if (!userId || !action) {
            return res.status(400).json({ error: 'userId and action are required.' });
        }
        const appeal = await dashboardDb.submitAutomodAppeal(req.guild.id, { userId, action, reason });
        res.json({ appeal });
    } catch (err) {
        console.error('[API] submit automod appeal error:', err.message);
        res.status(500).json({ error: 'Failed to submit appeal.' });
    }
});

app.patch('/api/guilds/:guildId/automod/appeals/:id', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const approved = req.body?.approved === true || req.body?.decision === 'approved';
        const note = String(req.body?.note || '').trim();
        const decidedBy = req.user?.discordId || null;
        const appeal = await dashboardDb.decideAutomodAppeal(id, { approved, decidedBy, note });
        if (!appeal) return res.status(404).json({ error: 'Appeal not found or already decided.' });
        // Ask the bot to reverse the action when approved (the bot reads the
        // status change on its next reload; reversal is best-effort).
        res.json({ appeal });
    } catch (err) {
        console.error('[API] decide automod appeal error:', err.message);
        res.status(500).json({ error: 'Failed to decide appeal.' });
    }
});

// ── API: guild roles (for reaction-role selectors) ──────────────────────────

app.get('/api/guilds/:guildId/roles', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const roles = await discord.getGuildRoles(req.guild.id);
        // Only return roles the bot can assign (below its highest role) and
        // integrations-managed roles can't be assigned by bots anyway — we
        // surface position + color so the SPA can render.
        res.json({ roles: roles.map(r => ({
            id: r.id, name: r.name, position: r.position, color: r.color,
            mentionable: r.mentionable, hoist: r.hoist,
        })) });
    } catch (err) {
        console.error('[API] get roles error:', err.message);
        res.status(500).json({ error: 'Failed to load roles. Make sure PrimeBot has the Manage Roles permission.' });
    }
});

// ── API: reaction-role menus ────────────────────────────────────────────────
//
// Two creation flows mirror the /reactionrole slash command:
//   POST .../reactionroles  { attach: false, channelId, title, description,
//                            color, mode, mappings, ... }
//       → dashboard posts the embed via REST, captures the message id, persists
//         the row; the bot starts watching on its next cache reload.
//   POST .../reactionroles  { attach: true, channelId, messageId, mappings, ... }
//       → dashboard validates the message exists, adds the reactions via REST,
//         and persists the row.
//   PATCH .../reactionroles/:id   { ...patch }   edit settings/mappings
//   DELETE .../reactionroles/:id                  delete (and remove the bot's
//                                                 embed message if it sent it)

function rrEmojiDisplay(emoji) {
    if (/^\w+:\d+$/.test(emoji)) return `<:${emoji}>`;
    return emoji;
}

function rrEmbedPayload(menu) {
    const color = parseInt((menu.color || '#5865F2').replace('#', ''), 16);
    const fields = (menu.mappings || []).length
        ? [{ name: 'Roles', value: (menu.mappings || []).map(m => `${rrEmojiDisplay(m.emoji)} → <@&${m.roleId}>${m.label ? ` — ${m.label}` : ''}`).join('\n') }]
        : [];
    return {
        embeds: [{
            title: menu.title || 'Reaction Roles',
            description: menu.description || 'React to get a role!',
            color,
            fields,
            footer: { text: 'PrimeBot · Reaction Roles' },
        }],
    };
}

app.get('/api/guilds/:guildId/reactionroles', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const menus = await dashboardDb.getReactionRoles(req.guild.id);
        res.json({ reactionRoles: menus });
    } catch (err) {
        console.error('[API] get reaction roles error:', err.message);
        res.status(500).json({ error: 'Failed to load reaction roles.' });
    }
});

app.post('/api/guilds/:guildId/reactionroles', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const mappings = Array.isArray(body.mappings) ? body.mappings : [];
        if (mappings.length === 0) {
            return res.status(400).json({ error: 'Add at least one emoji→role mapping.' });
        }
        if (!body.channelId) {
            return res.status(400).json({ error: 'A channel is required.' });
        }

        // Normalize mappings through the dashboard's parser (dedupe + parse
        // custom-emoji mention form). The bot will re-normalize on its side.
        const cleanMappings = mappings.map(m => ({
            emoji: m.emoji, roleId: m.roleId, label: m.label || null,
        })).filter(m => m.emoji && m.roleId);

        const attach = !!body.attach;
        let messageId = body.messageId || null;

        if (attach) {
            if (!messageId) {
                return res.status(400).json({ error: 'A message ID is required to attach to an existing message.' });
            }
            // Validate the target message exists and the bot can see it.
            try {
                await discord.getChannelMessage(body.channelId, messageId);
            } catch (err) {
                return res.status(400).json({ error: 'Could not find that message. Make sure the bot can see the channel and message.' });
            }
            // Add the reactions to the existing message.
            for (const m of cleanMappings) {
                await discord.addMessageReaction(body.channelId, messageId, parseEmojiForDiscord(m.emoji)).catch(() => {});
            }
        } else {
            // Bot-created menu: post the embed via REST and capture the id.
            const menuForEmbed = {
                title: body.title, description: body.description,
                color: body.color, mappings: cleanMappings,
            };
            const sent = await discord.sendChannelMessage(body.channelId, rrEmbedPayload(menuForEmbed));
            messageId = sent.id;
            for (const m of cleanMappings) {
                await discord.addMessageReaction(body.channelId, messageId, parseEmojiForDiscord(m.emoji)).catch(() => {});
            }
        }

        const menu = await dashboardDb.createReactionRole(req.guild.id, {
            guildId: req.guild.id,
            channelId: body.channelId,
            messageId,
            title: body.title || null,
            description: attach ? null : (body.description || null),
            color: body.color || '#5865F2',
            mode: body.mode || 'normal',
            persistent: body.persistent !== false,
            includeBots: !!body.includeBots,
            requiredRoleId: body.requiredRoleId || null,
            exclusiveRoleId: body.exclusiveRoleId || null,
            mappings: cleanMappings,
            attach,
        });
        res.json({ reactionRole: menu });
    } catch (err) {
        console.error('[API] create reaction role error:', err.message);
        res.status(500).json({ error: 'Failed to create reaction role: ' + err.message });
    }
});

app.patch('/api/guilds/:guildId/reactionroles/:id', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid menu id.' });
        const body = req.body || {};
        const patch = {};
        for (const key of ['title', 'description', 'color', 'mode', 'persistent', 'includeBots', 'requiredRoleId', 'exclusiveRoleId', 'enabled', 'mappings']) {
            if (key in body) patch[key] = body[key];
        }
        const menu = await dashboardDb.updateReactionRole(id, patch);

        // If mappings or embed-visible fields changed on a bot-created menu,
        // re-render the embed and reconcile the reactions on the live message.
        const embedKeys = ['title', 'description', 'color', 'mappings'];
        if (embedKeys.some(k => k in patch) && menu && menu.messageId && menu.description != null) {
            try {
                await discord.editChannelMessage(menu.channelId, menu.messageId, rrEmbedPayload(menu));
            } catch (err) {
                console.error('[API] edit reaction-role embed failed:', err.message);
            }
            if (Array.isArray(patch.mappings)) {
                // Re-add all configured reactions (idempotent).
                for (const m of menu.mappings) {
                    await discord.addMessageReaction(menu.channelId, menu.messageId, parseEmojiForDiscord(m.emoji)).catch(() => {});
                }
            }
        }

        res.json({ reactionRole: menu });
    } catch (err) {
        console.error('[API] update reaction role error:', err.message);
        res.status(500).json({ error: 'Failed to update reaction role: ' + err.message });
    }
});

app.delete('/api/guilds/:guildId/reactionroles/:id', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid menu id.' });
        const menus = await dashboardDb.getReactionRoles(req.guild.id);
        const menu = menus.find(m => m.id === id);
        await dashboardDb.deleteReactionRole(id);
        // If the bot created the embed (description != null), delete the message.
        if (menu && menu.messageId && menu.description != null) {
            await discord.deleteChannelMessage(menu.channelId, menu.messageId).catch(() => {});
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('[API] delete reaction role error:', err.message);
        res.status(500).json({ error: 'Failed to delete reaction role.' });
    }
});

// Convert a stored/entered emoji into the form Discord's reactions route wants.
// Custom emojis stored as "name:id" are accepted; the route uses the same form.
function parseEmojiForDiscord(emoji) {
    return emoji;
}

// ── API: ticket panels ──────────────────────────────────────────────────────
//
// Ticket panels are configurable ONLY from the dashboard (slash/prefix commands
// are disabled). The dashboard writes the DB row directly; the bot's
// TicketPanelManager picks it up on its cache reload.
//
//   GET    .../tickets                         list panels
//   POST   .../tickets                         create a panel
//   PATCH  .../tickets/:id                     edit a panel
//   DELETE .../tickets/:id                      delete a panel
//   POST   .../tickets/:id/clone               clone a panel under a new name
//   POST   .../tickets/:id/rename              rename a panel
//   POST   .../tickets/:id/send                send panel to a channel (capturing message id)
//   POST   .../tickets/:id/update              re-render an existing message by id ("update panel")

// Build the panel message payload (embed or plain) + the open-ticket button
// row, matching the bot's TicketPanelManager.buildPanelMessage so the dashboard
// posts exactly what the bot would.
function ticketPanelMessagePayload(panel) {
    const color = parseInt((panel.color || '#5865F2').replace('#', ''), 16);
    const buttonEmoji = panel.buttonEmoji || undefined;
    const styleMap = { Primary: 1, Secondary: 2, Success: 3, Danger: 4 };
    const buttonStyle = styleMap[panel.buttonStyle] || 1;
    const components = [{
        type: 1, // ActionRow
        components: [{
            type: 2, // Button
            style: buttonStyle,
            custom_id: `ticketpanel:open:${panel.id}`,
            label: panel.buttonLabel || 'Open Ticket',
            ...(buttonEmoji ? { emoji: { name: buttonEmoji } } : {}),
        }],
    }];
    if (panel.messageType === 'plain') {
        return {
            content: panel.content || panel.description || 'Click the button below to open a support ticket.',
            components,
        };
    }
    const embed = {
        title: panel.title || '🎫 Support Tickets',
        description: panel.description || 'Click the button below to open a support ticket.',
        color,
        ...(panel.footerText ? { footer: { text: panel.footerText } } : {}),
        ...(panel.thumbnailUrl ? { thumbnail: { url: panel.thumbnailUrl } } : {}),
        ...(panel.imageUrl ? { image: { url: panel.imageUrl } } : {}),
        timestamp: new Date().toISOString(),
    };
    return { content: panel.content || null, embeds: [embed], components };
}

app.get('/api/guilds/:guildId/tickets', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const panels = await dashboardDb.getTicketPanels(req.guild.id);
        res.json({ ticketPanels: panels });
    } catch (err) {
        console.error('[API] get ticket panels error:', err.message);
        res.status(500).json({ error: 'Failed to load ticket panels.' });
    }
});

app.post('/api/guilds/:guildId/tickets', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        if (!body.name || !String(body.name).trim()) {
            return res.status(400).json({ error: 'A panel name is required.' });
        }
        const panel = await dashboardDb.createTicketPanel(req.guild.id, { ...body, createdBy: req.user.id });
        res.json({ ticketPanel: panel });
    } catch (err) {
        console.error('[API] create ticket panel error:', err.message);
        res.status(500).json({ error: 'Failed to create ticket panel: ' + err.message });
    }
});

app.patch('/api/guilds/:guildId/tickets/:id', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid panel id.' });
        const panel = await dashboardDb.updateTicketPanel(id, req.body || {});
        // If the panel was already sent and embed-visible fields changed,
        // re-render the live message so it stays in sync.
        if (panel && panel.messageId && panel.channelId) {
            try {
                await discord.editChannelMessage(panel.channelId, panel.messageId, ticketPanelMessagePayload(panel));
            } catch (err) {
                console.error('[API] edit ticket panel message failed:', err.message);
            }
        }
        res.json({ ticketPanel: panel });
    } catch (err) {
        console.error('[API] update ticket panel error:', err.message);
        res.status(500).json({ error: 'Failed to update ticket panel: ' + err.message });
    }
});

app.delete('/api/guilds/:guildId/tickets/:id', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid panel id.' });
        const panels = await dashboardDb.getTicketPanels(req.guild.id);
        const panel = panels.find(p => p.id === id);
        await dashboardDb.deleteTicketPanel(id);
        if (panel && panel.messageId && panel.channelId) {
            await discord.deleteChannelMessage(panel.channelId, panel.messageId).catch(() => {});
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('[API] delete ticket panel error:', err.message);
        res.status(500).json({ error: 'Failed to delete ticket panel.' });
    }
});

app.post('/api/guilds/:guildId/tickets/:id/clone', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid panel id.' });
        const name = (req.body && req.body.name) || null;
        const panel = await dashboardDb.cloneTicketPanel(id, name);
        res.json({ ticketPanel: panel });
    } catch (err) {
        console.error('[API] clone ticket panel error:', err.message);
        res.status(500).json({ error: 'Failed to clone ticket panel: ' + err.message });
    }
});

app.post('/api/guilds/:guildId/tickets/:id/rename', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid panel id.' });
        const name = req.body && req.body.name;
        const panel = await dashboardDb.renameTicketPanel(id, name);
        res.json({ ticketPanel: panel });
    } catch (err) {
        console.error('[API] rename ticket panel error:', err.message);
        res.status(500).json({ error: 'Failed to rename ticket panel: ' + err.message });
    }
});

// Send the panel to a channel: post the panel message via REST and store the
// resulting channel/message id on the panel so the bot can later "update" it.
app.post('/api/guilds/:guildId/tickets/:id/send', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid panel id.' });
        const channelId = req.body && req.body.channelId;
        if (!channelId) return res.status(400).json({ error: 'A channel is required.' });
        const panel = await dashboardDb.updateTicketPanel(id, { channelId, enabled: true });
        const sent = await discord.sendChannelMessage(channelId, ticketPanelMessagePayload(panel));
        const updated = await dashboardDb.updateTicketPanel(id, { channelId, messageId: sent.id });
        res.json({ ticketPanel: updated });
    } catch (err) {
        console.error('[API] send ticket panel error:', err.message);
        res.status(500).json({ error: 'Failed to send ticket panel: ' + err.message });
    }
});

// Re-render an existing panel message by id (the "update panel" button). The
// messageId may be the panel's stored one or a new one supplied in the body.
app.post('/api/guilds/:guildId/tickets/:id/update', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid panel id.' });
        const panels = await dashboardDb.getTicketPanels(req.guild.id);
        const panel = panels.find(p => p.id === id);
        if (!panel) return res.status(404).json({ error: 'Ticket panel not found.' });
        const messageId = (req.body && req.body.messageId) || panel.messageId;
        const channelId = (req.body && req.body.channelId) || panel.channelId;
        if (!messageId) return res.status(400).json({ error: 'No message id. Send the panel to a channel first, or provide a message id.' });
        if (!channelId) return res.status(400).json({ error: 'No channel bound to this panel.' });
        // Validate the message exists.
        try {
            await discord.getChannelMessage(channelId, messageId);
        } catch (err) {
            return res.status(400).json({ error: 'Could not find that message. Make sure the bot can see the channel and message.' });
        }
        await discord.editChannelMessage(channelId, messageId, ticketPanelMessagePayload(panel));
        const updated = await dashboardDb.updateTicketPanel(id, { channelId, messageId });
        res.json({ ticketPanel: updated });
    } catch (err) {
        console.error('[API] update ticket panel message error:', err.message);
        res.status(500).json({ error: 'Failed to update ticket panel message: ' + err.message });
    }
});

// ── API: Live polls + live giveaways (Live page) ─────────────────────────────
//
// Read-only listing of all running and ended live polls and live giveaways.
// Live polls live in the main DB; live giveaways live in the LIVE_DATABASE_URL
// pool. The "Live" SPA page renders these in two panels, each with separate
// running and ended divs. Only ended items expose winners.

app.get('/api/live', requireAuth, async (req, res) => {
    try {
        const [polls, giveaways, endedPolls, endedGiveaways] = await Promise.all([
            dashboardDb.getLivePolls(),
            dashboardDb.getLiveGiveaways(),
            dashboardDb.getEndedLivePolls(),
            dashboardDb.getEndedLiveGiveaways(),
        ]);
        const runningPolls = polls.filter(p => p.isActive);
        const runningGiveaways = giveaways.filter(g => g.isActive && !g.ended);
        res.json({
            runningPolls,
            endedPolls,
            runningGiveaways,
            endedGiveaways,
        });
    } catch (err) {
        console.error('[API] /api/live error:', err.message);
        res.status(500).json({ error: 'Failed to load live data.' });
    }
});

// ── API: Event management (📅 Events tab) ────────────────────────────────────

app.get('/api/guilds/:guildId/events', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const schedules = await dashboardDb.getEventSchedules(req.guild.id);
        res.json({ schedules });
    } catch (err) {
        console.error('[API] get events error:', err.message);
        res.status(500).json({ error: 'Failed to load events.' });
    }
});

app.post('/api/guilds/:guildId/events', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const schedule = await dashboardDb.createEventSchedule(req.guild.id, req.body || {}, req.user.id);
        res.json({ schedule });
    } catch (err) {
        console.error('[API] create event error:', err.message);
        res.status(500).json({ error: 'Failed to create event: ' + err.message });
    }
});

app.patch('/api/guilds/:guildId/events/:id', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid event id.' });
        const schedule = await dashboardDb.updateEventSchedule(id, req.body || {});
        res.json({ schedule });
    } catch (err) {
        console.error('[API] update event error:', err.message);
        res.status(500).json({ error: 'Failed to update event: ' + err.message });
    }
});

app.delete('/api/guilds/:guildId/events/:id', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid event id.' });
        await dashboardDb.deleteEventSchedule(id);
        res.json({ ok: true });
    } catch (err) {
        console.error('[API] delete event error:', err.message);
        res.status(500).json({ error: 'Failed to delete event.' });
    }
});

app.post('/api/guilds/:guildId/events/:id/start', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid event id.' });
        await dashboardDb.startEventSchedule(id);
        res.json({ ok: true });
    } catch (err) {
        console.error('[API] start event error:', err.message);
        res.status(500).json({ error: 'Failed to start event: ' + err.message });
    }
});

app.post('/api/guilds/:guildId/events/:id/cancel', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid event id.' });
        await dashboardDb.cancelEventSchedule(id);
        res.json({ ok: true });
    } catch (err) {
        console.error('[API] cancel event error:', err.message);
        res.status(500).json({ error: 'Failed to cancel event.' });
    }
});

// ── Page routes (server-rendered multi-page app) ────────────────────────────
//
// Each route renders its own real HTML page. The old SPA's single index.html +
// client-side pushState router is gone; /api/* JSON routes remain for the
// per-page client scripts to save settings.

// Build the manageable-guild list for the servers overview. Shared with the
// /api/guilds handler so the page and API stay consistent.
async function loadManageableGuilds(req) {
    const accessToken = req.session.accessToken;
    let guilds = req.session.guilds;
    const fetchedAt = req.session.guildsFetchedAt || 0;
    const cacheFresh = Array.isArray(guilds) && Date.now() - fetchedAt <= 5 * 60 * 1000;
    if (!cacheFresh) {
        if (!accessToken) {
            if (!Array.isArray(guilds)) guilds = [];
        } else {
            try {
                guilds = await discord.getUserGuilds(accessToken);
            } catch (err) {
                if (req.session.refreshToken) {
                    try {
                        const tokens = await discord.refreshToken(req.session.refreshToken);
                        req.session.accessToken = tokens.access_token;
                        req.session.refreshToken = tokens.refresh_token || req.session.refreshToken;
                        req.session.tokenExpiresAt = Date.now() + (tokens.expires_in * 1000);
                        guilds = await discord.getUserGuilds(tokens.access_token);
                    } catch (refreshErr) {
                        console.warn('[PAGE] token refresh failed:', refreshErr.message);
                        if (!Array.isArray(guilds)) guilds = [];
                    }
                } else {
                    console.warn('[PAGE] getUserGuilds failed and no refresh token:', err.message);
                    if (!Array.isArray(guilds)) guilds = [];
                }
            }
            req.session.guilds = guilds;
            req.session.guildsFetchedAt = Date.now();
        }
    }
    const manageable = guilds.filter(g => discord.canManageGuild(g.permissions));
    const result = await Promise.all(manageable.slice(0, 50).map(async (g) => {
        let botInGuild = false;
        let config = null;
        try {
            await discord.getBotGuild(g.id);
            botInGuild = true;
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
    return result;
}

// Login route is handled above (renders the login page). The root and /dashboard
// both render the servers overview (requires a session; otherwise redirect to
// the login page).
app.get(['/', '/dashboard'], requireAuth, async (req, res) => {
    try {
        const guilds = await loadManageableGuilds(req);
        res.type('html').send(pages.overviewPage({
            guilds,
            clientId: process.env.DISCORD_CLIENT_ID,
            user: req.user,
        }));
    } catch (err) {
        console.error('[PAGE] overview error:', err.message);
        res.type('html').send(pages.notFoundPage({ user: req.session && req.session.user }));
    }
});

app.get('/docs', requireAuth, (req, res) => {
    res.type('html').send(pages.docsPage({ clientId: process.env.DISCORD_CLIENT_ID, user: req.user }));
});

app.get('/live', requireAuth, (req, res) => {
    res.type('html').send(pages.livePage({ user: req.user }));
});

// Guild settings: each tab is its own page. requireGuildAdminPage fetches
// channels/roles/config so the page is pre-populated server-side. Redirect
// bare /guild/:id to the welcome tab.
app.get('/guild/:guildId', (req, res) => res.redirect(`/guild/${req.params.guildId}/welcome`));

app.get('/guild/:guildId/welcome', requireAuth, requireGuildAdminPage, (req, res) =>
    res.type('html').send(guildPages.welcomePage({ guild: req.guild, user: req.user })));
app.get('/guild/:guildId/leveling', requireAuth, requireGuildAdminPage, (req, res) =>
    res.type('html').send(guildPages.levelingPage({ guild: req.guild, user: req.user })));
app.get('/guild/:guildId/prefix', requireAuth, requireGuildAdminPage, (req, res) =>
    res.type('html').send(guildPages.prefixPage({ guild: req.guild, user: req.user })));
app.get('/guild/:guildId/reactions', requireAuth, requireGuildAdminPage, (req, res) =>
    res.type('html').send(guildPages.reactionsPage({ guild: req.guild, user: req.user })));
app.get('/guild/:guildId/reactionroles', requireAuth, requireGuildAdminPage, (req, res) =>
    res.type('html').send(guildPages.reactionRolesPage({ guild: req.guild, user: req.user })));
app.get('/guild/:guildId/broadcast', requireAuth, requireGuildAdminPage, (req, res) =>
    res.type('html').send(guildPages.broadcastPage({ guild: req.guild, user: req.user })));
app.get('/guild/:guildId/logging', requireAuth, requireGuildAdminPage, (req, res) =>
    res.type('html').send(guildPages.loggingPage({ guild: req.guild, user: req.user })));
app.get('/guild/:guildId/automod', requireAuth, requireGuildAdminPage, (req, res) =>
    res.type('html').send(guildPages.automodPage({ guild: req.guild, user: req.user })));
app.get('/guild/:guildId/tickets', requireAuth, requireGuildAdminPage, (req, res) =>
    res.type('html').send(guildPages.ticketsPage({ guild: req.guild, user: req.user })));
app.get('/guild/:guildId/events', requireAuth, requireGuildAdminPage, (req, res) =>
    res.type('html').send(guildPages.eventsPage({ guild: req.guild, user: req.user })));

// ── Health check ────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({ ok: true, name: constants.BOT_NAME, version: constants.BOT_VERSION });
});

// ── 404 / error handlers ────────────────────────────────────────────────────

app.use((req, res) => {
    if (req.accepts('html')) return res.status(404).type('html').send(pages.notFoundPage({ user: req.session && req.session.user }));
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
