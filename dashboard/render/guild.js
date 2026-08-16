/**
 * Server-rendered guild settings page helpers.
 *
 * Each settings tab is its own HTML page at /guild/:guildId/<tab>. They share a
 * header card (guild icon + name + member count) and a tab navigation bar that
 * is a row of real links. This module renders both, plus the small JSON blob
 * (#guild-data) the per-page client scripts read to populate channel/role
 * <select>s without an extra API round-trip.
 */

const { esc, guildIconHTML } = require('./layout');

// Each settings tab is a sidebar menu entry. `beta` flags the feature as a
// beta release — the menu + page render a "BETA" badge next to its label.
const TABS = [
  { key: 'welcome',        label: '👋 Welcome' },
  { key: 'leveling',       label: '📈 Leveling' },
  { key: 'prefix',         label: '⚡ Prefix' },
  { key: 'reactions',      label: '🔁 Auto-Reactions' },
  { key: 'reactionroles',  label: '🎭 Reaction Roles' },
  { key: 'broadcast',      label: '📢 Broadcasts' },
  { key: 'logging',        label: '📜 Logging' },
  { key: 'automod',        label: '🛡️ Automod' },
  { key: 'tickets',        label: '🎫 Tickets' },
  { key: 'live/polls',     label: '📊 Live Polls' },
  { key: 'live/giveaways', label: '🎉 Live Giveaways' },
  { key: 'events',         label: '📅 Events', beta: true },
];

// The inlined channel/role <option> data + guild id. Pages embed this so the
// client can populate selects immediately.
function guildDataScript({ guildId, channels = [], roles = [], extra = {} }) {
  const data = JSON.stringify({ guildId, channels, roles, ...extra })
      .replace(/</g, '\\u003c');
  return `<script type="application/json" id="guild-data">${data}</script>`;
}

function guildHeaderHTML(guild) {
  const members = guild && guild.approximate_member_count != null
    ? `${Number(guild.approximate_member_count).toLocaleString()} members`
    : '';
  const owner = guild && guild.userIsOwner ? ' · You are the owner' : '';
  return `
    <div class="breadcrumb"><a href="/">Servers</a> <span>/</span> <span>${esc(guild.name)}</span></div>
    <div class="guild-header-card card">
      <div class="guild-icon">${guildIconHTML(guild)}</div>
      <div>
        <h1>${esc(guild.name)}</h1>
        <div class="meta">${members}${owner}</div>
      </div>
    </div>`;
}

// Sidebar menu ("turn left" slide-in). A button toggles a drawer that slides in
// from the left edge. Each tab is a real link; the active one is highlighted.
function tabNavHTML(guildId, active) {
  const links = TABS.map(t => {
    const badge = t.beta ? ' <span class="beta-badge">BETA</span>' : '';
    return `<a class="menu-item${t.key === active ? ' active' : ''}" href="/guild/${esc(guildId)}/${t.key}">${esc(t.label)}${badge}</a>`;
  }).join('');
  const activeTab = TABS.find(t => t.key === active);
  const activeLabel = activeTab ? activeTab.label : 'Menu';
  return `
    <div class="menu-bar">
      <button class="menu-toggle" id="menu-toggle" aria-label="Open menu" aria-expanded="false">
        <span class="menu-hamburger"><span></span><span></span><span></span></span>
        <span class="menu-bar-label">${esc(activeLabel)}</span>
      </button>
    </div>
    <div class="menu-backdrop" id="menu-backdrop"></div>
    <aside class="side-menu" id="side-menu" aria-hidden="true">
      <div class="side-menu-head">
        <span class="side-menu-title">Server features</span>
        <button class="side-menu-close" id="side-menu-close" aria-label="Close menu">✕</button>
      </div>
      <nav class="side-menu-nav">${links}</nav>
    </aside>`;
}

module.exports = { TABS, guildDataScript, guildHeaderHTML, tabNavHTML };
