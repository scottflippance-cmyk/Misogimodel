# Relief

Pick a place, shape the ground, print the landscape.

A single-file web app: `index.html` is the whole site. Hosted on Cloudflare
Pages at https://misogimodel.com.

## Deploying

Cloudflare Pages redeploys automatically on every push to the default branch.

- Framework preset: none
- Build command: none
- Output directory: `/`

## Layout

- `index.html` — the app (map selection, 3D preview, STL/GPX export)
- `functions/api/` — Cloudflare Pages Functions (the `/api/order` endpoint
  will live here; it reads `RESEND_API_KEY` from the project's secrets)

## Secrets

Set in Cloudflare → Workers & Pages → relief → Settings → Variables and
Secrets. Never commit keys to this repo; the Mapbox token in `index.html`
is a public, URL-restricted token and is the only credential meant to be
visible.

- `RESEND_API_KEY` — sending-only key for send.misogimodel.com (orders email)
