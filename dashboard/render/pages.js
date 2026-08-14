/**
 * Server-rendered pages: login, docs, live, overview, and the 404 fallback.
 * Each exports a function returning the full HTML string (via layout.render).
 */

const constants = require('../constants');
const { esc, guildIconHTML, render } = require('./layout');
const { LOG_EVENTS } = constants;

// ── Login ──────────────────────────────────────────────────────────────────

const LOGIN_ERRORS = {
    missing_code: 'Authorization code was missing from the Discord callback.',
    auth_failed: 'Discord sign-in failed. Please try again.',
    session_failed: 'Signed in to Discord, but the server could not save your session. This usually means the database connection is failing on Vercel (check DATABASE_URL / SSL and that the primebot_dashboard_session table is reachable).',
};

function loginPage({ errorKey } = {}) {
    const errorMsg = errorKey && LOGIN_ERRORS[errorKey];
    const errorHTML = errorMsg
        ? `<div class="alert alert-error" style="margin:0 0 16px;text-align:left">${esc(errorMsg)}</div>`
        : '';
    const body = `
    <div class="login-wrap">
      <div class="login-hero">⚡</div>
      <h1 class="login-title">PrimeBot Dashboard</h1>
      <h3>Premium features in free </h3>
      ${errorHTML}
      <p class="login-sub">Sign in with Discord to configure PrimeBot for the servers you manage — welcome messages, leveling, prefixes, auto-reactions and more, all in one place.</p>
      <a href="/auth/discord" class="btn btn-discord">🚪 Login with Discord</a>
      <a href="/docs" class="btn btn-secondary">📖 Documentation</a>

      <div class="stats-band" id="stats-band" aria-live="polite">
        <div class="stats-band-head">
          <span class="stats-band-title">Live across the platform</span>
          <span class="stats-band-sub" id="stats-sub">Loading live stats…</span>
        </div>
        <div class="stats-cards" id="stats-cards">
          <div class="stat-card stat-primary">
            <div class="stat-icon">🏰</div>
            <div class="stat-value" id="stat-servers" data-target="0">0</div>
            <div class="stat-label">Servers configured</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">🖼️</div>
            <div class="stat-value" id="stat-banners" data-target="0">0</div>
            <div class="stat-label">Custom welcome banners</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">🤖</div>
            <div class="stat-value" id="stat-version">—</div>
            <div class="stat-label">Bot version</div>
          </div>
        </div>
        <div class="stats-chart-wrap">
          <div class="stats-chart-head">Feature adoption</div>
          <div class="donut-grid">
            <div class="donut-item"><div class="donut" id="donut-leveling"><span class="donut-pct">0%</span></div><div class="donut-label">📈 Leveling</div></div>
            <div class="donut-item"><div class="donut" id="donut-welcome"><span class="donut-pct">0%</span></div><div class="donut-label">👋 Welcome</div></div>
            <div class="donut-item"><div class="donut" id="donut-reactions"><span class="donut-pct">0%</span></div><div class="donut-label">🔁 Auto-reactions</div></div>
            <div class="donut-item"><div class="donut" id="donut-broadcasts"><span class="donut-pct">0%</span></div><div class="donut-label">📢 Broadcasts</div></div>
            <div class="donut-item"><div class="donut" id="donut-automod"><span class="donut-pct">0%</span></div><div class="donut-label">🛡️ Automod</div></div>
            <div class="donut-item"><div class="donut" id="donut-tickets"><span class="donut-pct">0%</span></div><div class="donut-label">🎫 Tickets</div></div>
          </div>
        </div>
      </div>

      <div class="feature-grid">
        <div class="feature"><div class="fi">👋</div><div class="ft">Welcome system</div><div class="fd">Custom messages, banners, DMs and channel routing.</div></div>
        <div class="feature"><div class="fi">📈</div><div class="ft">Leveling &amp; XP</div><div class="fd">Tune multipliers, cooldowns and level-up channels.</div></div>
        <div class="feature"><div class="fi">⚡</div><div class="ft">Command prefix</div><div class="fd">Set a per-server prefix instead of the default.</div></div>
        <div class="feature"><div class="fi">🔁</div><div class="ft">Auto-reactions</div><div class="fd">Trigger emojis on matching messages automatically.</div></div>
        <div class="feature"><div class="fi">🛡️</div><div class="ft">Premium Automod</div><div class="fd">Auto-mod with warnings, escalation, spam &amp; word filters — free.</div></div>
      </div>
    </div>`;
    return render({ title: 'PrimeBot Dashboard — Login', body, login: true, scripts: ['/js/login.js'] });
}

