/**
 * Server-rendered guild settings tab pages.
 *
 * Each tab is a real HTML page at /guild/:guildId/<tab>. They share the guild
 * header + tab nav (from render/guild.js) and embed the channel/role data blob
 * the per-page client scripts read. Settings forms are pre-populated from the
 * server-fetched config, so the page is usable before any JS runs; the JS only
 * adds interactivity (color sync, dynamic rows, save → PATCH /api).
 */

const constants = require('../constants');
const { esc, channelOptions, roleOptions, render } = require('./layout');
const { guildDataScript, guildHeaderHTML, tabNavHTML, TABS } = require('./guild');

const { LOG_EVENTS, AUTOMOD_RULES, AUTOMOD_ACTIONS } = constants;

// Wrap guild-tab body in the shared shell (header + tabs + data blob + page JS).
function guildTab({ guild, active, panelHTML, scripts, title, user }) {
    const body = `
    ${guildHeaderHTML(guild)}
    ${tabNavHTML(guild.id, active)}
    ${panelHTML}
    ${guildDataScript({ guildId: guild.id, channels: guild._channels || [], roles: guild._roles || [] })}`;
    return render({
        title: title || `PrimeBot · ${guild.name}`,
        body,
        active: 'servers',
        scripts,
        user,
    });
}

// ── Welcome ─────────────────────────────────────────────────────────────────

function welcomePanelHTML(w, channels) {
    const s = w || {};
    return `
    <div class="card">
      <div class="card-title"><span><span class="icon">👋</span> Welcome messages</span></div>
      <p class="card-desc">Greet new members with a customizable message, banner and optional DM.</p>

      <div class="switch-row">
        <div class="switch-label">
          <div class="sl-title">Enable welcome messages</div>
          <div class="sl-desc">Send a welcome message when a member joins the server.</div>
        </div>
        <label class="switch"><input type="checkbox" id="welcome-enabled" ${s.enabled ? 'checked' : ''}/><span class="slider"></span></label>
      </div>

      <div class="field">
        <label class="field-label" for="welcome-channel">Welcome channel</label>
        <select id="welcome-channel" data-channel-select>${channelOptions(channels, s.channelId)}</select>
        <div class="field-hint">Where the welcome message is posted.</div>
      </div>

      <div class="field">
        <label class="field-label" for="welcome-message">Welcome message</label>
        <textarea id="welcome-message" placeholder="Welcome to the server, {member}! Enjoy your stay!">${esc(s.message || '')}</textarea>
        <div class="field-hint">Placeholders: <code>{member}</code>, <code>{username}</code>, <code>{server}</code></div>
      </div>

      <div class="field">
        <label class="field-label" for="welcome-banner">Banner image URL</label>
        <input type="url" id="welcome-banner" value="${esc(s.bannerUrl || '')}" placeholder="https://…/banner.png" />
        <div class="field-hint">Optional image shown on the welcome embed.</div>
      </div>

      <div class="field">
        <label class="field-label">Embed color</label>
        <div class="color-field">
          <input type="color" id="welcome-color" value="${esc(s.color || '#5865F2')}" />
          <input type="text" id="welcome-color-text" value="${esc(s.color || '#5865F2')}" style="flex:1" />
        </div>
      </div>

      <div class="switch-row">
        <div class="switch-label">
          <div class="sl-title">Send a welcome DM</div>
          <div class="sl-desc">Privately message new members with a custom onboarding note.</div>
        </div>
        <label class="switch"><input type="checkbox" id="welcome-dm-enabled" ${s.dmEnabled ? 'checked' : ''}/><span class="slider"></span></label>
      </div>

      <div class="field">
        <label class="field-label" for="welcome-dm-message">DM message</label>
        <textarea id="welcome-dm-message" placeholder="Hey {username}! Welcome to **{server}**!">${esc(s.dmMessage || '')}</textarea>
      </div>

      <div class="switch-row">
        <div class="switch-label"><div class="sl-title">Show member count</div></div>
        <label class="switch"><input type="checkbox" id="welcome-show-count" ${s.showMemberCount ? 'checked' : ''}/><span class="slider"></span></label>
      </div>
      <div class="switch-row">
        <div class="switch-label"><div class="sl-title">Show join date</div></div>
        <label class="switch"><input type="checkbox" id="welcome-show-join" ${s.showJoinDate ? 'checked' : ''}/><span class="slider"></span></label>
      </div>
      <div class="switch-row">
        <div class="switch-label"><div class="sl-title">Show account age</div></div>
        <label class="switch"><input type="checkbox" id="welcome-show-age" ${s.showAccountAge ? 'checked' : ''}/><span class="slider"></span></label>
      </div>

      <div class="field">
        <label class="field-label" for="welcome-title">Custom title (optional)</label>
        <input type="text" id="welcome-title" value="${esc(s.customTitle || '')}" placeholder="Welcome!" />
      </div>
      <div class="field">
        <label class="field-label" for="welcome-footer">Custom footer (optional)</label>
        <input type="text" id="welcome-footer" value="${esc(s.customFooter || '')}" placeholder="Powered by PrimeBot" />
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" data-save="welcome">Save welcome settings</button>
      </div>
    </div>`;
}

function welcomePage({ guild, user }) {
    return guildTab({
        guild, user, active: 'welcome',
        panelHTML: welcomePanelHTML(guild._config.welcome, guild._channels),
        scripts: ['/js/guild-common.js', '/js/settings-basic.js'],
    });
}

