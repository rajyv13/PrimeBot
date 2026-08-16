/**
 * Database access for the dashboard.
 *
 * Reuses the bot's existing pg pools so the dashboard reads/writes the exact
 * same rows the bot's managers use. Pools are involved:
 *   - pool            → server_settings (prefix, leveling, auto-reactions, broadcast)
 *   - welcomePool     → welcome_settings (welcome messages/banners/DM)
 *   - reactionPool    → reaction_roles + reaction_role_mappings
 *   - automodPool     → automod_settings + automod_warnings (AUTOMOD_DATABASE_URL,
 *                       falls back to DATABASE_URL)
 *
 * All are created lazily in server/db.js, server/welcomeDb.js,
 * server/reactionDb.js, and server/automodDb.js, so if an env var is missing
 * the pool still exists (queries will just fail and we surface that to the
 * dashboard UI gracefully).
 */

const { pool } = require('../server/db');

let welcomePool = null;
function getWelcomePool() {
    if (welcomePool) return welcomePool;
    try {
        welcomePool = require('../server/welcomeDb').welcomePool;
    } catch (err) {
        console.error('[DASHBOARD DB] welcomeDb unavailable:', err.message);
        welcomePool = { query: async () => { throw new Error('Welcome database not configured'); } };
    }
    return welcomePool;
}

let automodPool = null;
function getAutomodPool() {
    if (automodPool) return automodPool;
    try {
        automodPool = require('../server/automodDb').automodPool;
    } catch (err) {
        console.error('[DASHBOARD DB] automodDb unavailable:', err.message);
        automodPool = { query: async () => { throw new Error('Automod database not configured'); } };
    }
    return automodPool;
}

let ticketPool = null;
function getTicketPool() {
    if (ticketPool) return ticketPool;
    try {
        ticketPool = require('../server/ticketDb').ticketPool;
    } catch (err) {
        console.error('[DASHBOARD DB] ticketDb unavailable:', err.message);
        ticketPool = { query: async () => { throw new Error('Ticket database not configured'); } };
    }
    return ticketPool;
}

let livePool = null;
function getLivePool() {
    if (livePool) return livePool;
    try {
        livePool = require('../server/liveDb').livePool;
    } catch (err) {
        console.error('[DASHBOARD DB] liveDb unavailable:', err.message);
        livePool = { query: async () => { throw new Error('Live database not configured'); } };
    }
    return livePool;
}

let eventPool = null;
function getEventPool() {
    if (eventPool) return eventPool;
    try {
        eventPool = require('../server/eventDb').eventPool;
    } catch (err) {
        console.error('[DASHBOARD DB] eventDb unavailable:', err.message);
        eventPool = { query: async () => { throw new Error('Event database not configured'); } };
    }
    return eventPool;
}

let levelingPool = null;
function getLevelingPool() {
    if (levelingPool) return levelingPool;
    try {
        levelingPool = require('../server/levelingDb').levelingPool;
    } catch (err) {
        console.error('[DASHBOARD DB] levelingDb unavailable:', err.message);
        levelingPool = { query: async () => { throw new Error('Leveling database not configured'); } };
    }
    return levelingPool;
}

async function ensureLevelingRoleRewardsTable() {
    await getLevelingPool().query(`
        CREATE TABLE IF NOT EXISTS leveling_role_rewards (
            id          SERIAL PRIMARY KEY,
            guild_id    VARCHAR(50) NOT NULL,
            level       INTEGER NOT NULL,
            role_id     VARCHAR(50) NOT NULL,
            created_at  TIMESTAMP DEFAULT NOW(),
            UNIQUE (guild_id, level)
        );
        CREATE INDEX IF NOT EXISTS leveling_role_rewards_guild_idx
            ON leveling_role_rewards (guild_id);
    `);
}

async function getLevelingRoleRewards(guildId) {
    await ensureLevelingRoleRewardsTable();
    const res = await getLevelingPool().query(
        'SELECT level, role_id FROM leveling_role_rewards WHERE guild_id = $1 ORDER BY level',
        [guildId]
    );
    return res.rows.map(r => ({ level: Number(r.level), roleId: String(r.role_id) }));
}

async function setLevelingRoleRewards(guildId, rewards) {
    await ensureLevelingRoleRewardsTable();
    const pool = getLevelingPool();
    await pool.query('DELETE FROM leveling_role_rewards WHERE guild_id = $1', [guildId]);
    for (const r of Array.isArray(rewards) ? rewards : []) {
        const level = parseInt(r.level, 10);
        const roleId = String(r.roleId || r.role_id || '');
        if (Number.isFinite(level) && roleId) {
            await pool.query(
                `INSERT INTO leveling_role_rewards (guild_id, level, role_id, created_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (guild_id, level) DO UPDATE SET role_id = EXCLUDED.role_id`,
                [guildId, level, roleId]
            );
        }
    }
    return getLevelingRoleRewards(guildId);
}

const config = require('../config');
const constants = require('./constants');
const { normalizeGuildPrefix } = require('../utils/prefixHelper');
const { normalizeEvents, DEFAULT_ENABLED_EVENTS } = require('../utils/logEvents');
const { normalizeRules, normalizeAction, normalizeWarnActions, normalizeDmMessages } = require('../utils/automodRules');

// ── server_settings (prefix, leveling, auto-reactions, broadcast) ────────────

const SERVER_SETTINGS_COLUMNS = `
    guild_id,
    prefix,
    receive_broadcasts,
    broadcast_channel_id,
    leveling_enabled,
    leveling_channel_id,
    xp_multiplier,
    xp_cooldown,
    auto_reactions_enabled,
    auto_reactions,
    no_prefix_users,
    updated_at
`;