// ── Docs ───────────────────────────────────────────────────────────────────

function docsPage({ clientId, user } = {}) {
    const inviteUrl = clientId
        ? `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&integration_type=0&scope=bot%20applications.commands`
        : 'https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8&integration_type=0&scope=bot%20applications.commands';
    const body = `
    <div class="docs">
      <div class="docs-hero">
        <div class="docs-hero-icon">📖</div>
        <h1 class="docs-title">PrimeBot Documentation</h1>
        <p class="docs-lead">Everything you need to set up, configure and manage PrimeBot for your Discord server — from inviting the bot to tuning welcome messages, leveling and auto-reactions.</p>
      </div>

      <nav class="docs-toc">
        <h3>On this page</h3>
        <ul>
          <li><a href="#getting-started">Getting started</a></li>
          <li><a href="#login">Logging in</a></li>
          <li><a href="#servers">Your servers</a></li>
          <li><a href="#welcome">Welcome system</a></li>
          <li><a href="#leveling">Leveling &amp; XP</a></li>
          <li><a href="#prefix">Command prefix</a></li>
          <li><a href="#reactions">Auto-reactions</a></li>
          <li><a href="#broadcast">Broadcasts</a></li>
          <li><a href="#commands">Command reference</a></li>
          <li><a href="#faq">FAQ &amp; troubleshooting</a></li>
        </ul>
      </nav>

      <section id="getting-started" class="docs-section">
        <h2>1 · Getting started</h2>
        <p>PrimeBot is a community engagement bot with welcome messages, an XP-based leveling system, polls, giveaways, ticketing, moderation and more. To use it in your server you first need to invite it.</p>
        <ol class="docs-steps">
          <li>
            <strong>Invite PrimeBot to your server.</strong><br />
            Use the official invite link with administrator permissions so all features work out of the box:
            <div class="docs-code-row"><code class="docs-code">${esc(inviteUrl)}</code><a class="btn btn-primary btn-sm" href="${esc(inviteUrl)}" target="_blank" rel="noopener">Open invite</a></div>
          </li>
          <li><strong>Make sure you have permissions.</strong> You need the <em>Manage Server</em> permission (or be the server owner) to configure PrimeBot through this dashboard.</li>
          <li><strong>Log in below.</strong> The dashboard uses Discord OAuth2, so you sign in with the same Discord account you use to manage your server.</li>
        </ol>
      </section>

      <section id="login" class="docs-section">
        <h2>2 · Logging in</h2>
        <p>Click <strong>Login with Discord</strong> on the home screen. You'll be sent to Discord to authorize the dashboard to read your username and the list of servers you manage. We never see your password, and you can revoke access at any time from <em>Discord → Settings → Authorized Apps</em>.</p>
        <div class="docs-callout docs-callout-info">
          <strong>Privacy:</strong> The dashboard only requests the <code>identify</code> and <code>guilds</code> scopes. Your access token is stored in a server-side session tied to a secure cookie — it is never exposed to the browser or shared with third parties.
        </div>
      </section>

      <section id="servers" class="docs-section">
        <h2>3 · Your servers</h2>
        <p>After logging in you'll land on the <strong>Servers</strong> overview. It lists every server where you have <em>Manage Server</em> rights, and shows whether PrimeBot is present. Click any server with the green “PrimeBot is here” badge to open its configuration.</p>
        <p>Servers where the bot isn't a member are shown separately with an <strong>Invite</strong> button — use it to add PrimeBot, then refresh the list.</p>
      </section>

      <section id="welcome" class="docs-section">
        <h2>4 · Welcome system</h2>
        <p>Greet new members with a custom message, an auto-generated banner, and an optional DM. Configure:</p>
        <ul class="docs-list">
          <li><strong>Enabled</strong> — turn the whole welcome system on or off.</li>
          <li><strong>Channel</strong> — where welcome messages are posted (leave empty to DM only).</li>
          <li><strong>Message</strong> — supports placeholders such as <code>{user}</code> (mention) and <code>{server}</code> (server name).</li>
          <li><strong>Color</strong> — the accent color of the welcome card, as a hex code (e.g. <code>#5865F2</code>).</li>
          <li><strong>Banner URL</strong> — an optional image shown at the top of the card.</li>
          <li><strong>DM enabled + DM message</strong> — send a private welcome message to the new member.</li>
          <li><strong>Member count / join date / account age</strong> — toggle extra stats on the welcome card.</li>
        </ul>
      </section>

      <section id="leveling" class="docs-section">
        <h2>5 · Leveling &amp; XP</h2>
        <p>Members earn XP by chatting. Tune the system per server:</p>
        <ul class="docs-list">
          <li><strong>Enabled</strong> — turn leveling on or off.</li>
          <li><strong>XP multiplier</strong> — scales how fast members earn XP (0–5). <code>1.0</code> is default.</li>
          <li><strong>XP cooldown</strong> — minimum seconds between XP awards (5–300s) to prevent spam.</li>
          <li><strong>Level-up channel</strong> — where level-up announcements are posted (leave empty to disable announcements).</li>
        </ul>
      </section>

      <section id="prefix" class="docs-section">
        <h2>6 · Command prefix</h2>
        <p>PrimeBot responds to both slash commands and a text prefix. Set a per-server prefix here (the default is <code>$</code>). Prefixes can be 1–5 characters and must not contain spaces.</p>
      </section>

      <section id="reactions" class="docs-section">
        <h2>7 · Auto-reactions</h2>
        <p>Have PrimeBot automatically react to messages that match keywords. Enable the feature, then add keyword → emoji pairs. When a message contains a matching keyword, the bot adds the configured emoji reaction.</p>
      </section>

      <section id="broadcast" class="docs-section">
        <h2>8 · Broadcasts</h2>
        <p>Opt a server into receiving bot-wide broadcast announcements. Toggle <strong>Receive broadcasts</strong> and pick a <strong>broadcast channel</strong>. Messages sent by the bot owner are delivered to every opted-in server's chosen channel.</p>
      </section>

      <section id="commands" class="docs-section">
        <h2>9 · Command reference</h2>
        <p>PrimeBot ships with 40+ commands. Here are the main categories. Slash commands use <code>/</code>; prefix commands use your server's prefix (default <code>$</code>).</p>
        <div class="docs-cmd-grid">
          <div class="docs-cmd-card">
            <h4>🛡️ Moderation</h4>
            <ul><li><code>ban</code> / <code>kick</code> — remove members</li><li><code>purge</code> — bulk-delete messages</li><li><code>lock</code> / <code>unlock</code> — lock channels</li><li><code>nuke</code> — clear &amp; recreate a channel</li><li><code>hide</code> / <code>unhide</code> — hide channels</li><li><code>move</code> — move members</li><li><code>role</code> — assign roles</li></ul>
          </div>
          <div class="docs-cmd-card">
            <h4>🎉 Engagement</h4>
            <ul><li><code>poll</code> / <code>endpoll</code> — simple polls</li><li><code>lpoll</code> / <code>endgame</code> — live polls</li><li><code>giveaway</code> / <code>reroll</code> / <code>end</code> — giveaways</li><li><code>counting</code> — counting game</li><li><code>tictactoe</code> — play tic-tac-toe</li><li><code>truthdare</code> — truth or dare</li></ul>
          </div>
          <div class="docs-cmd-card">
            <h4>🎫 Tickets &amp; Support</h4>
            <ul><li><code>createticket</code> / <code>ticket</code> — open tickets</li><li><code>tickethistory</code> — view past tickets</li></ul>
          </div>
        </div>
      </section>

      <section id="faq" class="docs-section">
        <h2>10 · FAQ &amp; troubleshooting</h2>
        <p><strong>Changes don't take effect?</strong> The bot caches settings in memory and re-reads the database roughly every 30 seconds, so allow up to half a minute for dashboard changes to reach the bot (provided the bot and dashboard use the same database).</p>
        <p><strong>Can't see your server?</strong> Ensure you have <em>Manage Server</em> permission and that PrimeBot has been added to it.</p>
      </section>
    </div>`;
    return render({ title: 'PrimeBot Documentation', body, active: 'docs', user });
}