// ── Leveling ────────────────────────────────────────────────────────────────

function levelingPage({ guild, user }) {
    const lev = guild._config.server?.leveling || {};
    const panelHTML = `
    <div class="card">
      <div class="card-title"><span><span class="icon">📈</span> Leveling &amp; XP</span></div>
      <p class="card-desc">Reward members with XP for chatting and earn badges as they level up.</p>

      <div class="switch-row">
        <div class="switch-label">
          <div class="sl-title">Enable leveling</div>
          <div class="sl-desc">Track XP and levels for members in this server.</div>
        </div>
        <label class="switch"><input type="checkbox" id="leveling-enabled" ${lev.enabled ? 'checked' : ''}/><span class="slider"></span></label>
      </div>

      <div class="field">
        <label class="field-label" for="leveling-channel">Level-up announcement channel</label>
        <select id="leveling-channel" data-channel-select>${channelOptions(guild._channels, lev.levelUpChannelId)}</select>
        <div class="field-hint">Where level-up messages are sent.</div>
      </div>

      <div class="field">
        <label class="field-label" for="leveling-multiplier">XP multiplier</label>
        <input type="number" id="leveling-multiplier" min="0.1" max="5" step="0.1" value="${esc(lev.xpMultiplier ?? 1)}" />
        <div class="field-hint">Multiply earned XP by this factor (0.1 – 5.0). Default is 1.</div>
      </div>

      <div class="field">
        <label class="field-label" for="leveling-cooldown">XP cooldown (seconds)</label>
        <input type="number" id="leveling-cooldown" min="5" max="300" step="1" value="${esc(lev.xpCooldown ? lev.xpCooldown / 1000 : 60)}" />
        <div class="field-hint">Time between XP gains per user (5 – 300 seconds).</div>
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" data-save="leveling">Save leveling settings</button>
      </div>
    </div>`;
    return guildTab({ guild, user, active: 'leveling', panelHTML, scripts: ['/js/guild-common.js', '/js/settings-basic.js'] });
}

// ── Prefix ──────────────────────────────────────────────────────────────────

function prefixPage({ guild, user }) {
    const prefix = guild._config.server?.prefix || '$';
    const panelHTML = `
    <div class="card">
      <div class="card-title"><span><span class="icon">⚡</span> Command prefix</span></div>
      <p class="card-desc">Set a custom prefix for text commands in this server (max 3 characters, no spaces).</p>
      <div class="field">
        <label class="field-label" for="prefix-value">Prefix</label>
        <input type="text" id="prefix-value" maxlength="3" value="${esc(prefix)}" style="max-width:120px" />
        <div class="field-hint">Members will type this before text commands, e.g. <code>${esc(prefix)}help</code></div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" data-save="prefix">Save prefix</button>
      </div>
    </div>`;
    return guildTab({ guild, user, active: 'prefix', panelHTML, scripts: ['/js/guild-common.js', '/js/settings-basic.js'] });
}

// ── Auto-reactions ──────────────────────────────────────────────────────────

function reactionRowHTML(r) {
    return `
    <div class="reaction-row" data-index="">
      <input type="text" class="r-trigger" value="${esc(r.trigger || '')}" placeholder="trigger word" />
      <input type="text" class="r-emoji" value="${esc(r.emoji || '')}" placeholder="🎉" maxlength="30" />
      <button class="reaction-remove" type="button">✕</button>
    </div>`;
}

function reactionsPage({ guild, user }) {
    const ar = guild._config.server?.autoReactions || { enabled: false, reactions: [] };
    const rows = (ar.reactions || []).map(r => reactionRowHTML(r)).join('');
    const panelHTML = `
    <div class="card">
      <div class="card-title"><span><span class="icon">🔁</span> Auto-reactions</span></div>
      <p class="card-desc">Automatically react to messages containing a trigger word with an emoji.</p>

      <div class="switch-row">
        <div class="switch-label">
          <div class="sl-title">Enable auto-reactions</div>
          <div class="sl-desc">Master switch for all trigger rules below.</div>
        </div>
        <label class="switch"><input type="checkbox" id="reactions-enabled" ${ar.enabled ? 'checked' : ''}/><span class="slider"></span></label>
      </div>

      <div class="field">
        <label class="field-label">Reaction rules</label>
        <div class="reactions-list" id="reactions-list">${rows}</div>
        <button class="btn btn-secondary" id="reaction-add">+ Add rule</button>
        <div class="field-hint">Trigger is matched as a substring of the message.</div>
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" data-save="reactions">Save auto-reactions</button>
      </div>
    </div>`;
    return guildTab({ guild, user, active: 'reactions', panelHTML, scripts: ['/js/guild-common.js', '/js/settings-basic.js'] });
}

// ── Broadcasts ──────────────────────────────────────────────────────────────

