# Webinar Admin — static HTML version

A no-build, browser-only port of the Next.js app. Same UI and features
(login, source tabs, search, filters, sort, pagination, create/edit/delete,
CSV export) — but it talks to Supabase **directly from the browser** instead of
through Next.js API routes.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page shell (login card + app container) |
| `styles.css` | Styles (identical to the Next.js `globals.css`) |
| `config.js`  | Public Supabase URL + **anon** key |
| `app.js`     | All logic: auth, querying, CRUD, CSV export |

## How to run

It's a static site — just serve the folder over HTTP (opening `index.html`
via `file://` will fail because the Supabase SDK needs a real origin):

```bash
cd html
python -m http.server 5500
# then open http://localhost:5500
```

Or with Node: `npx serve .` — or use the VS Code **Live Server** extension.

Sign in with a user created in **Supabase → Authentication → Users**
(there is no public sign-up).

## How it differs from the Next.js version (important)

The Next.js app keeps the **service-role key on the server** and queries through
`/api/*` routes, so it bypasses Row Level Security (RLS) and has full
read/write access. This static site has **no server**, so it uses the public
**anon key** in the browser. Consequences:

- **RLS applies.** Reads/writes only succeed where your RLS policies grant the
  `anon` / `authenticated` role access to those tables and views. If a tab
  shows "No rows" or a save fails with a permissions error, that's RLS — add a
  policy in Supabase, don't paste the service-role key here.
- **Never put the `service_role` key in `config.js`.** It bypasses RLS and would
  be visible to anyone who opens the page — a full database compromise. The anon
  key is the only key that belongs in browser code.
- **The n8n "new webinar" backfill webhook is omitted** — its URL was a
  server-only secret. Creating a webinar still inserts the row; it just doesn't
  fire the webhook.

## Deploying

Because it's fully static, you can host it anywhere — including
**GitHub Pages** (which can't host the Next.js app):

1. Push this folder to your repo.
2. GitHub repo → **Settings → Pages** → deploy from branch, and point it at the
   folder (or move these files to `/docs` or a `gh-pages` branch).
3. Add your Pages URL to **Supabase → Authentication → URL Configuration →
   Redirect URLs** so auth works from that origin.

> Heads-up: with only the anon key + RLS, a static deploy is only as safe as your
> RLS policies. Make sure they're locked down before exposing this publicly.