async function ensureServerSettingsTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS server_settings (
            guild_id              VARCHAR(50) PRIMARY KEY,
            receive_broadcasts    BOOLEAN NOT NULL DEFAULT true,
            broadcast_channel_id  VARCHAR(50),
            leveling_enabled      BOOLEAN NOT NULL DEFAULT true,
            leveling_channel_id   VARCHAR(50),
            xp_multiplier         REAL NOT NULL DEFAULT 1.0,
            xp_cooldown           INTEGER NOT NULL DEFAULT 60000,
            auto_reactions_enabled BOOLEAN NOT NULL DEFAULT false,
            auto_reactions         JSONB NOT NULL DEFAULT '[]',
            no_prefix_users        JSONB NOT NULL DEFAULT '{}',
            prefix                 VARCHAR(10) DEFAULT '${config.prefix}',
            updated_at             TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS prefix VARCHAR(10) DEFAULT '${config.prefix}'`);
}

async function getServerSettings(guildId) {
    await ensureServerSettingsTable();
    const res = await pool.query(`SELECT ${SERVER_SETTINGS_COLUMNS} FROM server_settings WHERE guild_id = $1`, [guildId]);
    if (res.rows.length === 0) return defaultServerSettings();
    return rowToServerSettings(res.rows[0]);
}

async function upsertServerSettings(guildId, patch) {
    await ensureServerSettingsTable();
    const current = await getServerSettings(guildId);
    const merged = { ...current, ...patch };

    // Normalize nested objects back to JSON strings.
    const autoReactions = JSON.stringify(merged.autoReactions?.reactions || []);
    const autoReactionsEnabled = merged.autoReactions?.enabled ?? false;
    const noPrefixUsers = JSON.stringify(merged.noPrefixUsers || {});
    const prefix = normalizeGuildPrefix(merged.prefix, config.prefix);
    const levelingEnabled = merged.leveling?.enabled ?? true;
    const levelingChannelId = merged.leveling?.levelUpChannelId ?? null;
    const xpMultiplier = Number(merged.leveling?.xpMultiplier) || 1.0;
    const xpCooldown = Number(merged.leveling?.xpCooldown) || 60000;

    await pool.query(`
        INSERT INTO server_settings (
            guild_id, prefix, receive_broadcasts, broadcast_channel_id,
            leveling_enabled, leveling_channel_id, xp_multiplier, xp_cooldown,
            auto_reactions_enabled, auto_reactions, no_prefix_users, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
        ON CONFLICT (guild_id) DO UPDATE SET
            prefix                 = EXCLUDED.prefix,
            receive_broadcasts     = EXCLUDED.receive_broadcasts,
            broadcast_channel_id   = EXCLUDED.broadcast_channel_id,
            leveling_enabled       = EXCLUDED.leveling_enabled,
            leveling_channel_id    = EXCLUDED.leveling_channel_id,
            xp_multiplier          = EXCLUDED.xp_multiplier,
            xp_cooldown            = EXCLUDED.xp_cooldown,
            auto_reactions_enabled = EXCLUDED.auto_reactions_enabled,
            auto_reactions         = EXCLUDED.auto_reactions,
            no_prefix_users        = EXCLUDED.no_prefix_users,
            updated_at             = NOW()
    `, [
        guildId, prefix,
        merged.receiveBroadcasts ?? true,
        merged.broadcastChannelId ?? null,
        levelingEnabled, levelingChannelId, xpMultiplier, xpCooldown,
        autoReactionsEnabled, autoReactions, noPrefixUsers,
    ]);

    return getServerSettings(guildId);
}

function defaultServerSettings() {
    return {
        prefix: config.prefix,
        receiveBroadcasts: true,
        broadcastChannelId: null,
        leveling: {
            enabled: true,
            levelUpChannelId: null,
            xpMultiplier: 1.0,
            xpCooldown: 60000,
        },
        autoReactions: { enabled: false, reactions: [] },
        noPrefixUsers: {},
    };
}

function rowToServerSettings(row) {
    return {
        prefix: normalizeGuildPrefix(row.prefix, config.prefix),
        receiveBroadcasts: row.receive_broadcasts,
        broadcastChannelId: row.broadcast_channel_id || null,
        leveling: {
            enabled: row.leveling_enabled,
            levelUpChannelId: row.leveling_channel_id || null,
            xpMultiplier: parseFloat(row.xp_multiplier) || 1.0,
            xpCooldown: row.xp_cooldown || 60000,
        },
        autoReactions: {
            enabled: row.auto_reactions_enabled,
            reactions: row.auto_reactions || [],
        },
        noPrefixUsers: row.no_prefix_users || {},
    };
}

// ── welcome_settings ────────────────────────────────────────────────────────

async function ensureWelcomeTable() {
    await getWelcomePool().query(`
        CREATE TABLE IF NOT EXISTS welcome_settings (
            guild_id              VARCHAR(50) PRIMARY KEY,
            enabled               BOOLEAN NOT NULL DEFAULT false,
            channel_id            VARCHAR(50),
            message               TEXT DEFAULT 'Welcome to the server, {member}! Enjoy your stay!',
            banner_url            TEXT,
            color                 VARCHAR(20) DEFAULT '#5865F2',
            dm_enabled            BOOLEAN NOT NULL DEFAULT false,
            dm_message            TEXT DEFAULT 'Hey {username}! Welcome to **{server}**!',
            show_member_count     BOOLEAN NOT NULL DEFAULT true,
            show_join_date        BOOLEAN NOT NULL DEFAULT true,
            show_account_age      BOOLEAN NOT NULL DEFAULT true,
            custom_title          VARCHAR(255),
            custom_footer         VARCHAR(255),
            updated_at            TIMESTAMP DEFAULT NOW()
        )
    `);
}

async function getWelcomeSettings(guildId) {
    await ensureWelcomeTable();
    const res = await getWelcomePool().query(`SELECT * FROM welcome_settings WHERE guild_id = $1`, [guildId]);
    if (res.rows.length === 0) return defaultWelcomeSettings();
    return rowToWelcomeSettings(res.rows[0]);
}

async function upsertWelcomeSettings(guildId, patch) {
    await ensureWelcomeTable();
    const current = await getWelcomeSettings(guildId);
    const merged = { ...current, ...patch };

    await getWelcomePool().query(`
        INSERT INTO welcome_settings (
            guild_id, enabled, channel_id, message, banner_url, color,
            dm_enabled, dm_message,
            show_member_count, show_join_date, show_account_age,
            custom_title, custom_footer, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
        ON CONFLICT (guild_id) DO UPDATE SET
            enabled           = EXCLUDED.enabled,
            channel_id        = EXCLUDED.channel_id,
            message           = EXCLUDED.message,
            banner_url        = EXCLUDED.banner_url,
            color             = EXCLUDED.color,
            dm_enabled        = EXCLUDED.dm_enabled,
            dm_message        = EXCLUDED.dm_message,
            show_member_count = EXCLUDED.show_member_count,
            show_join_date    = EXCLUDED.show_join_date,
            show_account_age  = EXCLUDED.show_account_age,
            custom_title      = EXCLUDED.custom_title,
            custom_footer     = EXCLUDED.custom_footer,
            updated_at        = NOW()
    `, [
        guildId,
        merged.enabled ?? false,
        merged.channelId ?? null,
        merged.message ?? config.welcome.serverMessage,
        merged.bannerUrl ?? null,
        merged.color ?? '#5865F2',
        merged.dmEnabled ?? false,
        merged.dmMessage ?? config.welcome.dmMessage,
        merged.showMemberCount ?? true,
        merged.showJoinDate ?? true,
        merged.showAccountAge ?? true,
        merged.customTitle ?? null,
        merged.customFooter ?? null,
    ]);

    return getWelcomeSettings(guildId);
}

function defaultWelcomeSettings() {
    return {
        enabled: false,
        channelId: null,
        message: config.welcome.serverMessage,
        bannerUrl: null,
        color: '#5865F2',
        dmEnabled: false,
        dmMessage: config.welcome.dmMessage,
        showMemberCount: true,
        showJoinDate: true,
        showAccountAge: true,
        customTitle: null,
        customFooter: null,
    };
}

function rowToWelcomeSettings(row) {
    return {
        enabled: row.enabled,
        channelId: row.channel_id || null,
        message: row.message || config.welcome.serverMessage,
        bannerUrl: row.banner_url || null,
        color: row.color || '#5865F2',
        dmEnabled: row.dm_enabled,
        dmMessage: row.dm_message || config.welcome.dmMessage,
        showMemberCount: row.show_member_count,
        showJoinDate: row.show_join_date,
        showAccountAge: row.show_account_age,
        customTitle: row.custom_title || null,
        customFooter: row.custom_footer || null,
    };
}

// ── logging_settings ───────────────────────────────────────────────────────

async function ensureLoggingTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS logging_settings (
            guild_id              VARCHAR(50) PRIMARY KEY,
            enabled               BOOLEAN NOT NULL DEFAULT false,
            channel_id            VARCHAR(50),
            webhook_url           TEXT,
            webhook_name          VARCHAR(100) DEFAULT 'PrimeBot Logs',
            events                JSONB NOT NULL DEFAULT '[]',
            include_bots          BOOLEAN NOT NULL DEFAULT false,
            color                 VARCHAR(20) DEFAULT '#5865F2',
            updated_at            TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`ALTER TABLE logging_settings ADD COLUMN IF NOT EXISTS webhook_name  VARCHAR(100) DEFAULT 'PrimeBot Logs'`);
    await pool.query(`ALTER TABLE logging_settings ADD COLUMN IF NOT EXISTS events        JSONB NOT NULL DEFAULT '[]'`);
    await pool.query(`ALTER TABLE logging_settings ADD COLUMN IF NOT EXISTS include_bots  BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE logging_settings ADD COLUMN IF NOT EXISTS color         VARCHAR(20) DEFAULT '#5865F2'`);
}

async function getLoggingSettings(guildId) {
    await ensureLoggingTable();
    const res = await pool.query(`SELECT * FROM logging_settings WHERE guild_id = $1`, [guildId]);
    if (res.rows.length === 0) return defaultLoggingSettings();
    return rowToLoggingSettings(res.rows[0]);
}

async function upsertLoggingSettings(guildId, patch) {
    await ensureLoggingTable();
    const current = await getLoggingSettings(guildId);
    const merged = { ...current, ...patch };

    await pool.query(`
        INSERT INTO logging_settings (
            guild_id, enabled, channel_id, webhook_url, webhook_name,
            events, include_bots, color, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
        ON CONFLICT (guild_id) DO UPDATE SET
            enabled      = EXCLUDED.enabled,
            channel_id   = EXCLUDED.channel_id,
            webhook_url  = EXCLUDED.webhook_url,
            webhook_name = EXCLUDED.webhook_name,
            events       = EXCLUDED.events,
            include_bots = EXCLUDED.include_bots,
            color        = EXCLUDED.color,
            updated_at   = NOW()
    `, [
        guildId,
        merged.enabled ?? false,
        merged.channelId ?? null,
        merged.webhookUrl ?? null,
        (merged.webhookName || 'PrimeBot Logs').slice(0, 100),
        JSON.stringify(normalizeEvents(merged.events)),
        merged.includeBots ?? false,
        merged.color ?? '#5865F2',
    ]);

    return getLoggingSettings(guildId);
}

function defaultLoggingSettings() {
    return {
        enabled: false,
        channelId: null,
        webhookUrl: null,
        webhookName: 'PrimeBot Logs',
        events: [...DEFAULT_ENABLED_EVENTS],
        includeBots: false,
        color: '#5865F2',
    };
}

function rowToLoggingSettings(row) {
    return {
        enabled: row.enabled,
        channelId: row.channel_id || null,
        webhookUrl: row.webhook_url || null,
        webhookName: row.webhook_name || 'PrimeBot Logs',
        events: normalizeEvents(row.events),
        includeBots: row.include_bots,
        color: row.color || '#5865F2',
    };
}

// ── reaction_roles + reaction_role_mappings ─────────────────────────────────
//
// Reaction-role menus live in the REACTION_DATABASE_URL pool (falling back to
// DATABASE_URL), mirroring the bot's ReactionRoleManager. The dashboard reads
// them for the settings page and writes create/edit/delete through here; the
// bot picks up changes via its periodic cache reload.

let reactionPool = null;
function getReactionPool() {
    if (reactionPool) return reactionPool;
    try {
        reactionPool = require('../server/reactionDb').reactionPool;
    } catch (err) {
        console.error('[DASHBOARD DB] reactionDb unavailable:', err.message);
        reactionPool = { query: async () => { throw new Error('Reaction database not configured'); } };
    }
    return reactionPool;
}

async function ensureReactionTables() {
    await getReactionPool().query(`
        CREATE TABLE IF NOT EXISTS reaction_roles (
            id                   SERIAL PRIMARY KEY,
            guild_id             VARCHAR(50) NOT NULL,
            channel_id           VARCHAR(50) NOT NULL,
            message_id           VARCHAR(50) NOT NULL,
            title                VARCHAR(255),
            description          TEXT,
            color                VARCHAR(20) DEFAULT '#5865F2',
            mode                 VARCHAR(20) DEFAULT 'normal',
            persistent           BOOLEAN DEFAULT true,
            include_bots         BOOLEAN DEFAULT false,
            required_role_id     VARCHAR(50),
            exclusive_role_id    VARCHAR(50),
            created_by           VARCHAR(50),
            enabled              BOOLEAN DEFAULT true,
            created_at           TIMESTAMP DEFAULT NOW(),
            updated_at           TIMESTAMP DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS reaction_roles_message_idx
            ON reaction_roles (guild_id, channel_id, message_id);
        CREATE INDEX IF NOT EXISTS reaction_roles_guild_idx
            ON reaction_roles (guild_id);
        CREATE TABLE IF NOT EXISTS reaction_role_mappings (
            id         SERIAL PRIMARY KEY,
            menu_id    INTEGER NOT NULL REFERENCES reaction_roles(id) ON DELETE CASCADE,
            emoji      VARCHAR(100) NOT NULL,
            role_id    VARCHAR(50) NOT NULL,
            label      VARCHAR(255),
            created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS reaction_role_mappings_menu_idx
            ON reaction_role_mappings (menu_id);
        CREATE UNIQUE INDEX IF NOT EXISTS reaction_role_mappings_menu_emoji_idx
            ON reaction_role_mappings (menu_id, emoji);
    `);
}

const VALID_RR_MODES = new Set(['normal', 'sticky', 'verify', 'unique']);

function parseEmojiString(input) {
    if (!input) return null;
    const s = String(input).trim();
    const m = s.match(/^<a?:(\w+):(\d+)>$/);
    if (m) return `${m[1]}:${m[2]}`;
    if (/^\w+:\d+$/.test(s)) return s;
    return s;
}

function normalizeRrMappings(mappings) {
    if (!Array.isArray(mappings)) return [];
    const seen = new Set();
    const out = [];
    for (const m of mappings) {
        if (!m || !m.emoji || !m.roleId) continue;
        const emoji = parseEmojiString(m.emoji);
        if (!emoji || seen.has(emoji)) continue;
        seen.add(emoji);
        out.push({ emoji, roleId: String(m.roleId), label: m.label || null });
    }
    return out;
}

function rrRowToMenu(row, mappings) {
    return {
        id: row.id,
        guildId: row.guild_id,
        channelId: row.channel_id || null,
        messageId: row.message_id || null,
        title: row.title || null,
        description: row.description || null,
        color: row.color || '#5865F2',
        mode: row.mode || 'normal',
        persistent: row.persistent,
        includeBots: row.include_bots,
        requiredRoleId: row.required_role_id || null,
        exclusiveRoleId: row.exclusive_role_id || null,
        createdBy: row.created_by || null,
        enabled: row.enabled,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        mappings: mappings || [],
    };
}

async function _fetchRrMenu(id) {
    const res = await getReactionPool().query('SELECT * FROM reaction_roles WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    const mapsRes = await getReactionPool().query(
        'SELECT * FROM reaction_role_mappings WHERE menu_id = $1 ORDER BY id', [id]
    );
    return rrRowToMenu(res.rows[0], mapsRes.rows.map(r => ({
        id: r.id, menuId: r.menu_id, emoji: r.emoji, roleId: r.role_id, label: r.label || null,
    })));
}

async function getReactionRoles(guildId) {
    await ensureReactionTables();
    const res = await getReactionPool().query('SELECT * FROM reaction_roles WHERE guild_id = $1 ORDER BY id', [guildId]);
    if (res.rows.length === 0) return [];
    const ids = res.rows.map(r => r.id);
    const mapsRes = await getReactionPool().query(
        'SELECT * FROM reaction_role_mappings WHERE menu_id = ANY($1::int[]) ORDER BY id', [ids]
    );
    const byMenu = new Map();
    for (const r of mapsRes.rows) {
        if (!byMenu.has(r.menu_id)) byMenu.set(r.menu_id, []);
        byMenu.get(r.menu_id).push({ id: r.id, menuId: r.menu_id, emoji: r.emoji, roleId: r.role_id, label: r.label || null });
    }
    return res.rows.map(r => rrRowToMenu(r, byMenu.get(r.id) || []));
}

async function _replaceRrMappings(menuId, mappings) {
    const pool = getReactionPool();
    await pool.query('DELETE FROM reaction_role_mappings WHERE menu_id = $1', [menuId]);
    for (const m of mappings) {
        await pool.query(`
            INSERT INTO reaction_role_mappings (menu_id, emoji, role_id, label, created_at)
            VALUES ($1,$2,$3,$4,NOW())
            ON CONFLICT (menu_id, emoji) DO UPDATE SET role_id = EXCLUDED.role_id, label = EXCLUDED.label
        `, [menuId, m.emoji, m.roleId, m.label || null]);
    }
}

/**
 * Create a reaction-role menu row from the dashboard. For bot-created menus
 * the bot posts the embed on its next cache reload (it owns the gateway); for
 * "attach to message" the messageId is provided here.
 */
async function createReactionRole(guildId, data) {
    await ensureReactionTables();
    const mode = VALID_RR_MODES.has(data.mode) ? data.mode : 'normal';
    const color = /^#[0-9a-fA-F]{6}$/.test(data.color) ? data.color : '#5865F2';
    const mappings = normalizeRrMappings(data.mappings);
    if (!data.channelId) throw new Error('channelId is required.');
    const messageId = data.messageId || null;
    if (!messageId && !data.attach) throw new Error('messageId is required (or set attach=true).');

    const res = await getReactionPool().query(`
        INSERT INTO reaction_roles (
            guild_id, channel_id, message_id, title, description, color, mode,
            persistent, include_bots, required_role_id, exclusive_role_id,
            created_by, enabled, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,NOW(),NOW())
        RETURNING id
    `, [
        guildId, data.channelId, messageId,
        data.title || null, data.attach ? null : (data.description || null),
        color, mode,
        data.persistent !== false, data.includeBots === true,
        data.requiredRoleId || null, data.exclusiveRoleId || null,
        data.createdBy || null,
    ]);
    const id = res.rows[0].id;
    await _replaceRrMappings(id, mappings);
    return _fetchRrMenu(id);
}

async function updateReactionRole(id, patch) {
    await ensureReactionTables();
    const current = await _fetchRrMenu(id);
    if (!current) throw new Error('Reaction-role menu not found.');
    const next = {
        title: patch.title !== undefined ? patch.title : current.title,
        description: patch.description !== undefined ? patch.description : current.description,
        color: patch.color !== undefined ? patch.color : current.color,
        mode: patch.mode !== undefined ? patch.mode : current.mode,
        persistent: patch.persistent !== undefined ? patch.persistent : current.persistent,
        includeBots: patch.includeBots !== undefined ? patch.includeBots : current.includeBots,
        requiredRoleId: patch.requiredRoleId !== undefined ? patch.requiredRoleId : current.requiredRoleId,
        exclusiveRoleId: patch.exclusiveRoleId !== undefined ? patch.exclusiveRoleId : current.exclusiveRoleId,
        enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    };
    if (next.mode && !VALID_RR_MODES.has(next.mode)) next.mode = 'normal';
    if (next.color && !/^#[0-9a-fA-F]{6}$/.test(next.color)) next.color = '#5865F2';
    await getReactionPool().query(`
        UPDATE reaction_roles SET
            title = $2, description = $3, color = $4, mode = $5,
            persistent = $6, include_bots = $7, required_role_id = $8,
            exclusive_role_id = $9, enabled = $10, updated_at = NOW()
        WHERE id = $1
    `, [
        id, next.title, next.description, next.color, next.mode,
        next.persistent, next.includeBots, next.requiredRoleId || null,
        next.exclusiveRoleId || null, next.enabled,
    ]);
    if (Array.isArray(patch.mappings)) {
        await _replaceRrMappings(id, normalizeRrMappings(patch.mappings));
    }
    return _fetchRrMenu(id);
}

async function deleteReactionRole(id) {
    await ensureReactionTables();
    await getReactionPool().query('DELETE FROM reaction_roles WHERE id = $1', [id]);
    return true;
}

// ── automod_settings + automod_warnings ──────────────────────────────────────
//
// Premium Automod config + warnings ledger live in the AUTOMOD_DATABASE_URL pool
// (falling back to DATABASE_URL), mirroring the bot's AutomodManager. The
// dashboard reads/writes here; the bot's AutomodManager picks up changes via
// its periodic cache reload.

async function ensureAutomodTables() {
    await getAutomodPool().query(`
        CREATE TABLE IF NOT EXISTS automod_settings (
            guild_id            VARCHAR(50) PRIMARY KEY,
            enabled             BOOLEAN NOT NULL DEFAULT false,
            log_channel_id      VARCHAR(50),
            mute_role_id        VARCHAR(50),
            exempt_role_ids     JSONB NOT NULL DEFAULT '[]',
            exempt_channel_ids  JSONB NOT NULL DEFAULT '[]',
            rules               JSONB NOT NULL DEFAULT '[]',
            warn_threshold      INTEGER NOT NULL DEFAULT 3,
            warn_action         VARCHAR(20) DEFAULT 'timeout',
            warn_actions        JSONB NOT NULL DEFAULT '["timeout"]',
            dm_enabled          BOOLEAN NOT NULL DEFAULT true,
            dm_messages         JSONB NOT NULL DEFAULT '{}',
            appeal_channel_id   VARCHAR(50),
            updated_at          TIMESTAMP DEFAULT NOW()
        )
    `);
    await getAutomodPool().query(`ALTER TABLE automod_settings ADD COLUMN IF NOT EXISTS log_channel_id     VARCHAR(50)`);
    await getAutomodPool().query(`ALTER TABLE automod_settings ADD COLUMN IF NOT EXISTS mute_role_id       VARCHAR(50)`);
    await getAutomodPool().query(`ALTER TABLE automod_settings ADD COLUMN IF NOT EXISTS exempt_role_ids    JSONB NOT NULL DEFAULT '[]'`);
    await getAutomodPool().query(`ALTER TABLE automod_settings ADD COLUMN IF NOT EXISTS exempt_channel_ids JSONB NOT NULL DEFAULT '[]'`);
    await getAutomodPool().query(`ALTER TABLE automod_settings ADD COLUMN IF NOT EXISTS rules              JSONB NOT NULL DEFAULT '[]'`);
    await getAutomodPool().query(`ALTER TABLE automod_settings ADD COLUMN IF NOT EXISTS warn_threshold     INTEGER NOT NULL DEFAULT 3`);
    await getAutomodPool().query(`ALTER TABLE automod_settings ADD COLUMN IF NOT EXISTS warn_action        VARCHAR(20) DEFAULT 'timeout'`);
    await getAutomodPool().query(`ALTER TABLE automod_settings ADD COLUMN IF NOT EXISTS warn_actions       JSONB NOT NULL DEFAULT '["timeout"]'`);
    await getAutomodPool().query(`ALTER TABLE automod_settings ADD COLUMN IF NOT EXISTS dm_enabled         BOOLEAN NOT NULL DEFAULT true`);
    await getAutomodPool().query(`ALTER TABLE automod_settings ADD COLUMN IF NOT EXISTS dm_messages        JSONB NOT NULL DEFAULT '{}'`);
    await getAutomodPool().query(`ALTER TABLE automod_settings ADD COLUMN IF NOT EXISTS appeal_channel_id  VARCHAR(50)`);
    await getAutomodPool().query(`
        CREATE TABLE IF NOT EXISTS automod_warnings (
            id           SERIAL PRIMARY KEY,
            guild_id     VARCHAR(50) NOT NULL,
            user_id      VARCHAR(50) NOT NULL,
            moderator_id VARCHAR(50),
            reason       TEXT NOT NULL DEFAULT '',
            rule_type    VARCHAR(40),
            created_at   TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS automod_warnings_guild_user_idx
            ON automod_warnings (guild_id, user_id);
        CREATE INDEX IF NOT EXISTS automod_warnings_guild_idx
            ON automod_warnings (guild_id);
    `);
    await getAutomodPool().query(`
        CREATE TABLE IF NOT EXISTS automod_appeals (
            id            SERIAL PRIMARY KEY,
            guild_id      VARCHAR(50) NOT NULL,
            user_id       VARCHAR(50) NOT NULL,
            action        VARCHAR(20) NOT NULL,
            reason        TEXT NOT NULL DEFAULT '',
            status        VARCHAR(20) NOT NULL DEFAULT 'pending',
            decision_note TEXT,
            decided_by    VARCHAR(50),
            decided_at    TIMESTAMP,
            reversed      BOOLEAN NOT NULL DEFAULT false,
            created_at    TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS automod_appeals_guild_idx
            ON automod_appeals (guild_id);
        CREATE INDEX IF NOT EXISTS automod_appeals_guild_status_idx
            ON automod_appeals (guild_id, status);
    `);
    await getAutomodPool().query(`ALTER TABLE automod_appeals ADD COLUMN IF NOT EXISTS reversed BOOLEAN NOT NULL DEFAULT false`);
}

async function getAutomodSettings(guildId) {
    await ensureAutomodTables();
    const res = await getAutomodPool().query(`SELECT * FROM automod_settings WHERE guild_id = $1`, [guildId]);
    if (res.rows.length === 0) return defaultAutomodSettings();
    return rowToAutomodSettings(res.rows[0]);
}

function defaultAutomodSettings() {
    return {
        enabled: false,
        logChannelId: null,
        muteRoleId: null,
        exemptRoleIds: [],
        exemptChannelIds: [],
        rules: [],
        warnThreshold: 3,
        warnAction: 'timeout',
        warnActions: ['timeout'],
        dmEnabled: true,
        dmMessages: {},
        appealChannelId: null,
    };
}

function rowToAutomodSettings(row) {
    const warnActions = Array.isArray(row.warn_actions) && row.warn_actions.length
        ? normalizeWarnActions(row.warn_actions, 'timeout')
        : [normalizeAction(row.warn_action, 'timeout')];
    return {
        enabled: row.enabled,
        logChannelId: row.log_channel_id || null,
        muteRoleId: row.mute_role_id || null,
        exemptRoleIds: Array.isArray(row.exempt_role_ids) ? row.exempt_role_ids.map(String) : [],
        exemptChannelIds: Array.isArray(row.exempt_channel_ids) ? row.exempt_channel_ids.map(String) : [],
        rules: normalizeRules(row.rules),
        warnThreshold: Math.max(1, parseInt(row.warn_threshold, 10) || 3),
        warnAction: warnActions[0],
        warnActions,
        dmEnabled: row.dm_enabled !== false,
        dmMessages: normalizeDmMessages(row.dm_messages),
        appealChannelId: row.appeal_channel_id || null,
    };
}

async function upsertAutomodSettings(guildId, patch) {
    await ensureAutomodTables();
    const current = await getAutomodSettings(guildId);
    const merged = { ...current };
    if ('enabled' in patch)           merged.enabled = Boolean(patch.enabled);
    if ('logChannelId' in patch)      merged.logChannelId = patch.logChannelId || null;
    if ('muteRoleId' in patch)        merged.muteRoleId = patch.muteRoleId || null;
    if ('exemptRoleIds' in patch)     merged.exemptRoleIds = (Array.isArray(patch.exemptRoleIds) ? patch.exemptRoleIds : []).map(String);
    if ('exemptChannelIds' in patch)  merged.exemptChannelIds = (Array.isArray(patch.exemptChannelIds) ? patch.exemptChannelIds : []).map(String);
    if ('rules' in patch)             merged.rules = normalizeRules(patch.rules);
    if ('warnThreshold' in patch)     merged.warnThreshold = Math.max(1, parseInt(patch.warnThreshold, 10) || 3);
    if ('warnAction' in patch)        merged.warnAction = normalizeAction(patch.warnAction, 'timeout');
    if ('warnActions' in patch) {
        merged.warnActions = normalizeWarnActions(patch.warnActions, merged.warnAction || 'timeout');
        merged.warnAction = merged.warnActions[0];
    }
    if ('dmEnabled' in patch)         merged.dmEnabled = patch.dmEnabled !== false;
    if ('dmMessages' in patch)        merged.dmMessages = normalizeDmMessages(patch.dmMessages);
    if ('appealChannelId' in patch)   merged.appealChannelId = patch.appealChannelId || null;

    await getAutomodPool().query(`
        INSERT INTO automod_settings (
            guild_id, enabled, log_channel_id, mute_role_id,
            exempt_role_ids, exempt_channel_ids, rules,
            warn_threshold, warn_action, warn_actions,
            dm_enabled, dm_messages, appeal_channel_id, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
        ON CONFLICT (guild_id) DO UPDATE SET
            enabled            = EXCLUDED.enabled,
            log_channel_id     = EXCLUDED.log_channel_id,
            mute_role_id       = EXCLUDED.mute_role_id,
            exempt_role_ids    = EXCLUDED.exempt_role_ids,
            exempt_channel_ids = EXCLUDED.exempt_channel_ids,
            rules              = EXCLUDED.rules,
            warn_threshold     = EXCLUDED.warn_threshold,
            warn_action        = EXCLUDED.warn_action,
            warn_actions       = EXCLUDED.warn_actions,
            dm_enabled         = EXCLUDED.dm_enabled,
            dm_messages        = EXCLUDED.dm_messages,
            appeal_channel_id  = EXCLUDED.appeal_channel_id,
            updated_at         = NOW()
    `, [
        guildId, merged.enabled, merged.logChannelId, merged.muteRoleId,
        JSON.stringify(merged.exemptRoleIds), JSON.stringify(merged.exemptChannelIds),
        JSON.stringify(merged.rules), merged.warnThreshold, merged.warnAction,
        JSON.stringify(merged.warnActions), merged.dmEnabled,
        JSON.stringify(merged.dmMessages), merged.appealChannelId,
    ]);
    return getAutomodSettings(guildId);
}

async function getAutomodWarnings(guildId) {
    await ensureAutomodTables();
    const res = await getAutomodPool().query(
        `SELECT * FROM automod_warnings WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [guildId]
    );
    return res.rows.map(r => ({
        id: r.id, userId: r.user_id, moderatorId: r.moderator_id,
        reason: r.reason, ruleType: r.rule_type, createdAt: r.created_at,
    }));
}

async function clearAutomodWarnings(guildId, userId = null) {
    await ensureAutomodTables();
    if (userId) {
        await getAutomodPool().query('DELETE FROM automod_warnings WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
    } else {
        await getAutomodPool().query('DELETE FROM automod_warnings WHERE guild_id = $1', [guildId]);
    }
    return true;
}

// ── automod_appeals ──────────────────────────────────────────────────────────
//
// Members punished by automod can file an appeal. Moderators review pending
// appeals and approve/deny them from the dashboard. The bot's AutomodManager
// reverses the action when an appeal is approved (via the /appeal command or
// dashboard); the dashboard writes the decision and the bot's manager handles
// reversal, so these dashboard helpers only record the decision.

async function submitAutomodAppeal(guildId, { userId, action, reason }) {
    await ensureAutomodTables();
    const res = await getAutomodPool().query(`
        INSERT INTO automod_appeals (guild_id, user_id, action, reason)
        VALUES ($1,$2,$3,$4)
        RETURNING *
    `, [guildId, userId, normalizeAction(action, 'timeout'), String(reason || '').slice(0, 1000) || 'No reason provided']);
    return rowToAutomodAppeal(res.rows[0]);
}

async function getAutomodAppeals(guildId, { status = null } = {}) {
    await ensureAutomodTables();
    const params = [guildId];
    let q = 'SELECT * FROM automod_appeals WHERE guild_id = $1';
    if (status) { q += ' AND status = $2'; params.push(status); }
    q += ' ORDER BY created_at DESC LIMIT 200';
    const res = await getAutomodPool().query(q, params);
    return res.rows.map(rowToAutomodAppeal);
}

async function decideAutomodAppeal(id, { approved, decidedBy, note = '' }) {
    await ensureAutomodTables();
    const status = approved ? 'approved' : 'denied';
    const res = await getAutomodPool().query(`
        UPDATE automod_appeals
        SET status = $2, decision_note = $3, decided_by = $4, decided_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING *
    `, [id, status, String(note || '').slice(0, 1000), decidedBy]);
    return res.rows[0] ? rowToAutomodAppeal(res.rows[0]) : null;
}

function rowToAutomodAppeal(row) {
    return {
        id: row.id,
        guildId: row.guild_id,
        userId: row.user_id,
        action: row.action,
        reason: row.reason,
        status: row.status,
        decisionNote: row.decision_note || null,
        decidedBy: row.decided_by || null,
        decidedAt: row.decided_at || null,
        reversed: row.reversed === true,
        createdAt: row.created_at,
    };
}

// ── Combined view (one fetch per guild for the settings page) ───────────────

async function getGuildConfig(guildId) {
    const [server, welcome, logging, reactionRoles, automod, ticketPanels, levelingRoleRewards] = await Promise.all([
        getServerSettings(guildId).catch(err => {
            console.error('[DASHBOARD DB] server_settings read failed:', err.message);
            return defaultServerSettings();
        }),
        getWelcomeSettings(guildId).catch(err => {
            console.error('[DASHBOARD DB] welcome_settings read failed:', err.message);
            return defaultWelcomeSettings();
        }),
        getLoggingSettings(guildId).catch(err => {
            console.error('[DASHBOARD DB] logging_settings read failed:', err.message);
            return defaultLoggingSettings();
        }),
        getReactionRoles(guildId).catch(err => {
            console.error('[DASHBOARD DB] reaction_roles read failed:', err.message);
            return [];
        }),
        getAutomodSettings(guildId).catch(err => {
            console.error('[DASHBOARD DB] automod_settings read failed:', err.message);
            return defaultAutomodSettings();
        }),
        getTicketPanels(guildId).catch(err => {
            console.error('[DASHBOARD DB] ticket_panels read failed:', err.message);
            return [];
        }),
        getLevelingRoleRewards(guildId).catch(err => {
            console.error('[DASHBOARD DB] leveling_role_rewards read failed:', err.message);
            return [];
        }),
    ]);
    // Attach durable role rewards onto the leveling settings (kept in a separate
    // pool so they survive restarts and reach the bot via its cache reload).
    if (server && server.leveling) {
        server.leveling.roleRewards = levelingRoleRewards || [];
    }
    return { server, welcome, logging, reactionRoles, automod, ticketPanels };
}

// ── Aggregated platform stats (public — shown on the login screen) ──────────
//
// These run simple COUNTs against the same tables the bot uses, so the numbers
// reflect real, live configuration. Each query is wrapped so a missing/unreachable
// database degrades to zero rather than throwing the whole endpoint — the login
// page still renders, just with neutral stats.

async function _count(query, fallback = 0) {
    try {
        const res = await pool.query(query);
        return Number(res.rows[0]?.count ?? fallback);
    } catch (err) {
        console.error('[DASHBOARD DB] stats count failed:', err.message);
        return fallback;
    }
}

async function _welcomeCount(query, fallback = 0) {
    try {
        const res = await getWelcomePool().query(query);
        return Number(res.rows[0]?.count ?? fallback);
    } catch (err) {
        console.error('[DASHBOARD DB] welcome stats count failed:', err.message);
        return fallback;
    }
}

async function _automodCount(query, fallback = 0) {
    try {
        const res = await getAutomodPool().query(query);
        return Number(res.rows[0]?.count ?? fallback);
    } catch (err) {
        console.error('[DASHBOARD DB] automod stats count failed:', err.message);
        return fallback;
    }
}

async function _ticketCount(query, fallback = 0) {
    try {
        const res = await getTicketPool().query(query);
        return Number(res.rows[0]?.count ?? fallback);
    } catch (err) {
        console.error('[DASHBOARD DB] ticket stats count failed:', err.message);
        return fallback;
    }
}

async function getPlatformStats(serverCountOverride) {
    const [
        totalServers,
        levelingEnabled,
        welcomeEnabled,
        autoReactionsEnabled,
        broadcastEnabled,
        welcomeBanners,
        automodEnabled,
        ticketPanels,
    ] = await Promise.all([
        _count(`SELECT COUNT(*) FROM server_settings`),
        _count(`SELECT COUNT(*) FROM server_settings WHERE leveling_enabled = true`),
        _welcomeCount(`SELECT COUNT(*) FROM welcome_settings WHERE enabled = true`),
        _count(`SELECT COUNT(*) FROM server_settings WHERE auto_reactions_enabled = true`),
        _count(`SELECT COUNT(*) FROM server_settings WHERE receive_broadcasts = true`),
        _welcomeCount(`SELECT COUNT(*) FROM welcome_settings WHERE banner_url IS NOT NULL AND banner_url <> ''`),
        _automodCount(`SELECT COUNT(*) FROM automod_settings WHERE enabled = true`),
        _ticketCount(`SELECT COUNT(*) FROM ticket_panels WHERE enabled = true`),
    ]);

    // Use the authoritative server count (guilds the bot is actually in) when
    // available so adoption percentages are relative to the real total, not the
    // (smaller) set of guilds that have a server_settings row.
    const servers = serverCountOverride != null ? serverCountOverride : totalServers;

    // Adoption ratios (guard against divide-by-zero). These drive the donut charts.
    const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

    return {
        servers,
        botName: constants.BOT_NAME,
        botVersion: constants.BOT_VERSION,
        features: {
            leveling: { count: levelingEnabled, percent: pct(levelingEnabled, servers) },
            welcome: { count: welcomeEnabled, percent: pct(welcomeEnabled, servers) },
            autoReactions: { count: autoReactionsEnabled, percent: pct(autoReactionsEnabled, servers) },
            broadcasts: { count: broadcastEnabled, percent: pct(broadcastEnabled, servers) },
            automod: { count: automodEnabled, percent: pct(automodEnabled, servers) },
            tickets: { count: ticketPanels, percent: pct(ticketPanels, servers) },
        },
        welcomeBanners,
    };
}

// ── ticket_panels + ticket_instances ──────────────────────────────────────────
//
// Premium ticket panels live in the TICKET_DATABASE_URL pool (falling back to
// DATABASE_URL), mirroring the bot's TicketPanelManager. The dashboard reads/
// writes here; the bot's TicketPanelManager picks up changes via its periodic
// cache reload. Panels are configurable ONLY from the dashboard — slash/prefix
// ticket commands are disabled and reply with a notice.

async function ensureTicketTables() {
    const pool = getTicketPool();
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ticket_panels (
            id              SERIAL PRIMARY KEY,
            guild_id        VARCHAR(50) NOT NULL,
            name            VARCHAR(100) NOT NULL DEFAULT 'Support Ticket',
            channel_id      VARCHAR(50),
            message_id      VARCHAR(50),
            message_type    VARCHAR(20) NOT NULL DEFAULT 'embed',
            title           VARCHAR(255),
            description     TEXT,
            color           VARCHAR(20) DEFAULT '#5865F2',
            thumbnail_url   TEXT,
            image_url       TEXT,
            footer_text     VARCHAR(255),
            content         TEXT,
            button_label    VARCHAR(80) NOT NULL DEFAULT 'Open Ticket',
            button_style    VARCHAR(20) NOT NULL DEFAULT 'Primary',
            button_emoji    VARCHAR(100),
            category        VARCHAR(50) DEFAULT 'general',
            ticket_name     VARCHAR(100),
            support_role_ids    JSONB NOT NULL DEFAULT '[]',
            ping_role_ids       JSONB NOT NULL DEFAULT '[]',
            ticket_category_id  VARCHAR(50),
            cooldown_seconds        INTEGER NOT NULL DEFAULT 0,
            max_open_per_user      INTEGER NOT NULL DEFAULT 1,
            ask_reason             BOOLEAN NOT NULL DEFAULT false,
            reason_placeholder     VARCHAR(255),
            welcome_message        TEXT,
            close_button_label     VARCHAR(80) DEFAULT 'Close Ticket',
            close_button_emoji     VARCHAR(100),
            claim_button_label     VARCHAR(80),
            claim_button_emoji     VARCHAR(100),
            enabled             BOOLEAN NOT NULL DEFAULT true,
            created_by          VARCHAR(50),
            created_at          TIMESTAMP DEFAULT NOW(),
            updated_at          TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS ticket_panels_guild_idx ON ticket_panels (guild_id);
        CREATE UNIQUE INDEX IF NOT EXISTS ticket_panels_guild_name_idx ON ticket_panels (guild_id, name);
        CREATE TABLE IF NOT EXISTS ticket_instances (
            id                  SERIAL PRIMARY KEY,
            panel_id            INTEGER REFERENCES ticket_panels(id) ON DELETE SET NULL,
            guild_id            VARCHAR(50) NOT NULL,
            channel_id          VARCHAR(50) NOT NULL,
            user_id             VARCHAR(50) NOT NULL,
            category            VARCHAR(50) DEFAULT 'general',
            is_thread           BOOLEAN NOT NULL DEFAULT false,
            parent_channel_id   VARCHAR(50),
            control_message_id  VARCHAR(50),
            reason              TEXT,
            status              VARCHAR(20) NOT NULL DEFAULT 'open',
            claimed_by          VARCHAR(50),
            created_at          BIGINT NOT NULL,
            closed_at           BIGINT,
            closed_by           VARCHAR(50),
            reopened_at         BIGINT,
            reopened_by         VARCHAR(50)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ticket_instances_channel_idx ON ticket_instances (channel_id);
        CREATE INDEX IF NOT EXISTS ticket_instances_guild_idx ON ticket_instances (guild_id);
        CREATE INDEX IF NOT EXISTS ticket_instances_panel_idx ON ticket_instances (panel_id);
        CREATE INDEX IF NOT EXISTS ticket_instances_guild_user_idx ON ticket_instances (guild_id, user_id);
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS open_name_template     VARCHAR(100);
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS claimed_name_template VARCHAR(100);
        ALTER TABLE ticket_panels ADD COLUMN IF NOT EXISTS closed_name_template   VARCHAR(100);
    `);
}

const VALID_TICKET_BUTTON_STYLES = new Set(['Primary', 'Secondary', 'Success', 'Danger']);
const VALID_TICKET_MESSAGE_TYPES = new Set(['embed', 'plain']);

function ticketRowToPanel(row) {
    return {
        id: row.id,
        guildId: row.guild_id,
        name: row.name || 'Support Ticket',
        channelId: row.channel_id || null,
        messageId: row.message_id || null,
        messageType: row.message_type || 'embed',
        title: row.title || null,
        description: row.description || null,
        color: row.color || '#5865F2',
        thumbnailUrl: row.thumbnail_url || null,
        imageUrl: row.image_url || null,
        footerText: row.footer_text || null,
        content: row.content || null,
        buttonLabel: row.button_label || 'Open Ticket',
        buttonStyle: row.button_style || 'Primary',
        buttonEmoji: row.button_emoji || null,
        category: row.category || 'general',
        ticketName: row.ticket_name || null,
        supportRoleIds: Array.isArray(row.support_role_ids) ? row.support_role_ids : [],
        pingRoleIds: Array.isArray(row.ping_role_ids) ? row.ping_role_ids : [],
        ticketCategoryId: row.ticket_category_id || null,
        cooldownSeconds: Number(row.cooldown_seconds) || 0,
        maxOpenPerUser: Number(row.max_open_per_user) || 1,
        askReason: !!row.ask_reason,
        reasonPlaceholder: row.reason_placeholder || 'Briefly describe your issue',
        welcomeMessage: row.welcome_message || null,
        closeButtonLabel: row.close_button_label || 'Close Ticket',
        closeButtonEmoji: row.close_button_emoji || null,
        claimButtonLabel: row.claim_button_label || null,
        claimButtonEmoji: row.claim_button_emoji || null,
        openNameTemplate: row.open_name_template != null ? row.open_name_template : null,
        claimedNameTemplate: row.claimed_name_template != null ? row.claimed_name_template : null,
        closedNameTemplate: row.closed_name_template != null ? row.closed_name_template : null,
        enabled: row.enabled !== false,
        createdBy: row.created_by || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function normalizeTicketPanel(data, keepUndefined = false) {
    const defaults = {
        name: 'Support Ticket', messageType: 'embed', title: null, description: null,
        color: '#5865F2', thumbnailUrl: null, imageUrl: null, footerText: null,
        content: null, buttonLabel: 'Open Ticket', buttonStyle: 'Primary',
        buttonEmoji: null, category: 'general', ticketName: null,
        supportRoleIds: [], pingRoleIds: [], ticketCategoryId: null,
        cooldownSeconds: 0, maxOpenPerUser: 1, askReason: false,
        reasonPlaceholder: 'Briefly describe your issue',
        welcomeMessage: null, closeButtonLabel: 'Close Ticket',
        closeButtonEmoji: '🔒', claimButtonLabel: null, claimButtonEmoji: null,
        openNameTemplate: null, claimedNameTemplate: null, closedNameTemplate: null,
        enabled: true, channelId: null, messageId: null,
    };
    const out = keepUndefined ? { ...(data || {}) } : { ...defaults, ...(data || {}) };
    out.name = (out.name == null ? '' : String(out.name)).trim() || 'Support Ticket';
    out.messageType = VALID_TICKET_MESSAGE_TYPES.has(out.messageType) ? out.messageType : 'embed';
    out.buttonStyle = VALID_TICKET_BUTTON_STYLES.has(out.buttonStyle) ? out.buttonStyle : 'Primary';
    out.color = /^#[0-9a-fA-F]{6}$/.test(out.color) ? out.color : '#5865F2';
    out.supportRoleIds = Array.isArray(out.supportRoleIds) ? out.supportRoleIds.map(String) : [];
    out.pingRoleIds = Array.isArray(out.pingRoleIds) ? out.pingRoleIds.map(String) : [];
    out.cooldownSeconds = Math.max(0, parseInt(out.cooldownSeconds, 10) || 0);
    out.maxOpenPerUser = Math.max(0, parseInt(out.maxOpenPerUser, 10) || 1);
    out.askReason = !!out.askReason;
    out.enabled = out.enabled !== false;
    for (const f of ['openNameTemplate', 'claimedNameTemplate', 'closedNameTemplate']) {
        if (out[f] != null) out[f] = String(out[f]).trim().slice(0, 100) || null;
    }
    return out;
}

const TICKET_PANEL_FIELDS = {
    name: 1, channelId: 1, messageId: 1, messageType: 1, title: 1, description: 1,
    color: 1, thumbnailUrl: 1, imageUrl: 1, footerText: 1, content: 1,
    buttonLabel: 1, buttonStyle: 1, buttonEmoji: 1, category: 1, ticketName: 1,
    supportRoleIds: 1, pingRoleIds: 1, ticketCategoryId: 1, cooldownSeconds: 1,
    maxOpenPerUser: 1, askReason: 1, reasonPlaceholder: 1, welcomeMessage: 1,
    closeButtonLabel: 1, closeButtonEmoji: 1, claimButtonLabel: 1,
    claimButtonEmoji: 1, openNameTemplate: 1, claimedNameTemplate: 1,
    closedNameTemplate: 1, enabled: 1, createdBy: 1,
};

async function _fetchTicketPanel(id) {
    const res = await getTicketPool().query('SELECT * FROM ticket_panels WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    return ticketRowToPanel(res.rows[0]);
}

async function getTicketPanels(guildId) {
    await ensureTicketTables();
    const res = await getTicketPool().query('SELECT * FROM ticket_panels WHERE guild_id = $1 ORDER BY id', [guildId]);
    return res.rows.map(ticketRowToPanel);
}

async function createTicketPanel(guildId, data) {
    await ensureTicketTables();
    const p = normalizeTicketPanel(data);
    const res = await getTicketPool().query(`
        INSERT INTO ticket_panels (
            guild_id, name, channel_id, message_id, message_type, title, description,
            color, thumbnail_url, image_url, footer_text, content, button_label,
            button_style, button_emoji, category, ticket_name, support_role_ids,
            ping_role_ids, ticket_category_id, cooldown_seconds, max_open_per_user,
            ask_reason, reason_placeholder, welcome_message, close_button_label,
            close_button_emoji, claim_button_label, claim_button_emoji,
            open_name_template, claimed_name_template, closed_name_template,
            enabled, created_by, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,NOW(),NOW())
        RETURNING id
    `, [
        guildId, p.name, p.channelId || null, p.messageId || null, p.messageType,
        p.title, p.description, p.color, p.thumbnailUrl, p.imageUrl, p.footerText,
        p.content, p.buttonLabel, p.buttonStyle, p.buttonEmoji, p.category,
        p.ticketName, JSON.stringify(p.supportRoleIds), JSON.stringify(p.pingRoleIds),
        p.ticketCategoryId, p.cooldownSeconds, p.maxOpenPerUser, p.askReason,
        p.reasonPlaceholder, p.welcomeMessage, p.closeButtonLabel,
        p.closeButtonEmoji, p.claimButtonLabel, p.claimButtonEmoji,
        p.openNameTemplate, p.claimedNameTemplate, p.closedNameTemplate,
        p.enabled, p.createdBy || null,
    ]);
    return _fetchTicketPanel(res.rows[0].id);
}

async function updateTicketPanel(id, patch) {
    await ensureTicketTables();
    const current = await _fetchTicketPanel(id);
    if (!current) throw new Error('Ticket panel not found.');
    const next = { ...current };
    for (const key of Object.keys(TICKET_PANEL_FIELDS)) {
        if (key in patch) next[key] = patch[key];
    }
    const p = normalizeTicketPanel(next, true);
    await getTicketPool().query(`
        UPDATE ticket_panels SET
            name = $2, channel_id = $3, message_id = $4, message_type = $5,
            title = $6, description = $7, color = $8, thumbnail_url = $9,
            image_url = $10, footer_text = $11, content = $12, button_label = $13,
            button_style = $14, button_emoji = $15, category = $16, ticket_name = $17,
            support_role_ids = $18, ping_role_ids = $19, ticket_category_id = $20,
            cooldown_seconds = $21, max_open_per_user = $22, ask_reason = $23,
            reason_placeholder = $24, welcome_message = $25, close_button_label = $26,
            close_button_emoji = $27, claim_button_label = $28, claim_button_emoji = $29,
            open_name_template = $30, claimed_name_template = $31, closed_name_template = $32,
            enabled = $33, updated_at = NOW()
        WHERE id = $1
    `, [
        id, p.name, p.channelId || null, p.messageId || null, p.messageType,
        p.title, p.description, p.color, p.thumbnailUrl, p.imageUrl, p.footerText,
        p.content, p.buttonLabel, p.buttonStyle, p.buttonEmoji, p.category,
        p.ticketName, JSON.stringify(p.supportRoleIds), JSON.stringify(p.pingRoleIds),
        p.ticketCategoryId, p.cooldownSeconds, p.maxOpenPerUser, p.askReason,
        p.reasonPlaceholder, p.welcomeMessage, p.closeButtonLabel,
        p.closeButtonEmoji, p.claimButtonLabel, p.claimButtonEmoji,
        p.openNameTemplate, p.claimedNameTemplate, p.closedNameTemplate,
        p.enabled,
    ]);
    return _fetchTicketPanel(id);
}

async function deleteTicketPanel(id) {
    await ensureTicketTables();
    await getTicketPool().query('DELETE FROM ticket_panels WHERE id = $1', [id]);
    return true;
}

async function cloneTicketPanel(id, newName) {
    await ensureTicketTables();
    const src = await _fetchTicketPanel(id);
    if (!src) throw new Error('Ticket panel not found.');
    const data = { ...src };
    delete data.id;
    data.name = (newName && String(newName).trim()) || `${src.name} (copy)`;
    data.channelId = null;
    data.messageId = null;
    return createTicketPanel(src.guildId, data);
}

async function renameTicketPanel(id, newName) {
    const name = newName && String(newName).trim();
    if (!name) throw new Error('A name is required.');
    await ensureTicketTables();
    await getTicketPool().query('UPDATE ticket_panels SET name = $2, updated_at = NOW() WHERE id = $1', [id, name]);
    return _fetchTicketPanel(id);
}

// ── Live polls + live giveaways (LIVE_DATABASE_URL) ────────────────────────
//
// The dashboard surfaces all running and ended live polls and live giveaways
// in the "Live" page. Live polls live in the main DB schema (live_polls etc.),
// while live giveaways live in the dedicated LIVE_DATABASE_URL pool. Both are
// read-only here (creation is via the bot commands) — the dashboard just lists
// them. The bot's managers cache in memory and re-read periodically, so the
// numbers here reflect the live state within that window.

async function getLivePolls() {
    try {
        const res = await pool.query(`
            SELECT p.poll_id, p.pass_code, p.question, p.is_active,
                   p.created_at, p.expires_at, p.channel_id,
                   (SELECT COUNT(*) FROM live_poll_votes v WHERE v.poll_id = p.poll_id) AS total_votes
            FROM live_polls p
            ORDER BY p.created_at DESC
        `);
        return res.rows.map(r => ({
            pollId: r.poll_id,
            passCode: r.pass_code,
            question: r.question,
            isActive: r.is_active !== false,
            createdAt: r.created_at,
            expiresAt: r.expires_at,
            channelId: r.channel_id,
            totalVotes: Number(r.total_votes) || 0,
        }));
    } catch (err) {
        console.error('[DASHBOARD DB] live polls read failed:', err.message);
        return [];
    }
}

async function getLiveGiveaways() {
    try {
        const p = getLivePool();
        const res = await p.query(`
            SELECT g.giveaway_id, g.pass_code, g.prize, g.description, g.is_active,
                   g.ended, g.created_at, g.ends_at, g.channel_id,
                   (SELECT COUNT(*) FROM live_giveaway_participants pt WHERE pt.giveaway_id = g.giveaway_id) AS entries
            FROM live_giveaways g
            ORDER BY g.created_at DESC
        `);
        return res.rows.map(r => ({
            giveawayId: r.giveaway_id,
            passCode: r.pass_code,
            prize: r.prize,
            description: r.description,
            isActive: r.is_active !== false,
            ended: r.ended === true,
            createdAt: r.created_at,
            endsAt: r.ends_at,
            channelId: r.channel_id,
            entries: Number(r.entries) || 0,
        }));
    } catch (err) {
        console.error('[DASHBOARD DB] live giveaways read failed:', err.message);
        return [];
    }
}

// Ended live giveaways also expose the selected winners (the dashboard only
// shows winners for ended items).
async function getEndedLiveGiveaways() {
    try {
        const p = getLivePool();
        const res = await p.query(`
            SELECT g.giveaway_id, g.pass_code, g.prize, g.created_at, g.ends_at,
                   COALESCE(json_agg(w.user_id) FILTER (WHERE w.user_id IS NOT NULL), '[]') AS winners
            FROM live_giveaways g
            LEFT JOIN live_giveaway_winners w ON w.giveaway_id = g.giveaway_id
            WHERE g.ended = true
            GROUP BY g.id
            ORDER BY g.created_at DESC
        `);
        return res.rows.map(r => ({
            giveawayId: r.giveaway_id,
            passCode: r.pass_code,
            prize: r.prize,
            createdAt: r.created_at,
            endsAt: r.ends_at,
            winners: Array.isArray(r.winners) ? r.winners : [],
        }));
    } catch (err) {
        console.error('[DASHBOARD DB] ended live giveaways read failed:', err.message);
        return [];
    }
}

// Ended live polls surface the winning option(s) (the dashboard shows winners
// for ended items only).
async function getEndedLivePolls() {
    try {
        const res = await pool.query(`
            SELECT p.poll_id, p.pass_code, p.question, p.created_at, p.expires_at,
                   o.option_text, o.vote_count
            FROM live_polls p
            JOIN live_poll_options o ON o.poll_id = p.poll_id
            WHERE p.is_active = false
            ORDER BY p.created_at DESC, o.option_index
        `);
        const byPoll = new Map();
        for (const r of res.rows) {
            if (!byPoll.has(r.poll_id)) {
                byPoll.set(r.poll_id, {
                    pollId: r.poll_id,
                    passCode: r.pass_code,
                    question: r.question,
                    createdAt: r.created_at,
                    expiresAt: r.expires_at,
                    options: [],
                });
            }
            byPoll.get(r.poll_id).options.push({ text: r.option_text, votes: Number(r.vote_count) || 0 });
        }
        const out = [];
        for (const poll of byPoll.values()) {
            const maxVotes = Math.max(0, ...poll.options.map(o => o.votes));
            poll.winners = maxVotes > 0 ? poll.options.filter(o => o.votes === maxVotes).map(o => o.text) : [];
            out.push(poll);
        }
        return out;
    } catch (err) {
        console.error('[DASHBOARD DB] ended live polls read failed:', err.message);
        return [];
    }
}

// ── Event management (EVENT_DATABASE_URL) ───────────────────────────────────
//
// Event schedules are configured from the dashboard's 📅 Events tab. Each
// schedule carries a countdown (seconds to start) and a list of tasks. The bot
// reads these tables through its EventManager cache and runs the tasks; the
// dashboard creates/edits/cancels them and the bot picks up changes via its
// periodic reload.

const VALID_EVENT_ACTIONS = new Set([
    'lock', 'unlock', 'hide', 'unhide', 'addrole', 'removerole', 'sendtext', 'sendembed',
]);
const VALID_EVENT_STATUSES = new Set(['scheduled', 'running', 'completed', 'cancelled']);

async function ensureEventTables() {
    await getEventPool().query(`
        CREATE TABLE IF NOT EXISTS event_schedules (
            id                SERIAL PRIMARY KEY,
            guild_id          VARCHAR(50) NOT NULL,
            name              VARCHAR(100) NOT NULL,
            description       TEXT,
            status            VARCHAR(20) NOT NULL DEFAULT 'scheduled',
            countdown_seconds INTEGER NOT NULL DEFAULT 0,
            start_at          TIMESTAMP,
            triggered         BOOLEAN NOT NULL DEFAULT false,
            enabled           BOOLEAN NOT NULL DEFAULT true,
            created_by_id     VARCHAR(50),
            created_at        TIMESTAMP DEFAULT NOW(),
            updated_at        TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS event_schedules_guild_idx ON event_schedules (guild_id);
        CREATE TABLE IF NOT EXISTS event_tasks (
            id                SERIAL PRIMARY KEY,
            schedule_id       INTEGER NOT NULL REFERENCES event_schedules(id) ON DELETE CASCADE,
            offset_seconds    INTEGER NOT NULL DEFAULT 0,
            action            VARCHAR(30) NOT NULL,
            target_type       VARCHAR(20) NOT NULL DEFAULT 'channel',
            target_ids        JSONB NOT NULL DEFAULT '[]',
            message_content   TEXT,
            embed_title       VARCHAR(255),
            embed_description TEXT,
            embed_color       VARCHAR(20) DEFAULT '#5865F2',
            embed_image_url   TEXT,
            channel_id        VARCHAR(50),
            executed_at       TIMESTAMP,
            created_at        TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS event_tasks_schedule_idx ON event_tasks (schedule_id);
    `);
}

function eventRowToSchedule(row, taskRows = []) {
    return {
        id: row.id,
        guildId: row.guild_id,
        name: row.name,
        description: row.description || null,
        status: row.status || 'scheduled',
        countdownSeconds: Number(row.countdown_seconds) || 0,
        startAt: row.start_at ? new Date(row.start_at).toISOString() : null,
        triggered: row.triggered === true,
        enabled: row.enabled !== false,
        createdById: row.created_by_id || null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        tasks: (taskRows || []).map(t => ({
            id: t.id,
            scheduleId: t.schedule_id,
            offsetSeconds: Number(t.offset_seconds) || 0,
            action: t.action,
            targetType: t.target_type || 'channel',
            targetIds: Array.isArray(t.target_ids) ? t.target_ids : [],
            messageContent: t.message_content || null,
            embedTitle: t.embed_title || null,
            embedDescription: t.embed_description || null,
            embedColor: t.embed_color || '#5865F2',
            embedImageUrl: t.embed_image_url || null,
            channelId: t.channel_id || null,
            executedAt: t.executed_at ? new Date(t.executed_at).toISOString() : null,
        })),
    };
}

function normalizeEventTask(data, keepUndefined = false) {
    const out = keepUndefined ? { ...(data || {}) } : {
        offsetSeconds: 0, action: 'sendtext', targetType: 'channel',
        targetIds: [], messageContent: null, embedTitle: null,
        embedDescription: null, embedColor: '#5865F2', embedImageUrl: null,
        channelId: null, ...(data || {}),
    };
    out.offsetSeconds = Math.max(0, parseInt(out.offsetSeconds, 10) || 0);
    out.action = VALID_EVENT_ACTIONS.has(out.action) ? out.action : 'sendtext';
    out.targetType = ['channel', 'role', 'user'].includes(out.targetType) ? out.targetType : 'channel';
    out.targetIds = Array.isArray(out.targetIds) ? out.targetIds.map(String) : [];
    if (out.embedColor && !/^#[0-9a-fA-F]{6}$/.test(out.embedColor)) out.embedColor = '#5865F2';
    return out;
}

async function getEventSchedules(guildId) {
    await ensureEventTables();
    const p = getEventPool();
    const res = await p.query('SELECT * FROM event_schedules WHERE guild_id = $1 ORDER BY id', [guildId]);
    const out = [];
    for (const row of res.rows) {
        const tRes = await p.query('SELECT * FROM event_tasks WHERE schedule_id = $1 ORDER BY offset_seconds, id', [row.id]);
        out.push(eventRowToSchedule(row, tRes.rows));
    }
    return out;
}

async function createEventSchedule(guildId, data, createdById = null) {
    await ensureEventTables();
    const p = getEventPool();
    const name = (data.name || '').trim().slice(0, 100) || 'Untitled Event';
    const countdown = Math.max(0, parseInt(data.countdownSeconds, 10) || 0);
    const description = data.description || null;
    // Pre-compute start_at = now + countdown for new schedules (status scheduled).
    const startAt = new Date(Date.now() + countdown * 1000);
    const res = await p.query(`
        INSERT INTO event_schedules (guild_id, name, description, status, countdown_seconds, start_at, enabled, created_by_id, created_at, updated_at)
        VALUES ($1,$2,$3,'scheduled',$4,$5,true,$6,NOW(),NOW()) RETURNING id
    `, [guildId, name, description, countdown, startAt, createdById]);
    const id = res.rows[0].id;
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    for (const t of tasks) {
        const nt = normalizeEventTask(t);
        await p.query(`
            INSERT INTO event_tasks (schedule_id, offset_seconds, action, target_type, target_ids, message_content,
                embed_title, embed_description, embed_color, embed_image_url, channel_id, created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
        `, [id, nt.offsetSeconds, nt.action, nt.targetType, JSON.stringify(nt.targetIds),
            nt.messageContent, nt.embedTitle, nt.embedDescription, nt.embedColor, nt.embedImageUrl, nt.channelId]);
    }
    const row = (await p.query('SELECT * FROM event_schedules WHERE id = $1', [id])).rows[0];
    const tRes = await p.query('SELECT * FROM event_tasks WHERE schedule_id = $1 ORDER BY offset_seconds, id', [id]);
    return eventRowToSchedule(row, tRes.rows);
}

async function updateEventSchedule(id, patch) {
    await ensureEventTables();
    const p = getEventPool();
    const cur = await p.query('SELECT * FROM event_schedules WHERE id = $1', [id]);
    if (cur.rows.length === 0) throw new Error('Event schedule not found.');
    const row = cur.rows[0];
    const name = patch.name != null ? (String(patch.name).trim().slice(0, 100) || row.name) : row.name;
    const description = patch.description != null ? patch.description : row.description;
    const countdown = patch.countdownSeconds != null ? Math.max(0, parseInt(patch.countdownSeconds, 10) || 0) : row.countdown_seconds;
    const enabled = patch.enabled != null ? !!patch.enabled : row.enabled;
    // If countdown changes and the event hasn't started, recompute start_at.
    let startAt = row.start_at;
    if (patch.countdownSeconds != null && row.status === 'scheduled' && !row.triggered) {
        startAt = new Date(Date.now() + countdown * 1000);
    }
    await p.query(`
        UPDATE event_schedules SET name = $2, description = $3, countdown_seconds = $4,
            start_at = $5, enabled = $6, updated_at = NOW() WHERE id = $1
    `, [id, name, description, countdown, startAt, enabled]);

    if (Array.isArray(patch.tasks)) {
        await p.query('DELETE FROM event_tasks WHERE schedule_id = $1', [id]);
        for (const t of patch.tasks) {
            const nt = normalizeEventTask(t);
            await p.query(`
                INSERT INTO event_tasks (schedule_id, offset_seconds, action, target_type, target_ids, message_content,
                    embed_title, embed_description, embed_color, embed_image_url, channel_id, created_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
            `, [id, nt.offsetSeconds, nt.action, nt.targetType, JSON.stringify(nt.targetIds),
                nt.messageContent, nt.embedTitle, nt.embedDescription, nt.embedColor, nt.embedImageUrl, nt.channelId]);
        }
    }
    const row2 = (await p.query('SELECT * FROM event_schedules WHERE id = $1', [id])).rows[0];
    const tRes = await p.query('SELECT * FROM event_tasks WHERE schedule_id = $1 ORDER BY offset_seconds, id', [id]);
    return eventRowToSchedule(row2, tRes.rows);
}

async function deleteEventSchedule(id) {
    await ensureEventTables();
    await getEventPool().query('DELETE FROM event_schedules WHERE id = $1', [id]);
    return true;
}

async function startEventSchedule(id) {
    await ensureEventTables();
    const p = getEventPool();
    const cur = await p.query('SELECT * FROM event_schedules WHERE id = $1', [id]);
    if (cur.rows.length === 0) throw new Error('Event schedule not found.');
    // Set status running + start_at now; the bot's EventManager.startNow /
    // exec loop will fire the tasks. We only flip DB state; the bot picks it up.
    await p.query(`
        UPDATE event_schedules SET status = 'running', start_at = NOW(), triggered = true, enabled = true, updated_at = NOW() WHERE id = $1
    `, [id]);
    return true;
}

async function cancelEventSchedule(id) {
    await ensureEventTables();
    await getEventPool().query(`
        UPDATE event_schedules SET status = 'cancelled', enabled = false, updated_at = NOW() WHERE id = $1
    `, [id]);
    return true;
}

// ── Shardnode / failover status (bot_node_status + bot_failover_lock) ─────────
//
// The bot's nodeFailover module writes a heartbeat row per shard node (sn1/sn2/
// sn3) every 15s and maintains a single-row lease lock. The dashboard reads
// these tables directly so the Stats page can show live node health without any
// bot↔dashboard IPC. Both tables live in the main DATABASE_URL pool.

const FAILOVER_THRESHOLD_MS = 45000; // mirrors utils/nodeFailover.js
const NODE_ROLES = ['sn1', 'sn2', 'sn3'];

async function ensureNodeStatusTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS bot_node_status (
            role VARCHAR(20) PRIMARY KEY,
            node_name VARCHAR(255) NOT NULL,
            last_heartbeat TIMESTAMP NOT NULL DEFAULT NOW(),
            active BOOLEAN NOT NULL DEFAULT false
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS bot_failover_lock (
            id INTEGER PRIMARY KEY DEFAULT 1,
            owner_node_name VARCHAR(255) NOT NULL,
            owner_role VARCHAR(20) NOT NULL,
            acquired_at TIMESTAMP NOT NULL DEFAULT NOW(),
            last_seen TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);
}

async function getNodeStats() {
    await ensureNodeStatusTables();
    const [statusRes, leaseRes] = await Promise.all([
        pool.query(`
            SELECT role, node_name, last_heartbeat, active,
                   EXTRACT(EPOCH FROM (NOW() - last_heartbeat)) * 1000 AS age_ms
            FROM bot_node_status
        `).catch(() => ({ rows: [] })),
        pool.query(`
            SELECT owner_node_name, owner_role, acquired_at, last_seen,
                   EXTRACT(EPOCH FROM (NOW() - last_seen)) * 1000 AS age_ms
            FROM bot_failover_lock WHERE id = 1
        `).catch(() => ({ rows: [] })),
    ]);

    const byRole = {};
    for (const row of statusRes.rows || []) {
        byRole[row.role] = {
            role: row.role,
            nodeName: row.node_name,
            active: !!row.active,
            lastHeartbeat: row.last_heartbeat,
            ageMs: Math.round(Number(row.age_ms) || 0),
        };
    }
    // Always surface all three roles so the UI renders a stable grid, even when
    // a node has never reported (no row yet). A node is "online" if it has a
    // fresh heartbeat regardless of the active flag (standby nodes are alive
    // too); "offline" once the heartbeat is older than the failover threshold.
    const nodes = NODE_ROLES.map(role => byRole[role] || {
        role,
        nodeName: null,
        active: false,
        lastHeartbeat: null,
        ageMs: null,
    }).map(n => ({
        ...n,
        status: n.ageMs == null ? 'never' : (n.ageMs > FAILOVER_THRESHOLD_MS ? 'offline' : 'online'),
    }));

    const leaseRow = (leaseRes.rows || [])[0];
    const lease = leaseRow ? {
        ownerNodeName: leaseRow.owner_node_name,
        ownerRole: leaseRow.owner_role,
        acquiredAt: leaseRow.acquired_at,
        lastSeen: leaseRow.last_seen,
        ageMs: Math.round(Number(leaseRow.age_ms) || 0),
        stale: Number(leaseRow.age_ms || Infinity) > FAILOVER_THRESHOLD_MS,
    } : null;

    return { nodes, lease, thresholdMs: FAILOVER_THRESHOLD_MS };
}

module.exports = {
    getServerSettings,
    upsertServerSettings,
    defaultServerSettings,
    getWelcomeSettings,
    upsertWelcomeSettings,
    defaultWelcomeSettings,
    getLoggingSettings,
    upsertLoggingSettings,
    defaultLoggingSettings,
    getReactionRoles,
    createReactionRole,
    updateReactionRole,
    deleteReactionRole,
    getAutomodSettings,
    upsertAutomodSettings,
    defaultAutomodSettings,
    getAutomodWarnings,
    clearAutomodWarnings,
    submitAutomodAppeal,
    getAutomodAppeals,
    decideAutomodAppeal,
    getTicketPanels,
    createTicketPanel,
    updateTicketPanel,
    deleteTicketPanel,
    cloneTicketPanel,
    renameTicketPanel,
    getGuildConfig,
    getPlatformStats,
    getLivePolls,
    getLiveGiveaways,
    getEndedLivePolls,
    getEndedLiveGiveaways,
    getEventSchedules,
    createEventSchedule,
    updateEventSchedule,
    deleteEventSchedule,
    startEventSchedule,
    cancelEventSchedule,
    getNodeStats,
};