function broadcastPage({ guild, user }) {
    const server = guild._config.server;
    const panelHTML = `
    <div class="card">
      <div class="card-title"><span><span class="icon">📢</span> Broadcasts</span></div>
      <p class="card-desc">Choose whether this server receives official PrimeBot broadcast announcements.</p>

      <div class="switch-row">
        <div class="switch-label">
          <div class="sl-title">Receive broadcasts</div>
          <div class="sl-desc">Allow PrimeBot announcements to be posted in this server.</div>
        </div>
        <label class="switch"><input type="checkbox" id="broadcast-enabled" ${server?.receiveBroadcasts ? 'checked' : ''}/><span class="slider"></span></label>
      </div>

      <div class="field">
        <label class="field-label" for="broadcast-channel">Broadcast channel</label>
        <select id="broadcast-channel" data-channel-select>${channelOptions(guild._channels, server?.broadcastChannelId)}</select>
        <div class="field-hint">Where broadcast messages are posted.</div>
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" data-save="broadcast">Save broadcast settings</button>
      </div>
    </div>`;
    return guildTab({ guild, user, active: 'broadcast', panelHTML, scripts: ['/js/guild-common.js', '/js/settings-basic.js'] });
}

// ── Logging ─────────────────────────────────────────────────────────────────

function loggingPanelHTML(logging, channels) {
    const s = logging || {};
    const enabled = new Set(Array.isArray(s.events) ? s.events : []);
    const categories = [...new Set(LOG_EVENTS.map(e => e.category))];
    const eventToggles = categories.map(cat => {
        const items = LOG_EVENTS.filter(e => e.category === cat)
            .map(e => `
        <label class="switch mini">
          <input type="checkbox" class="log-event" data-event="${esc(e.key)}" ${enabled.has(e.key) ? 'checked' : ''}/>
          <span class="slider"></span>
          <span class="switch-text">${e.icon} ${esc(e.label)}</span>
        </label>`).join('');
        return `<div class="event-group"><div class="event-group-title">${esc(cat)}</div>${items}</div>`;
    }).join('');
    return `
    <div class="card">
      <div class="card-title"><span><span class="icon">📜</span> Server logging</span></div>
      <p class="card-desc">Send rich embed logs of server events to a channel and/or a Discord webhook.</p>

      <div class="switch-row">
        <div class="switch-label">
          <div class="sl-title">Enable logging</div>
          <div class="sl-desc">Master switch. When off, no log embeds are sent for this server.</div>
        </div>
        <label class="switch"><input type="checkbox" id="logging-enabled" ${s.enabled ? 'checked' : ''}/><span class="slider"></span></label>
      </div>

      <div class="field">
        <label class="field-label" for="logging-channel">Log channel</label>
        <select id="logging-channel" data-channel-select>${channelOptions(channels, s.channelId)}</select>
        <div class="field-hint">Channel where log embeds are posted as the bot. The bot needs View Channel + Send Messages here.</div>
      </div>

      <div class="field">
        <label class="field-label" for="logging-webhook">Webhook URL (optional)</label>
        <input type="url" id="logging-webhook" value="${esc(s.webhookUrl || '')}" placeholder="https://discord.com/api/webhooks/…" />
        <div class="field-hint">When set, logs are also posted via this webhook. Works in channels the bot can't see. <a href="https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks" target="_blank" rel="noopener">How to make one →</a></div>
      </div>

      <div class="field">
        <label class="field-label" for="logging-webhook-name">Webhook display name</label>
        <input type="text" id="logging-webhook-name" maxlength="100" value="${esc(s.webhookName || 'PrimeBot Logs')}" placeholder="PrimeBot Logs" />
        <div class="field-hint">Name shown on webhook-delivered logs.</div>
      </div>

      <div class="switch-row">
        <div class="switch-label">
          <div class="sl-title">Include bot activity</div>
          <div class="sl-desc">Also log actions performed by bots (off by default to reduce noise).</div>
        </div>
        <label class="switch"><input type="checkbox" id="logging-include-bots" ${s.includeBots ? 'checked' : ''}/><span class="slider"></span></label>
      </div>

      <div class="field">
        <label class="field-label">Embed color</label>
        <div class="color-field">
          <input type="color" id="logging-color" value="${esc(s.color || '#5865F2')}" />
          <input type="text" id="logging-color-text" value="${esc(s.color || '#5865F2')}" style="flex:1" />
        </div>
        <div class="field-hint">Default color for log embeds (some event types override this).</div>
      </div>

      <div class="field">
        <label class="field-label">Logged events</label>
        <div class="event-grid">${eventToggles}</div>
        <div class="field-hint">Choose which event types generate a log embed.</div>
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" data-save="logging">Save logging settings</button>
      </div>
    </div>`;
}

function loggingPage({ guild, user }) {
    return guildTab({
        guild, user, active: 'logging',
        panelHTML: loggingPanelHTML(guild._config.logging, guild._channels),
        scripts: ['/js/guild-common.js', '/js/settings-basic.js'],
    });
}

// ── Reaction Roles ──────────────────────────────────────────────────────────

const RR_MODES = [
    { value: 'normal', label: 'Normal — toggle on/off' },
    { value: 'sticky', label: 'Sticky — one-click assign (no toggle-off)' },
    { value: 'verify', label: 'Verify — grant once, no remove' },
    { value: 'unique', label: 'Unique — only one role at a time' },
];

function rrMappingRowHTML(m = {}) {
    const roleOpt = m.roleId ? `<option value="${esc(m.roleId)}" selected>Role</option>` : '';
    return `
    <div class="reaction-row" data-index="">
      <input type="text" class="r-emoji" value="${esc(m.emoji || '')}" placeholder="🎉 or <:name:id>" maxlength="100" />
      <select class="r-role" data-role-select data-placeholder="Role">${roleOpt}</select>
      <input type="text" class="r-label" value="${esc(m.label || '')}" placeholder="label (optional)" maxlength="100" />
      <button class="reaction-remove" type="button">✕</button>
    </div>`;
}

