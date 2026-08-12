const { welcomePool } = require('../server/welcomeDb');
const fs   = require('fs');
const path = require('path');

const CREATE_TABLE_SQL = `
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
`;

class WelcomeSettingsManager {
    constructor() {
        this._cache = new Map();
        this._tableReady = false;
        this._init().catch(err =>
            console.error('[WELCOME SETTINGS] Init failed:', err.message)
        );
    }

    async _ensureTable() {
        if (this._tableReady) return;
        await welcomePool.query(CREATE_TABLE_SQL);
        this._tableReady = true;
    }

    async _init() {
        await this._ensureTable();
        await this._migrateFromServerSettingsJson();
        await this._loadAll();
        this._startReloadInterval();
    }

    /**
     * The dashboard writes welcome settings directly to the DB (a separate
     * process from the bot). Re-read the table periodically so dashboard saves
     * take effect without a bot restart (default 30s).
     */
    _startReloadInterval() {
        const ms = parseInt(process.env.SETTINGS_RELOAD_INTERVAL_MS, 10) || 30000;
        this._reloadTimer = setInterval(() => {
            this._loadAll().catch(err =>
                console.error('[WELCOME SETTINGS] Background reload failed:', err.message)
            );
        }, ms);
        this._reloadTimer.unref?.();
    }

    /**
     * One-time import of welcome fields from the legacy serverSettings.json
     * (or its .migrated copy) into the WELCOME_DATABASE_URL database.
     * Marks completion with a .welcome_migrated sentinel file so it never runs twice.
     */
    async _migrateFromServerSettingsJson() {
        // Try the already-processed file first, then the original
        const candidates = [
            path.join(__dirname, '../data/serverSettings.json.migrated'),
            path.join(__dirname, '../data/serverSettings.json'),
        ];
        const donePath = path.join(__dirname, '../data/serverSettings.json.welcome_migrated');

        if (fs.existsSync(donePath)) return; // already done

        const srcPath = candidates.find(p => fs.existsSync(p));
        if (!srcPath) return; // nothing to migrate

        try {
            const data = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
            let count = 0;

            for (const [guildId, s] of Object.entries(data)) {
                try {
                    await welcomePool.query(`
                        INSERT INTO welcome_settings (
                            guild_id, enabled, channel_id, message, banner_url, color,
                            dm_enabled, dm_message,
                            show_member_count, show_join_date, show_account_age,
                            custom_title, custom_footer, updated_at
                        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW())
                        ON CONFLICT (guild_id) DO NOTHING
                    `, [
                        guildId,
                        s.welcomeEnabled              || false,
                        s.welcomeChannelId             || null,
                        s.welcomeMessage               || 'Welcome to the server, {member}! Enjoy your stay!',
                        s.welcomeBannerUrl             || null,
                        s.welcomeColor                 || '#5865F2',
                        s.welcomeDmEnabled             || false,
                        s.welcomeDmMessage             || 'Hey {username}! Welcome to **{server}**!',
                        s.welcomeShowMemberCount       !== false,
                        s.welcomeShowJoinDate          !== false,
                        s.welcomeShowAccountAge        !== false,
                        s.welcomeCustomTitle           || null,
                        s.welcomeCustomFooter          || null,
                    ]);
                    count++;
                } catch (e) {
                    console.error(`[WELCOME SETTINGS] Migration: failed for guild ${guildId}:`, e.message);
                }
            }

            // Write sentinel so we never re-run
            fs.writeFileSync(donePath, new Date().toISOString());
            console.log(`[WELCOME SETTINGS] Migrated welcome settings for ${count} servers from legacy JSON.`);
        } catch (err) {
            console.error('[WELCOME SETTINGS] JSON migration failed:', err.message);
        }
    }

    async _loadAll() {
        try {
            const res = await welcomePool.query('SELECT * FROM welcome_settings');
            for (const row of res.rows) {
                this._cache.set(row.guild_id, this._rowToSettings(row));
            }
            console.log(`[WELCOME SETTINGS] Loaded settings for ${this._cache.size} servers.`);
        } catch (err) {
            console.error('[WELCOME SETTINGS] Failed to load settings:', err.message);
        }
    }