// ── Live ────────────────────────────────────────────────────────────────────

function livePage({ user } = {}) {
    const body = `
    <div class="page-head">
      <h1>Live</h1>
      <p>Cross-server live polls and live giveaways — running and recently ended, across all of PrimeBot.</p>
    </div>
    <div id="live-content">
      <div class="splash"><div class="spinner"></div><p>Loading live data…</p></div>
    </div>
    <div id="live-join-modal" class="modal-overlay hidden"></div>`;
    return render({ title: 'PrimeBot · Live', body, active: 'live', scripts: ['/js/live.js'], user });
}

// ── Overview (servers) ──────────────────────────────────────────────────────

function guildCardHTML(g, present) {
    const tags = [];
    tags.push(`<span class="tag prefix">${esc(g.prefix || '$')} prefix</span>`);
    if (present) {
        tags.push(g.welcomeEnabled ? `<span class="tag on">👋 Welcome</span>` : `<span class="tag off">Welcome off</span>`);
        tags.push(g.levelingEnabled ? `<span class="tag on">📈 Leveling</span>` : `<span class="tag off">Leveling off</span>`);
    } else {
        tags.push(`<span class="tag absent">Bot not added</span>`);
    }
    const iconHTML = guildIconHTML(g);
    const members = g.approximate_member_count != null
        ? `${Number(g.approximate_member_count).toLocaleString()} members`
        : '';
    return `
    <div class="guild-card" data-guild="${esc(g.id)}">
      <div class="guild-head">
        <div class="guild-icon">${iconHTML}</div>
        <div>
          <div class="guild-name">${esc(g.name)}</div>
          <div class="guild-meta">${members}${g.owner ? ' · Owner' : ''}</div>
        </div>
      </div>
      <div class="guild-tags">${tags.join('')}</div>
    </div>`;
}