function rrMenuCardHTML(menu) {
    const mappings = (menu.mappings || []).map(m => {
        const e = /^\w+:\d+$/.test(m.emoji) ? `<:${m.emoji}>` : esc(m.emoji);
        return `${e} → <@&${esc(m.roleId)}>${m.label ? ' — ' + esc(m.label) : ''}`;
    }).join('<br/>');
    return `
    <div class="card rr-menu-card" data-menu="${menu.id}">
      <div class="card-title">
        <span><span class="icon">🎭</span> ${esc(menu.title || 'Untitled menu')} <span class="tag ${menu.enabled ? 'on' : 'off'}">#${menu.id}</span></span>
        <button class="btn btn-secondary btn-sm rr-delete" data-menu="${menu.id}">Delete</button>
      </div>
      <div class="rr-meta">
        <span><strong>Channel:</strong> <#${esc(menu.channelId)}></span>
        <span><strong>Message:</strong> <code>${esc(menu.messageId)}</code></span>
        <span><strong>Mode:</strong> <code>${esc(menu.mode)}</code></span>
        <span><strong>Persistent:</strong> ${menu.persistent ? '✅' : '⛔'}</span>
        <span><strong>Bot reactions:</strong> ${menu.includeBots ? '✅' : '⛔'}</span>
      </div>
      <div class="rr-mappings">${mappings || '<em>No mappings</em>'}</div>
      ${menu.requiredRoleId ? `<div class="field-hint">Requires <@&${esc(menu.requiredRoleId)}></div>` : ''}
      ${menu.exclusiveRoleId ? `<div class="field-hint">Removes <@&${esc(menu.exclusiveRoleId)}> on assign</div>` : ''}
      <button class="btn btn-secondary btn-sm rr-edit" data-menu="${menu.id}" style="margin-top:8px">Edit</button>
    </div>`;
}

function reactionRolesPage({ guild, user }) {
    const menus = guild._config.reactionRoles || [];
    const listHTML = menus.length
        ? menus.map(rrMenuCardHTML).join('')
        : `<div class="alert alert-warn">No reaction-role menus yet. Create one below.</div>`;
    const modeOpts = RR_MODES.map(m => `<option value="${m.value}">${esc(m.label)}</option>`).join('');
    const panelHTML = `
    <div class="card">
      <div class="card-title"><span><span class="icon">🎭</span> Reaction Roles</span></div>
      <p class="card-desc">Let members self-assign roles by reacting. PrimeBot gives you premium modes for free: <strong>toggle</strong>, <strong>sticky</strong> (one-click assign), <strong>verify</strong> (grant once, e.g. rules gate), and <strong>unique</strong> (only one role at a time). Roles persist across bot restarts.</p>
      <div class="rr-list">${listHTML}</div>
    </div>

    <div class="card">
      <div class="card-title"><span>Create a new menu</span></div>

      <div class="switch-row">
        <div class="switch-label">
          <div class="sl-title">Attach to an existing message</div>
          <div class="sl-desc">When ON, the bot adds reactions to a message you already posted (by message ID). When OFF, the bot posts a fresh role embed.</div>
        </div>
        <label class="switch"><input type="checkbox" id="rr-attach"/><span class="slider"></span></label>
      </div>

      <div class="field" id="rr-message-field" style="display:none">
        <label class="field-label" for="rr-message-id">Message ID to attach to</label>
        <input type="text" id="rr-message-id" placeholder="123456789012345678" />
        <div class="field-hint">Right-click any message → Copy Message ID (enable Developer Mode in Discord settings).</div>
      </div>

      <div class="field">
        <label class="field-label" for="rr-channel">Channel</label>
        <select id="rr-channel" data-channel-select>${channelOptions(guild._channels)}</select>
        <div class="field-hint">Where the role embed is posted (or where the target message lives).</div>
      </div>

      <div class="field">
        <label class="field-label" for="rr-title">Embed title / menu label</label>
        <input type="text" id="rr-title" maxlength="255" placeholder="Pick your roles!" />
        <div class="field-hint">Shown as the embed title (bot-created) and as the menu label in the dashboard.</div>
      </div>

      <div class="field" id="rr-description-field">
        <label class="field-label" for="rr-description">Embed description</label>
        <textarea id="rr-description" placeholder="React below to give yourself a role!"></textarea>
        <div class="field-hint">Body text of the role embed (hidden when attaching to an existing message).</div>
      </div>

      <div class="field">
        <label class="field-label">Emoji → role mappings</label>
        <div class="reactions-list" id="rr-mappings-list">${rrMappingRowHTML()}</div>
        <button class="btn btn-secondary" id="rr-mapping-add">+ Add mapping</button>
        <div class="field-hint">Use a unicode emoji or a custom emoji reference like <code>&lt;:name:id&gt;</code>.</div>
      </div>

      <div class="field">
        <label class="field-label" for="rr-mode">Behavior mode</label>
        <select id="rr-mode">${modeOpts}</select>
        <div class="field-hint">Premium modes — all free.</div>
      </div>

      <div class="field">
        <label class="field-label">Embed color</label>
        <div class="color-field">
          <input type="color" id="rr-color" value="#5865F2" />
          <input type="text" id="rr-color-text" value="#5865F2" style="flex:1" />
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="rr-required-role">Required role (optional)</label>
        <select id="rr-required-role" data-role-select data-placeholder="— Anyone —">${roleOptions(guild._roles)}</select>
        <div class="field-hint">Members must have this role to use the menu.</div>
      </div>

      <div class="field">
        <label class="field-label" for="rr-exclusive-role">Exclusive role (optional)</label>
        <select id="rr-exclusive-role" data-role-select data-placeholder="— None —">${roleOptions(guild._roles)}</select>
        <div class="field-hint">Removed from a member when they take a role from this menu (cross-menu mutual exclusion).</div>
      </div>

      <div class="switch-row">
        <div class="switch-label"><div class="sl-title">Persistent</div><div class="sl-desc">Re-apply roles on bot restart by reading the message's reactions.</div></div>
        <label class="switch"><input type="checkbox" id="rr-persistent" checked/><span class="slider"></span></label>
      </div>
      <div class="switch-row">
        <div class="switch-label"><div class="sl-title">Allow bots</div><div class="sl-desc">Let bots trigger the menu too (off by default).</div></div>
        <label class="switch"><input type="checkbox" id="rr-include-bots"/><span class="slider"></span></label>
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" id="rr-create">Create reaction-role menu</button>
      </div>
    </div>`;
    return guildTab({ guild, user, active: 'reactionroles', panelHTML, scripts: ['/js/guild-common.js', '/js/reactionroles.js'] });
}