    _rowToSettings(row) {
        return {
            enabled: row.enabled,
            channelId: row.channel_id || null,
            message: row.message || 'Welcome to the server, {member}! Enjoy your stay!',
            bannerUrl: row.banner_url || null,
            color: row.color || '#5865F2',
            dmEnabled: row.dm_enabled,
            dmMessage: row.dm_message || 'Hey {username}! Welcome to **{server}**!',
            showMemberCount: row.show_member_count,
            showJoinDate: row.show_join_date,
            showAccountAge: row.show_account_age,
            customTitle: row.custom_title || null,
            customFooter: row.custom_footer || null,
        };
    }

    _defaults() {
        return {
            enabled: false,
            channelId: null,
            message: 'Welcome to the server, {member}! Enjoy your stay!',
            bannerUrl: null,
            color: '#5865F2',
            dmEnabled: false,
            dmMessage: 'Hey {username}! Welcome to **{server}**!',
            showMemberCount: true,
            showJoinDate: true,
            showAccountAge: true,
            customTitle: null,
            customFooter: null,
        };
    }

    getWelcomeSettings(guildId) {
        if (!this._cache.has(guildId)) {
            this._cache.set(guildId, this._defaults());
        }
        return this._cache.get(guildId);
    }

    _save(guildId) {
        this._saveAsync(guildId).catch(err =>
            console.error(`[WELCOME SETTINGS] Save failed for guild ${guildId}:`, err.message)
        );
    }

    async _saveAsync(guildId) {
        const s = this.getWelcomeSettings(guildId);
        await this._ensureTable();
        await welcomePool.query(`
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
            s.enabled, s.channelId, s.message, s.bannerUrl, s.color,
            s.dmEnabled, s.dmMessage,
            s.showMemberCount, s.showJoinDate, s.showAccountAge,
            s.customTitle, s.customFooter,
        ]);
    }

    _update(guildId, patch) {
        const s = this.getWelcomeSettings(guildId);
        Object.assign(s, patch);
        this._cache.set(guildId, s);
        this._save(guildId);
    }

    // ── Public API used by welcomeconfig.js and guildMemberAdd.js ────────────

    /** Used by /welcomeconfig enable and title/footer reset via updateGuildSetting */
    updateGuildSetting(guildId, key, value) {
        const keyMap = {
            welcomeEnabled: 'enabled',
            welcomeCustomTitle: 'customTitle',
            welcomeCustomFooter: 'customFooter',
        };
        const mapped = keyMap[key] || key;
        this._update(guildId, { [mapped]: value });
        return true;
    }

    setWelcomeChannel(guildId, channelId) { this._update(guildId, { channelId }); return true; }
    setWelcomeMessage(guildId, message)   { this._update(guildId, { message }); return true; }
    setWelcomeBanner(guildId, bannerUrl)  { this._update(guildId, { bannerUrl }); return true; }
    setWelcomeColor(guildId, color)       { this._update(guildId, { color }); return true; }
    setWelcomeDmMessage(guildId, dmMessage) { this._update(guildId, { dmMessage }); return true; }

    toggleWelcomeDm(guildId) {
        const s = this.getWelcomeSettings(guildId);
        const dmEnabled = !s.dmEnabled;
        this._update(guildId, { dmEnabled });
        return dmEnabled;
    }

    toggleWelcomeFeature(guildId, feature) {
        const valid = {
            welcomeShowMemberCount: 'showMemberCount',
            welcomeShowJoinDate:    'showJoinDate',
            welcomeShowAccountAge:  'showAccountAge',
        };
        if (!valid[feature]) return false;
        const s = this.getWelcomeSettings(guildId);
        const newValue = !s[valid[feature]];
        this._update(guildId, { [valid[feature]]: newValue });
        return newValue;
    }
}

module.exports = WelcomeSettingsManager;
