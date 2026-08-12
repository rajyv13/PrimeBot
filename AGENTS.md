# PrimeBot — Agent Notes

## Dashboard (Vercel) auth — known gotchas

The dashboard is deployed to Vercel as a serverless Express app (`dashboard/server.js` via `vercel.json`). Login uses Discord OAuth2 → `/auth/callback` → redirect to `/`. The SPA then calls `/api/me`, which requires a session.

Key points that have bitten us before:

- **Session store must use SSL.** Production Postgres on Vercel (Neon/Supabase/Vercel Postgres) requires SSL. `buildSessionStore()` reuses the bot's `server/db.js` `pool` (which sets `ssl` from `DATABASE_URL`/`DB_SSL`) rather than a bare `new Pool({ connectionString })`. A non-SSL session pool silently fails every session write → Discord login succeeds but the user is bounced back to the login screen because `/api/me` returns 401.
- **`proxy: true` on express-session** is required so the `x-forwarded-proto: https` header is trusted when deciding whether to set/send the `Secure` session cookie behind Vercel's TLS-terminating proxy.
- The OAuth callback awaits `req.session.save()` and redirects to `/login?error=session_failed` if persistence fails (instead of silently redirecting to a broken dashboard).
- `/login?error=...` serves the SPA so the error can be surfaced by `renderLogin()` (see `LOGIN_ERRORS` in `dashboard/public/app.js`).
- **Don't conflate bot-token 401 with user-token 401.** `requireGuildAdmin` calls `getBotGuild` (uses the BOT token, `Authorization: Bot $DISCORD_TOKEN`). A 401 there means `DISCORD_TOKEN` is missing/invalid on the Vercel deployment — NOT that the user's session expired. It returns 503 (`reason: bot_token_unauthorized`) and leaves the session intact. Only a 401 from `getUserGuilds` (user OAuth access token) destroys the session and redirects to `/login`. The SPA renders a clear "set DISCORD_TOKEN" message on 503.
- Without a valid `DISCORD_TOKEN`, the server list still loads (it uses the user's OAuth token) but every server shows as "bot not added" and opening one fails with the 503 above.
- **Dashboard saves need a cache reload to reach the bot.** The bot and dashboard are separate processes sharing the same Postgres tables, but both `ServerSettingsManager` and `WelcomeSettingsManager` cache all rows in memory at boot and only update the cache on the bot's own writes. A dashboard save writes the DB row directly, so without a reload the bot keeps using stale cached values (looks like "save succeeded but nothing changed"). Both managers now re-read the table on a `setInterval` (`SETTINGS_RELOAD_INTERVAL_MS`, default 30000ms) so dashboard changes take effect within ~30s without a bot restart. `loadSettings()` preserves in-memory-only fields (e.g. `leveling.roleRewards`, which has no DB column) across reloads so they aren't wiped.
- **Same DB requirement:** for dashboard saves to affect the bot, both deployments must point at the same `DATABASE_URL` (and `WELCOME_DATABASE_URL` for welcome settings). If they use different databases, dashboard writes never reach the bot regardless of caching.

## Env vars (Vercel)

On Vercel, set in Settings → Environment Variables: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DATABASE_URL` (with `?sslmode=require` if the host needs SSL), `SESSION_SECRET`, `DASHBOARD_BASE_URL` (= `https://<prod>.vercel.app`), and `DISCORD_REDIRECT_URI` (= `<DASHBOARD_BASE_URL>/auth/callback`, registered in the Discord Developer Portal).

## Commands

- Bot: `npm start`
- Dashboard (local): `npm run dashboard`
- Tests: `node --test tests/*.test.js`