// ── Tickets ─────────────────────────────────────────────────────────────────

const TICKET_BUTTON_STYLES = [
    { value: 'Primary', label: 'Blurple (Primary)' },
    { value: 'Secondary', label: 'Grey (Secondary)' },
    { value: 'Success', label: 'Green (Success)' },
    { value: 'Danger', label: 'Red (Danger)' },
];
const TICKET_MESSAGE_TYPES = [
    { value: 'embed', label: 'Embed message' },
    { value: 'plain', label: 'Plain text message' },
];

function ticketRoleRowHTML(selected = {}, prefix = 'tk-support') {
    const roleOpt = selected.roleId ? `<option value="${esc(selected.roleId)}" selected>Role</option>` : '';
    return `
    <div class="reaction-row" data-index="">
      <select class="${prefix}-role" data-role-select data-placeholder="Role">${roleOpt}</select>
      <button class="reaction-remove" type="button">✕</button>
    </div>`;
}

function ticketsPage({ guild, user }) {
    const panels = guild._config.ticketPanels || [];
    const listHTML = panels.length
        ? '' // cards are rendered client-side after refresh; show a placeholder
        : `<div class="alert alert-warn">No ticket panels yet. Create one below — panels can only be configured from the dashboard.</div>`;
    const styleOpts = TICKET_BUTTON_STYLES.map(s => `<option value="${s.value}">${esc(s.label)}</option>`).join('');
    const typeOpts = TICKET_MESSAGE_TYPES.map(t => `<option value="${t.value}">${esc(t.label)}</option>`).join('');
    const panelHTML = `
    <div class="card">
      <div class="card-title"><span><span class="icon">🎫</span> Tickets</span></div>
      <p class="card-desc">Ticket panels are configurable <strong>only from the dashboard</strong> — slash and prefix ticket commands are disabled. Build a panel (embed or plain message, custom button, support/ping roles, claim button, per-user limits), then <strong>Send</strong> it to a channel and use <strong>Update message</strong> to re-render an existing message by id.</p>
      <div class="rr-list">${listHTML}</div>
    </div>

    <div class="card">
      <div class="card-title"><span>Create / edit a panel</span></div>
      <div class="field">
        <label class="field-label" for="tk-name">Panel name</label>
        <input type="text" id="tk-name" maxlength="100" placeholder="Support Ticket" />
        <div class="field-hint">Unique per server. Shown as the ticket title and in the dashboard list.</div>
      </div>
      <div class="field">
        <label class="field-label" for="tk-message-type">Message type</label>
        <select id="tk-message-type">${typeOpts}</select>
        <div class="field-hint">Embed (rich) or plain text. The open-ticket button is always attached.</div>
      </div>
      <div class="field">
        <label class="field-label" for="tk-title">Embed title</label>
        <input type="text" id="tk-title" maxlength="255" placeholder="🎫 Support Tickets" />
      </div>
      <div class="field">
        <label class="field-label" for="tk-description">Embed description</label>
        <textarea id="tk-description" placeholder="Click the button below to open a support ticket."></textarea>
      </div>
      <div class="field">
        <label class="field-label" for="tk-content">Content / @mentions (above embed, or plain body)</label>
        <textarea id="tk-content" placeholder="Optional: @support or any text shown above the embed / as the plain body."></textarea>
      </div>
      <div class="field">
        <label class="field-label" for="tk-footer">Embed footer text</label>
        <input type="text" id="tk-footer" maxlength="255" placeholder="PrimeBot · Tickets" />
      </div>
      <div class="field">
        <label class="field-label" for="tk-thumbnail">Thumbnail image URL</label>
        <input type="text" id="tk-thumbnail" placeholder="https://…/icon.png" />
      </div>
      <div class="field">
        <label class="field-label" for="tk-image">Large image URL</label>
        <input type="text" id="tk-image" placeholder="https://…/banner.png" />
      </div>
      <div class="field">
        <label class="field-label">Embed color</label>
        <div class="color-field">
          <input type="color" id="tk-color" value="#5865F2" />
          <input type="text" id="tk-color-text" value="#5865F2" style="flex:1" />
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="tk-button-label">Open button label</label>
        <input type="text" id="tk-button-label" maxlength="80" value="Open Ticket" />
      </div>
      <div class="field">
        <label class="field-label" for="tk-button-emoji">Open button emoji (optional)</label>
        <input type="text" id="tk-button-emoji" maxlength="100" placeholder="🎫" />
      </div>
      <div class="field">
        <label class="field-label" for="tk-button-style">Open button style</label>
        <select id="tk-button-style">${styleOpts}</select>
      </div>
      <div class="field">
        <label class="field-label" for="tk-category">Ticket category label</label>
        <input type="text" id="tk-category" maxlength="50" value="general" />
      </div>
      <div class="field">
        <label class="field-label" for="tk-ticket-name">Ticket channel name (optional)</label>
        <input type="text" id="tk-ticket-name" maxlength="100" placeholder="Defaults to ticket-username" />
      </div>
      <div class="field">
        <label class="field-label" for="tk-open-name">Channel name when OPEN</label>
        <input type="text" id="tk-open-name" maxlength="100" placeholder="(open) {name}" />
        <div class="field-hint">Template applied when a ticket opens/reopens. Placeholders: {name} (ticket name or username), {username}, {id}, {panel}. Blank = no rename.</div>
      </div>
      <div class="field">
        <label class="field-label" for="tk-claimed-name">Channel name when CLAIMED</label>
        <input type="text" id="tk-claimed-name" maxlength="100" placeholder="(solved) {name}" />
        <div class="field-hint">Template applied when support claims the ticket. Same placeholders. Blank = no rename.</div>
      </div>
      <div class="field">
        <label class="field-label" for="tk-closed-name">Channel name when CLOSED</label>
        <input type="text" id="tk-closed-name" maxlength="100" placeholder="(closed) {name}" />
        <div class="field-hint">Template applied when the ticket is closed (visible for archived threads). Same placeholders. Blank = no rename.</div>
      </div>
      <div class="field">
        <label class="field-label">Support roles (can see tickets)</label>
        <div class="reactions-list" id="tk-support-list">${ticketRoleRowHTML({}, 'tk-support')}</div>
        <button class="btn btn-secondary" id="tk-support-add">+ Add role</button>
      </div>
      <div class="field">
        <label class="field-label">Ping roles (mentioned on open)</label>
        <div class="reactions-list" id="tk-ping-list">${ticketRoleRowHTML({}, 'tk-ping')}</div>
        <button class="btn btn-secondary" id="tk-ping-add">+ Add role</button>
      </div>
      <div class="field">
        <label class="field-label" for="tk-ticket-category-id">Discord channel category ID (optional)</label>
        <input type="text" id="tk-ticket-category-id" placeholder="123456789012345678" />
        <div class="field-hint">Created ticket channels open under this category. Leave blank to use the current channel / threads.</div>
      </div>
      <div class="field">
        <label class="field-label" for="tk-max-open">Max open tickets per user</label>
        <input type="number" id="tk-max-open" min="0" value="1" />
      </div>
      <div class="switch-row">
        <div class="switch-label"><div class="sl-title">Ask for reason on open</div><div class="sl-desc">Prompt the member for a reason (captured on the ticket). Note: requires a follow-up flow; the button still opens a ticket.</div></div>
        <label class="switch"><input type="checkbox" id="tk-ask-reason"/><span class="slider"></span></label>
      </div>
      <div class="field">
        <label class="field-label" for="tk-welcome">In-ticket welcome message</label>
        <textarea id="tk-welcome" placeholder="Welcome to your support ticket! Please describe your issue."></textarea>
      </div>
      <div class="field">
        <label class="field-label" for="tk-close-label">Close button label</label>
        <input type="text" id="tk-close-label" maxlength="80" value="Close Ticket" />
      </div>
      <div class="field">
        <label class="field-label" for="tk-close-emoji">Close button emoji (optional)</label>
        <input type="text" id="tk-close-emoji" maxlength="100" value="🔒" />
      </div>
      <div class="field">
        <label class="field-label" for="tk-claim-label">Claim button label (optional — leave blank for no claim button)</label>
        <input type="text" id="tk-claim-label" maxlength="80" placeholder="Claim" />
      </div>
      <div class="field">
        <label class="field-label" for="tk-claim-emoji">Claim button emoji (optional)</label>
        <input type="text" id="tk-claim-emoji" maxlength="100" placeholder="✋" />
      </div>
      <div class="switch-row">
        <div class="switch-label"><div class="sl-title">Enabled</div><div class="sl-desc">When off, the open button is disabled.</div></div>
        <label class="switch"><input type="checkbox" id="tk-enabled" checked/><span class="slider"></span></label>
      </div>
      <div class="form-actions">
        <input type="hidden" id="tk-edit-id" value="" />
        <button class="btn btn-primary" id="tk-save">Create panel</button>
        <button class="btn btn-secondary" id="tk-cancel-edit" style="display:none">Cancel edit</button>
      </div>
    </div>`;
    return guildTab({ guild, user, active: 'tickets', panelHTML, scripts: ['/js/guild-common.js', '/js/tickets.js'] });
}

