/* Per-server Live Polls / Live Giveaways tab.
 * Same card markup as the global live.js, but fetches only the items created in
 * THIS server via /api/guilds/:guildId/live/polls|giveaways. The active page is
 * detected from the body's data attribute set below.
 */

const LIVE_PREFIX = '$';

function liveRunningCardHTML(item, kind) {
  const key = kind === 'poll' ? (item.passCode || item.pollId) : (item.passCode || item.giveawayId);
  const title = kind === 'poll' ? esc(item.question || '') : `Prize: ${esc(item.prize || '')}`;
  const meta = kind === 'poll'
    ? `${item.totalVotes ?? 0} votes`
    : `${item.entries ?? 0} entries • ${item.winnerCount ?? 1} winner(s)`;
  const expires = item.expiresAt || item.endsAt
    ? `<span class="live-meta">⏱️ ends ${esc(new Date(item.expiresAt || item.endsAt).toLocaleString())}</span>`
    : '<span class="live-meta">⏱️ permanent</span>';
  return `
    <div class="live-card" data-key="${esc(key)}" data-kind="${kind}">
      <div class="live-card-title">${title}</div>
      <div class="live-card-meta">${esc(meta)} ${expires}</div>
      <div class="live-card-code">🔑 Pass code: <code>${esc(key)}</code></div>
      <button class="btn btn-primary live-join-btn" data-key="${esc(key)}" data-kind="${kind}">Join</button>
    </div>`;
}

function liveEndedCardHTML(item, kind) {
  if (kind === 'poll') {
    const winners = (item.winners || []).map(w => esc(w)).join(', ') || '—';
    const opts = (item.options || []).map(o => `${esc(o.text)}: ${o.votes}`).join(' · ');
    return `
      <div class="live-card live-ended">
        <div class="live-card-title">${esc(item.question || '')}</div>
        <div class="live-card-meta">${esc((item.options || []).reduce((s, o) => s + o.votes, 0))} votes</div>
        ${opts ? `<div class="live-card-opts">${esc(opts)}</div>` : ''}
        <div class="live-winners">🏆 Winner(s): ${winners}</div>
      </div>`;
  }
  const winners = (item.winners || []).map(w => `<code>${esc(w)}</code>`).join(', ') || '—';
  return `
    <div class="live-card live-ended">
      <div class="live-card-title">Prize: ${esc(item.prize || '')}</div>
      <div class="live-winners">🏆 Winner(s): ${winners}</div>
    </div>`;
}

function livePanelHTML(items, ended, kind) {
  return `
    <div class="live-panel">
      <h3 class="live-section-head">🟢 Running</h3>
      <div class="live-list">
        ${items.length ? items.map(i => liveRunningCardHTML(i, kind)).join('') : '<p class="live-empty">No running items in this server.</p>'}
      </div>
      <h3 class="live-section-head">🔴 Ended</h3>
      <div class="live-list">
        ${ended.length ? ended.map(i => liveEndedCardHTML(i, kind)).join('') : '<p class="live-empty">No ended items in this server.</p>'}
      </div>
    </div>`;
}

function openJoinModal(key, kind) {
  const modal = document.getElementById('live-join-modal');
  if (!modal) return;
  const command = kind === 'poll' ? `lpoll join ${key}` : `lgiveway join ${key}`;
  modal.innerHTML = `
    <div class="modal floating-window">
      <div class="modal-head">
        <h3>${kind === 'poll' ? '📊 Join Live Poll' : '🎉 Join Live Giveaway'}</h3>
        <button class="modal-close" id="live-join-close">×</button>
      </div>
      <div class="modal-body">
        <p>Run this command in any Discord server where PrimeBot is present to join:</p>
        <div class="command-box"><code>${esc(LIVE_PREFIX)}${esc(command)}</code>
          <button class="btn btn-secondary btn-copy" id="live-join-copy">Copy</button>
        </div>
        <p class="live-modal-note">Key: <code>${esc(key)}</code></p>
        <div id="live-join-status"></div>
        <div class="live-join-actions">
          <button class="btn btn-primary" id="live-join-do">Join now</button>
        </div>
      </div>
    </div>`;
  modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  modal.querySelector('#live-join-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#live-join-copy').addEventListener('click', () => {
    navigator.clipboard?.writeText(`${LIVE_PREFIX}${command}`).then(() => toast('Command copied!'), () => {});
  });
  modal.querySelector('#live-join-do').addEventListener('click', () => {
    const status = modal.querySelector('#live-join-status');
    status.innerHTML = `<div class="alert alert-warn">The dashboard can't join for you — run the command above in Discord to join the ${kind === 'poll' ? 'poll' : 'giveaway'}.</div>`;
  });
}

async function loadGuildLive() {
  // guild-common.js sets window.guildData.guildId. The kind is derived from the
  // page URL so the same script serves both the polls and giveaways tabs.
  const guildId = window.guildData?.guildId;
  const kind = window.location.pathname.endsWith('/live/giveaways') ? 'giveaway' : 'poll';
  const wrap = document.getElementById('live-content');
  if (!wrap || !guildId) return;
  try {
    const data = await api(`/api/guilds/${encodeURIComponent(guildId)}/live/${kind === 'poll' ? 'polls' : 'giveaways'}`);
    const items = data.running || [];
    const ended = data.ended || [];
    wrap.innerHTML = livePanelHTML(items, ended, kind);
    wrap.querySelectorAll('.live-join-btn').forEach(btn => {
      btn.addEventListener('click', () => openJoinModal(btn.dataset.key, btn.dataset.kind));
    });
  } catch (err) {
    wrap.innerHTML = `<div class="alert alert-error">${esc(err.message || 'Failed to load live data.')}</div>`;
  }
}

loadGuildLive();