function overviewPage({ guilds = [], clientId, user } = {}) {
    const manageable = guilds.filter(g => g.botPresent);
    const absent = guilds.filter(g => !g.botPresent);

    const statsHTML = `
    <div class="stats">
      <div class="stat"><div class="sv">${guilds.length}</div><div class="sl">Servers you manage</div></div>
      <div class="stat"><div class="sv">${manageable.length}</div><div class="sl">With PrimeBot</div></div>
      <div class="stat"><div class="sv">${manageable.filter(g => g.welcomeEnabled).length}</div><div class="sl">Welcome enabled</div></div>
      <div class="stat"><div class="sv">${manageable.filter(g => g.levelingEnabled).length}</div><div class="sl">Leveling enabled</div></div>
    </div>`;

    let listHTML = '';
    if (manageable.length === 0 && absent.length === 0) {
        const invite = `https://discord.com/oauth2/authorize?client_id=${esc(clientId || '')}&permissions=8&integration_type=0&scope=bot%20applications.commands`;
        listHTML = `
      <div class="guild-empty">
        <p style="font-size:40px;margin:0 0 8px">🔍</p>
        <p>You don't manage any servers yet, or PrimeBot isn't in any of them.</p>
        <p style="margin-top:12px"><a class="btn btn-secondary" href="${invite}" target="_blank" rel="noopener">Invite PrimeBot to a server</a></p>
      </div>`;
    } else {
        if (manageable.length) {
            listHTML += `<div class="guild-grid">` + manageable.map(g => guildCardHTML(g, true)).join('') + `</div>`;
        }
        if (absent.length) {
            listHTML += `
        <h3 style="margin:28px 0 12px;font-size:15px;color:var(--text-dim)">PrimeBot not yet added</h3>
        <div class="guild-grid">` + absent.map(g => guildCardHTML(g, false)).join('') + `</div>`;
        }
    }

    const body = `
    <div class="page-head">
      <h1>Your servers</h1>
      <p>Pick a server to configure PrimeBot. Only servers where you have <strong>Manage Server</strong> permission are shown.</p>
    </div>
    ${statsHTML}
    ${listHTML}`;
    return render({ title: 'PrimeBot · Servers', body, active: 'servers', scripts: ['/js/servers.js'], user });
}

// ── 404 ────────────────────────────────────────────────────────────────────

function notFoundPage({ user } = {}) {
    const body = `
    <div class="card">
      <h2>Page not found</h2>
      <p>The page you requested does not exist.</p>
      <p><a href="/">← Back to dashboard</a></p>
    </div>`;
    return render({ title: 'PrimeBot · Not found', body, user });
}

module.exports = { loginPage, docsPage, livePage, overviewPage, notFoundPage, guildCardHTML };