// ── Automod ─────────────────────────────────────────────────────────────────

function automodPage({ guild, user }) {
    const s = guild._config.automod || {};
    const rules = Array.isArray(s.rules) ? s.rules : [];
    // Render existing rule rows server-side.
    const warnActions = AUTOMOD_ACTIONS.filter(a => ['warn', 'timeout', 'kick', 'ban'].includes(a.key));
    const dmKeys = ['delete', 'warn', 'timeout', 'kick', 'ban', 'escalation'];
    const dmMessages = s.dmMessages || {};
    const ruleRows = rules.map(rule => {
        const meta = AUTOMOD_RULES.find(r => r.key === rule.type) || AUTOMOD_RULES[0];
        const selected = Array.isArray(rule.actions) && rule.actions.length ? rule.actions : (rule.action ? [rule.action] : ['delete']);
        const actionChecks = AUTOMOD_ACTIONS.map(a =>
            `<label class="switch mini am-action-label"><input type="checkbox" class="am-action" value="${a.key}" ${selected.includes(a.key) ? 'checked' : ''}/><span class="switch-text">${a.icon} ${esc(a.label)}</span></label>`
        ).join('');
        let extra = '';
        if (meta.params.includes('words')) extra = `<input type="text" class="am-words" value="${esc((rule.words || []).join(', '))}" placeholder="extra domains/terms (comma-separated)" />`;
        if (meta.params.includes('threshold')) extra += `<input type="number" class="am-threshold" value="${rule.threshold ?? ''}" placeholder="threshold" min="1" style="width:96px" />`;
        if (meta.params.includes('seconds')) extra += `<input type="number" class="am-seconds" value="${rule.seconds ?? ''}" placeholder="seconds" min="1" max="3600" style="width:96px" />`;
        return `
      <div class="reaction-row am-rule-row" data-type="${esc(meta.key)}">
        <label class="switch mini"><input type="checkbox" class="am-enabled" ${rule.enabled !== false ? 'checked' : ''}/><span class="slider"></span></label>
        <span class="am-rule-label">${meta.icon} ${esc(meta.label)}</span>
        <div class="am-actions-group">${actionChecks}</div>
        ${extra}
        <button class="reaction-remove am-remove" type="button">✕</button>
      </div>`;
    }).join('');
    const addTypeOpts = AUTOMOD_RULES.map(r => `<option value="${r.key}">${r.icon} ${esc(r.label)}</option>`).join('');
    const warnActionChecks = warnActions.map(a =>
        `<label class="switch mini am-action-label"><input type="checkbox" class="am-warn-action" value="${a.key}" ${(s.warnActions || [s.warnAction || 'timeout']).includes(a.key) ? 'checked' : ''}/><span class="switch-text">${a.icon} ${esc(a.label)}</span></label>`
    ).join('');
    const dmRows = dmKeys.map(k => {
        const a = AUTOMOD_ACTIONS.find(x => x.key === k);
        const label = a ? `${a.icon} ${a.label}` : (k === 'escalation' ? '🚫 Escalation' : k);
        return `<div class="field-row"><label class="field-label" style="min-width:120px">${label}</label><input type="text" class="am-dm-message" data-key="${k}" value="${esc(dmMessages[k] || '')}" placeholder="(use default)" style="flex:1"/></div>`;
    }).join('');

    const panelHTML = `
    <div class="card">
      <div class="card-title"><span><span class="icon">🛡️</span> Premium Automod</span></div>
      <p class="card-desc">Automatic moderation that scans every message against your rules. Premium features for free: blocked words, invite/bad-link/NSFW filtering, spam &amp; mass-mention detection, caps/emoji/repeated-char/new-account filters, multi-action punishment, DM notifications, warning escalation, and appeals.</p>

      <div class="switch-row">
        <div class="switch-label"><div class="sl-title">Enable Automod</div><div class="sl-desc">Master switch. When off, no messages are scanned.</div></div>
        <label class="switch"><input type="checkbox" id="am-enabled" ${s.enabled ? 'checked' : ''}/><span class="slider"></span></label>
      </div>

      <div class="field">
        <label class="field-label" for="am-log-channel">Automod log channel (optional)</label>
        <select id="am-log-channel" data-channel-select>${channelOptions(guild._channels, s.logChannelId)}</select>
        <div class="field-hint">Where automod actions are posted as the bot.</div>
      </div>

      <div class="field">
        <label class="field-label" for="am-mute-role">Mute role (optional)</label>
        <select id="am-mute-role" data-role-select data-placeholder="— None (use timeouts) —">${roleOptions(guild._roles, s.muteRoleId)}</select>
        <div class="field-hint">Used for mutes when the bot can't apply a native timeout. Set this to enable indefinite mutes.</div>
      </div>

      <div class="field">
        <label class="field-label">Exempt roles</label>
        <div class="field-hint">Members with these roles (and admins) are never actioned.</div>
        <div class="rr-list" id="am-exempt-roles"></div>
      </div>

      <div class="field">
        <label class="field-label">Exempt channels</label>
        <div class="field-hint">Messages in these channels are never scanned.</div>
        <div class="rr-list" id="am-exempt-channels"></div>
      </div>

      <div class="field">
        <label class="field-label">Rules</label>
        <div class="reactions-list" id="am-rules-list">${ruleRows}</div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px">
          <select id="am-add-type">${addTypeOpts}</select>
          <button class="btn btn-secondary" id="am-add-rule">+ Add rule</button>
        </div>
        <div class="field-hint">Select one or more actions per rule. "Delete" is always applied first when chosen.</div>
      </div>

      <div class="field">
        <label class="field-label">Warning escalation</label>
        <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap">
          <label>After <input type="number" id="am-warn-threshold" value="${s.warnThreshold ?? 3}" min="1" max="50" style="width:72px"/> warnings</label>
          <span>→ apply:</span>
        </div>
        <div class="am-actions-group" id="am-warn-actions-group" style="margin-top:6px">${warnActionChecks}</div>
        <div class="field-hint">When a member's total warnings reach the threshold, these actions apply automatically and their warnings are cleared. Select multiple to escalate through several punishments at once.</div>
      </div>

      <div class="switch-row">
        <div class="switch-label"><div class="sl-title">DM punished members</div><div class="sl-desc">Send a direct message to members when an action is taken against them.</div></div>
        <label class="switch"><input type="checkbox" id="am-dm-enabled" ${s.dmEnabled !== false ? 'checked' : ''}/><span class="slider"></span></label>
      </div>

      <div class="field">
        <label class="field-label">Custom DM messages (optional)</label>
        <div class="field-hint">Override the default message sent for each action. Placeholders: {server}, {reason}, {action}, {threshold}. Leave blank to use the default.</div>
        <div class="field-rows" id="am-dm-messages">${dmRows}</div>
      </div>

      <div class="field">
        <label class="field-label" for="am-appeal-channel">Appeal channel (optional)</label>
        <select id="am-appeal-channel" data-channel-select>${channelOptions(guild._channels, s.appealChannelId)}</select>
        <div class="field-hint">New appeals filed via <code>/appeal</code> are posted here for moderators to review.</div>
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" data-save="automod">Save automod settings</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span><span class="icon">⚠️</span> Warnings</span></div>
      <p class="card-desc">Live warning ledger for this server (automod + manual <code>/warn</code>). <a href="#" id="am-refresh-warnings">Refresh</a></p>
      <div id="am-warnings-list"><div class="field-hint">Loading…</div></div>
    </div>

    <div class="card">
      <div class="card-title"><span><span class="icon">📨</span> Appeals</span></div>
      <p class="card-desc">Punishment appeals filed by members. Approving an appeal reverses the action (unban/unmute) automatically. <a href="#" id="am-refresh-appeals">Refresh</a></p>
      <div id="am-appeals-list"><div class="field-hint">Loading…</div></div>
    </div>`;

    // Embed the automod settings + rule/action catalogs so the client script
    // can render exempt lists and add-rule rows without an extra fetch.
    const body = `
    ${guildHeaderHTML(guild)}
    ${tabNavHTML(guild.id, 'automod')}
    ${panelHTML}
    ${guildDataScript({ guildId: guild.id, channels: guild._channels, roles: guild._roles, extra: { _automodSettings: s } })}
    <script>window.__AUTOMOD_RULES=${JSON.stringify(AUTOMOD_RULES)};window.__AUTOMOD_ACTIONS=${JSON.stringify(AUTOMOD_ACTIONS)};window.__AUTOMOD_SETTINGS=${JSON.stringify(s)};</script>`;
    return render({ title: `PrimeBot · ${guild.name} · Automod`, body, active: 'servers', scripts: ['/js/guild-common.js', '/js/automod.js'] });
}

