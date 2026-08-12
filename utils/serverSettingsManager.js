const config = require('../config');
const { pool } = require('../server/db');
const { normalizeGuildPrefix } = require('./prefixHelper');

const CREATE_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS server_settings (
        guild_id              VARCHAR(50) PRIMARY KEY,
        receive_broadcasts    BOOLEAN NOT NULL DEFAULT true,
        broadcast_channel_id  VARCHAR(50),
        welcome_enabled       BOOLEAN NOT NULL DEFAULT false,
        welcome_channel_id    VARCHAR(50),
        welcome_message       TEXT DEFAULT 'Welcome to the server, {member}! Enjoy your stay!',
        welcome_banner_url    TEXT,
        welcome_color         VARCHAR(20) DEFAULT '#5865F2',
        welcome_dm_enabled    BOOLEAN NOT NULL DEFAULT false,
        welcome_dm_message    TEXT DEFAULT 'Hey {username}! Welcome to **{server}**!',
        welcome_show_member_count  BOOLEAN NOT NULL DEFAULT true,
        welcome_show_join_date     BOOLEAN NOT NULL DEFAULT true,
        welcome_show_account_age   BOOLEAN NOT NULL DEFAULT true,
        welcome_custom_title  VARCHAR(255),
        welcome_custom_footer VARCHAR(255),
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
`;

/**
 * Manages server-specific settings and preferences — backed by PostgreSQL.
 * The in-memory Map acts as a read-through cache; writes go straight to DB
 * (fire-and-forget so callers stay synchronous).
 */
class ServerSettingsManager {
    constructor(client) {
        this.client = client;
        this.serverSettings = new Map();
        this._tableReady = false;

        this._init().catch(err =>
            console.error('[SERVER SETTINGS] Initialisation failed:', err.message)
        );
    }

    // ─── Internal helpers ────────────────────────────────────────────────────

    async _ensureTable() {
        if (this._tableReady) return;
        await pool.query(CREATE_TABLE_SQL);
        await pool.query(`ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS prefix VARCHAR(10) DEFAULT '${config.prefix}'`);
        this._tableReady = true;
    }

    async _init() {
        await this._ensureTable();
        await this._migrateFromJson();
        await this.loadSettings();
        this._startReloadInterval();
    }

    /**
     * The dashboard writes settings directly to the DB (a separate process from
     * the bot). The bot only learns about those writes by re-reading the table;
     * without this, dashboard saves appear to "succeed but do nothing" until the
     * bot is restarted. Reload on a configurable interval (default 30s).
     */
    _startReloadInterval() {
        const ms = parseInt(process.env.SETTINGS_RELOAD_INTERVAL_MS, 10) || 30000;
        this._reloadTimer = setInterval(() => {
            this.loadSettings().catch(err =>
                console.error('[SERVER SETTINGS] Background reload failed:', err.message)
            );
        }, ms);
        this._reloadTimer.unref?.();
    }

    /** One-time import of existing serverSettings.json data (non-welcome fields only).
     *  Welcome fields are migrated separately by WelcomeSettingsManager → WELCOME_DATABASE_URL. */
    async _migrateFromJson() {
        const fs = require('fs');
        const path = require('path');
        const jsonPath = path.join(__dirname, '../data/serverSettings.json');
        const migratedPath = path.join(__dirname, '../data/serverSettings.json.migrated');
        const donePath = path.join(__dirname, '../data/serverSettings.json.db_migrated');

        if (fs.existsSync(donePath)) return;

        const sourcePath = fs.existsSync(jsonPath)
            ? jsonPath
            : fs.existsSync(migratedPath)
                ? migratedPath
                : null;

        if (!sourcePath) return;

        try {
            const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
            let count = 0;
            for (const [guildId, s] of Object.entries(data)) {
                try {
                    const lev = s.leveling || {};
                    const ar  = s.autoReactions || {};
                    await pool.query(`
                        INSERT INTO server_settings (
                            guild_id, receive_broadcasts, broadcast_channel_id,
                            leveling_enabled, leveling_channel_id, xp_multiplier, xp_cooldown,
                            auto_reactions_enabled, auto_reactions, no_prefix_users
                        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                        ON CONFLICT (guild_id) DO NOTHING
                    `, [
                        guildId,
                        s.receiveBroadcasts !== false,
                        s.broadcastChannelId || null,
                        lev.enabled !== false,
                        lev.levelUpChannelId || null,
                        lev.xpMultiplier || 1.0,
                        lev.xpCooldown || 60000,
                        ar.enabled || false,
                        JSON.stringify(ar.reactions || []),
                        JSON.stringify(s.noPrefixUsers || {}),
                    ]);
                    count++;
                } catch (e) {
                    console.error(`[SERVER SETTINGS] Migration: failed on guild ${guildId}:`, e.message);
                }
            }

            if (sourcePath === jsonPath) {
                fs.renameSync(jsonPath, migratedPath);
            }
            fs.writeFileSync(donePath, new Date().toISOString());
            console.log(`[SERVER SETTINGS] Migrated ${count} guilds from JSON → DB.`);
        } catch (err) {
            console.error('[SERVER SETTINGS] JSON migration failed:', err.message);
        }
    }

    _rowToSettings(row) {
        return {
            prefix: normalizeGuildPrefix(row.prefix, config.prefix),
            receiveBroadcasts: row.receive_broadcasts,
            broadcastChannelId: row.broadcast_channel_id || null,
            // Welcome settings are managed exclusively by WelcomeSettingsManager (WELCOME_DATABASE_URL)
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

    _defaultSettings() {
        return {
            prefix: config.prefix,
            receiveBroadcasts: true,
            broadcastChannelId: null,
            // Welcome settings are managed exclusively by WelcomeSettingsManager (WELCOME_DATABASE_URL)
            leveling: {
                enabled: true,
                levelUpChannelId: null,
                xpMultiplier: 1.0,
                xpCooldown: 60000,
            },
            autoReactions: {
                enabled: false,
                reactions: [],
            },
            noPrefixUsers: {},
        };
    }

    /** Upsert one guild's settings to DB — fire-and-forget. */
    _saveGuildSettings(guildId) {
        this._saveGuildSettingsAsync(guildId).catch(err =>
            console.error(`[SERVER SETTINGS] DB save failed for guild ${guildId}:`, err.message)
        );
    }

    async _saveGuildSettingsAsync(guildId) {
        const s = this.getGuildSettings(guildId);
        // Ensure leveling sub-object exists (safe default)
        const lev = s.leveling || { enabled: true, levelUpChannelId: null, xpMultiplier: 1.0, xpCooldown: 60000 };
        const ar  = s.autoReactions || { enabled: false, reactions: [] };
        await this._ensureTable();
        // Welcome settings are stored exclusively in WELCOME_DATABASE_URL — not written here.
        await pool.query(`
            INSERT INTO server_settings (
                guild_id, receive_broadcasts, broadcast_channel_id,
                leveling_enabled, leveling_channel_id, xp_multiplier, xp_cooldown,
                auto_reactions_enabled, auto_reactions, no_prefix_users, prefix, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
            ON CONFLICT (guild_id) DO UPDATE SET
                receive_broadcasts    = EXCLUDED.receive_broadcasts,
                broadcast_channel_id  = EXCLUDED.broadcast_channel_id,
                leveling_enabled      = EXCLUDED.leveling_enabled,
                leveling_channel_id   = EXCLUDED.leveling_channel_id,
                xp_multiplier         = EXCLUDED.xp_multiplier,
                xp_cooldown           = EXCLUDED.xp_cooldown,
                auto_reactions_enabled = EXCLUDED.auto_reactions_enabled,
                auto_reactions         = EXCLUDED.auto_reactions,
                no_prefix_users        = EXCLUDED.no_prefix_users,
                prefix                 = EXCLUDED.prefix,
                updated_at             = NOW()
        `, [
            guildId,
            s.receiveBroadcasts,
            s.broadcastChannelId,
            lev.enabled,
            lev.levelUpChannelId,
            lev.xpMultiplier,
            lev.xpCooldown,
            ar.enabled,
            JSON.stringify(ar.reactions),
            JSON.stringify(s.noPrefixUsers),
            normalizeGuildPrefix(s.prefix, config.prefix),
        ]);
    }

    // ─── Public API (identical surface to the original) ──────────────────────

    async loadSettings() {
        try {
            await this._ensureTable();
            const res = await pool.query('SELECT * FROM server_settings');
            for (const row of res.rows) {
                const fresh = this._rowToSettings(row);
                // Preserve in-memory-only fields not represented in the DB.
                // (e.g. leveling.roleRewards, which the leveling manager keeps in
                // memory and is not part of the server_settings schema.) A plain
                // full replace here would wipe them every reload interval.
                const existing = this.serverSettings.get(row.guild_id);
                if (existing?.leveling?.roleRewards) {
                    fresh.leveling = fresh.leveling || {};
                    fresh.leveling.roleRewards = existing.leveling.roleRewards;
                }
                this.serverSettings.set(row.guild_id, fresh);
            }
            console.log(`[SERVER SETTINGS] Loaded settings for ${this.serverSettings.size} servers.`);
        } catch (error) {
            console.error('[SERVER SETTINGS] Error loading settings:', error);
        }
    }

    getGuildSettings(guildId) {
        if (!this.serverSettings.has(guildId)) {
            this.serverSettings.set(guildId, this._defaultSettings());
        }
        return this.serverSettings.get(guildId);
    }

    getGuildPrefix(guildId) {
        const s = this.getGuildSettings(guildId);
        return normalizeGuildPrefix(s.prefix, config.prefix);
    }

    setGuildPrefix(guildId, prefix) {
        const normalizedPrefix = normalizeGuildPrefix(prefix, config.prefix);
        const s = this.getGuildSettings(guildId);
        s.prefix = normalizedPrefix;
        this.serverSettings.set(guildId, s);
        this._saveGuildSettings(guildId);
        return { success: true, prefix: normalizedPrefix };
    }

    updateGuildSetting(guildId, setting, value) {
        const guildSettings = this.getGuildSettings(guildId);
        guildSettings[setting] = value;
        this.serverSettings.set(guildId, guildSettings);
        this._saveGuildSettings(guildId);
        return true;
    }

    // ── Broadcast ─────────────────────────────────────────────────────────────

    toggleBroadcastReception(guildId) {
        const s = this.getGuildSettings(guildId);
        const newValue = !s.receiveBroadcasts;
        s.receiveBroadcasts = newValue;
        this.serverSettings.set(guildId, s);
        this._saveGuildSettings(guildId);
        return newValue;
    }

    setBroadcastChannel(guildId, channelId) {
        return this.updateGuildSetting(guildId, 'broadcastChannelId', channelId);
    }

    getBroadcastChannel(guildId) {
        return this.getGuildSettings(guildId).broadcastChannelId || null;
    }

    receivesBroadcasts(guildId) {
        return this.getGuildSettings(guildId).receiveBroadcasts;
    }

    getOptedOutServers() {
        const out = [];
        for (const [id, s] of this.serverSettings.entries()) {
            if (!s.receiveBroadcasts) out.push(id);
        }
        return out;
    }

    getBroadcastReceptionCount() {
        let count = 0;
        for (const s of this.serverSettings.values()) {
            if (s.receiveBroadcasts) count++;
        }
        const serversWithoutSettings = this.client.guilds.cache.size - this.serverSettings.size;
        return count + Math.max(0, serversWithoutSettings);
    }

    // ── No-prefix mode ────────────────────────────────────────────────────────

    _normalizeNoPrefixExpiration(value) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue) || numericValue <= 0) return null;

        // Older values may have been stored as Unix seconds. Normalize them
        // once at read time so comparisons and Discord timestamps stay correct.
        return numericValue < 1_000_000_000_000
            ? numericValue * 1000
            : numericValue;
    }

    enableNoPrefixMode(guildId, userId, minutes = 10) {
        if (!userId) return { success: false, message: 'Invalid user' };
        if (minutes <= 0 || minutes > 60) return { success: false, message: 'Duration must be between 1 and 60 minutes' };

        try {
            const s = this.getGuildSettings(guildId);
            if (!s.noPrefixUsers) s.noPrefixUsers = {};
            const expirationTime = Date.now() + minutes * 60 * 1000;
            s.noPrefixUsers[userId] = expirationTime;
            this.serverSettings.set(guildId, s);
            this._saveGuildSettings(guildId);
            return { success: true, message: `No-prefix mode enabled for ${minutes} minute${minutes !== 1 ? 's' : ''}`, expiresAt: expirationTime };
        } catch (err) {
            console.error(`[SERVER SETTINGS] Error enabling no-prefix mode:`, err);
            return { success: false, message: 'An error occurred.' };
        }
    }

    disableNoPrefixMode(guildId, userId) {
        if (!userId) return false;
        const s = this.getGuildSettings(guildId);
        if (!s.noPrefixUsers || !s.noPrefixUsers[userId]) return false;
        delete s.noPrefixUsers[userId];
        this.serverSettings.set(guildId, s);
        this._saveGuildSettings(guildId);
        return true;
    }

    hasNoPrefixMode(guildId, userId) {
        try {
            if (!guildId || !userId) return false;
            const s = this.getGuildSettings(guildId);
            const expirationTime = this._normalizeNoPrefixExpiration(s.noPrefixUsers?.[userId]);
            if (!expirationTime) return false;
            if (Date.now() >= expirationTime) {
                delete s.noPrefixUsers[userId];
                this._saveGuildSettings(guildId);
                return false;
            }
            s.noPrefixUsers[userId] = expirationTime;
            return true;
        } catch (err) {
            console.error(`[SERVER SETTINGS] Error checking no-prefix mode:`, err);
            return false;
        }
    }

    getNoPrefixExpiration(guildId, userId) {
        if (!userId) return null;
        const s = this.getGuildSettings(guildId);
        if (!s.noPrefixUsers) return null;
        const exp = this._normalizeNoPrefixExpiration(s.noPrefixUsers[userId]);
        if (!exp) return null;
        if (Date.now() >= exp) {
            delete s.noPrefixUsers[userId];
            this.serverSettings.set(guildId, s);
            this._saveGuildSettings(guildId);
            return null;
        }
        s.noPrefixUsers[userId] = exp;
        return exp;
    }

    // ── Welcome ───────────────────────────────────────────────────────────────

    isWelcomeEnabled(guildId) { return this.getGuildSettings(guildId).welcomeEnabled; }

    toggleWelcome(guildId) {
        const s = this.getGuildSettings(guildId);
        const newValue = !s.welcomeEnabled;
        s.welcomeEnabled = newValue;
        this.serverSettings.set(guildId, s);
        this._saveGuildSettings(guildId);
        return newValue;
    }

    toggleWelcomeDm(guildId) {
        const s = this.getGuildSettings(guildId);
        const newValue = !s.welcomeDmEnabled;
        s.welcomeDmEnabled = newValue;
        this.serverSettings.set(guildId, s);
        this._saveGuildSettings(guildId);
        return newValue;
    }

    setWelcomeChannel(guildId, channelId) { return this.updateGuildSetting(guildId, 'welcomeChannelId', channelId); }
    setWelcomeMessage(guildId, message)   { return this.updateGuildSetting(guildId, 'welcomeMessage', message); }
    setWelcomeDmMessage(guildId, message) { return this.updateGuildSetting(guildId, 'welcomeDmMessage', message); }
    setWelcomeBanner(guildId, url)        { return this.updateGuildSetting(guildId, 'welcomeBannerUrl', url); }
    setWelcomeColor(guildId, color)       { return this.updateGuildSetting(guildId, 'welcomeColor', color); }

    // Welcome settings are now exclusively managed by WelcomeSettingsManager (WELCOME_DATABASE_URL).
    // These stubs remain for backward-compat; they are no-ops and log a warning.
    getWelcomeSettings(guildId) {
        console.warn('[SERVER SETTINGS] getWelcomeSettings() called on ServerSettingsManager — use client.welcomeSettingsManager instead.');
        return {};
    }
    updateWelcomeSettings(guildId, updates = {}) {
        console.warn('[SERVER SETTINGS] updateWelcomeSettings() called on ServerSettingsManager — use client.welcomeSettingsManager instead.');
        return false;
    }
    toggleWelcomeFeature(guildId, feature) {
        console.warn('[SERVER SETTINGS] toggleWelcomeFeature() called on ServerSettingsManager — use client.welcomeSettingsManager instead.');
        return false;
    }

    // ── Leveling ──────────────────────────────────────────────────────────────

    /**
     * Patch one or more leveling sub-fields (enabled, levelUpChannelId,
     * xpMultiplier, xpCooldown) and persist to DB.
     */
    updateLevelingSettings(guildId, updates = {}) {
        const s = this.getGuildSettings(guildId);
        if (!s.leveling) s.leveling = { enabled: true, levelUpChannelId: null, xpMultiplier: 1.0, xpCooldown: 60000 };
        if ('enabled'          in updates) s.leveling.enabled          = updates.enabled;
        if ('levelUpChannelId' in updates) s.leveling.levelUpChannelId = updates.levelUpChannelId;
        if ('xpMultiplier'     in updates) s.leveling.xpMultiplier     = updates.xpMultiplier;
        if ('xpCooldown'       in updates) s.leveling.xpCooldown       = updates.xpCooldown;
        this.serverSettings.set(guildId, s);
        this._saveGuildSettings(guildId);
        return true;
    }

    isLevelingEnabled(guildId) { return this.getGuildSettings(guildId).leveling?.enabled || false; }

    toggleLeveling(guildId) {
        const s = this.getGuildSettings(guildId);
        if (!s.leveling) s.leveling = { enabled: false, levelUpChannelId: null, xpMultiplier: 1.0, xpCooldown: 60000 };
        s.leveling.enabled = !s.leveling.enabled;
        this.serverSettings.set(guildId, s);
        this._saveGuildSettings(guildId);
        return s.leveling.enabled;
    }

    setLevelingChannel(guildId, channelId) {
        const s = this.getGuildSettings(guildId);
        if (!s.leveling) s.leveling = { enabled: true, levelUpChannelId: null, xpMultiplier: 1.0, xpCooldown: 60000 };
        s.leveling.levelUpChannelId = channelId;
        this.serverSettings.set(guildId, s);
        this._saveGuildSettings(guildId);
        return true;
    }

    setXpMultiplier(guildId, multiplier) {
        if (multiplier <= 0 || multiplier > 5) return false;
        const s = this.getGuildSettings(guildId);
        if (!s.leveling) s.leveling = { enabled: true, levelUpChannelId: null, xpMultiplier: 1.0, xpCooldown: 60000 };
        s.leveling.xpMultiplier = parseFloat(multiplier.toFixed(2));
        this.serverSettings.set(guildId, s);
        this._saveGuildSettings(guildId);
        return true;
    }

    setXpCooldown(guildId, cooldownSeconds) {
        if (cooldownSeconds < 5 || cooldownSeconds > 300) return false;
        const s = this.getGuildSettings(guildId);
        if (!s.leveling) s.leveling = { enabled: true, levelUpChannelId: null, xpMultiplier: 1.0, xpCooldown: 60000 };
        s.leveling.xpCooldown = cooldownSeconds * 1000;
        this.serverSettings.set(guildId, s);
        this._saveGuildSettings(guildId);
        return true;
    }

    getLevelingSettings(guildId) {
        const s = this.getGuildSettings(guildId);
        if (!s.leveling) {
            s.leveling = { enabled: true, levelUpChannelId: null, xpMultiplier: 1.0, xpCooldown: 60000 };
            this.serverSettings.set(guildId, s);
        }
        return s.leveling;
    }

    // ── Auto-reactions ────────────────────────────────────────────────────────

    addAutoReaction(guildId, trigger, emoji, caseSensitive = false) {
        if (!trigger || !emoji) return false;
        const s = this.getGuildSettings(guildId);
        if (!s.autoReactions) s.autoReactions = { enabled: true, reactions: [] };
        const idx = s.autoReactions.reactions.findIndex(r => r.trigger.toLowerCase() === trigger.toLowerCase());
        if (idx !== -1) {
            s.autoReactions.reactions[idx] = { trigger, emoji, caseSensitive };
        } else {
            s.autoReactions.reactions.push({ trigger, emoji, caseSensitive });
        }
        this.serverSettings.set(guildId, s);
        this._saveGuildSettings(guildId);
        return true;
    }

    removeAutoReaction(guildId, trigger) {
        if (!trigger) return false;
        const s = this.getGuildSettings(guildId);
        if (!s.autoReactions?.reactions) return false;
        const before = s.autoReactions.reactions.length;
        s.autoReactions.reactions = s.autoReactions.reactions.filter(
            r => r.trigger.toLowerCase() !== trigger.toLowerCase()
        );
        if (s.autoReactions.reactions.length === before) return false;
        this.serverSettings.set(guildId, s);
        this._saveGuildSettings(guildId);
        return true;
    }

    toggleAutoReactions(guildId) {
        const s = this.getGuildSettings(guildId);
        if (!s.autoReactions) {
            s.autoReactions = { enabled: true, reactions: [] };
        } else {
            s.autoReactions.enabled = !s.autoReactions.enabled;
        }
        this.serverSettings.set(guildId, s);
        this._saveGuildSettings(guildId);
        return s.autoReactions.enabled;
    }

    getAutoReactions(guildId) {
        const s = this.getGuildSettings(guildId);
        if (!s.autoReactions) {
            s.autoReactions = { enabled: false, reactions: [] };
            this.serverSettings.set(guildId, s);
        }
        return s.autoReactions;
    }

    getTriggeredReactions(guildId, content) {
        if (!content) return [];
        const s = this.getGuildSettings(guildId);
        if (!s.autoReactions?.enabled) return [];
        const triggered = [];
        for (const reaction of s.autoReactions.reactions) {
            let msg = content;
            let trig = reaction.trigger;
            if (!reaction.caseSensitive) { msg = msg.toLowerCase(); trig = trig.toLowerCase(); }
            if (msg.includes(trig)) triggered.push(reaction.emoji);
        }
        return triggered;
    }
}

module.exports = ServerSettingsManager;
module.exports.normalizeGuildPrefix = normalizeGuildPrefix;