// ── Events ──────────────────────────────────────────────────────────────────

function eventsPage({ guild, user }) {
    const panelHTML = `
    <div class="card">
      <h2>📅 Event Management</h2>
      <p>Schedule an event with a countdown and a list of timed tasks. The bot will lock/unlock or hide/unhide channels, add/remove roles, or send a text/embed message at the offsets you set (seconds from the event start).</p>
      <div class="ev-form" id="ev-form">
        <div class="form-row">
          <label>Event name<input type="text" id="ev-name" placeholder="e.g. Game Night" /></label>
          <label>Countdown (seconds)<input type="number" id="ev-countdown" min="0" value="0" /></label>
        </div>
        <label>Description <textarea id="ev-description" rows="2" placeholder="Optional description"></textarea></label>
        <h4 class="ev-tasks-head">Tasks</h4>
        <div id="ev-tasks-list"></div>
        <button class="btn btn-secondary" id="ev-add-task">+ Add task</button>
        <div class="form-actions">
          <button class="btn btn-primary" id="ev-save">Create event</button>
          <button class="btn btn-secondary" id="ev-clear">Clear</button>
        </div>
      </div>
      <h3 class="ev-list-head">Scheduled events</h3>
      <div id="ev-list"><p class="live-empty">Loading…</p></div>
    </div>
    <div id="ev-modal" class="modal-overlay hidden"></div>`;
    return guildTab({ guild, user, active: 'events', panelHTML, scripts: ['/js/guild-common.js', '/js/events.js'] });
}

module.exports = {
    welcomePage, levelingPage, prefixPage, reactionsPage, broadcastPage,
    loggingPage, reactionRolesPage, ticketsPage, automodPage, eventsPage,
    TABS,
};
