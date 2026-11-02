# misogimodel

3D-printed terrain models of the places that matter. Live at https://misogimodel.com.

## Pages

| Address | File | What it is |
|---|---|---|
| `/` | `index.html` | The landing page, built from the design canvas |
| `/studio/` | `studio/index.html` | The studio: pick a place, shape it, export it |
| anything missing | `404.html` | The "Off the map" page |

Coming next: `/contact`, `/delivery-returns`, `/privacy`, `/terms` (the landing page
already links to them; they show the 404 page until they exist).

## Deploying

Cloudflare Pages builds automatically from this repo: no framework, no build command,
output directory blank (the repo root).

- **`main`** is the live site: misogimodel.com
- **`preview`** (or any other branch) gets its own test site: `preview.misogimodel.pages.dev`

Upload changes to `preview`, check them there, then merge into `main` to go live.

## Secrets

Set in Cloudflare → Workers & Pages → misogimodel → Settings → Variables and Secrets.
Never commit keys to this repo. The Mapbox token in the studio is a public token,
restricted to misogimodel.com and misogimodel.pages.dev, and is the only credential
meant to be visible.

- `RESEND_API_KEY`: sending-only key for send.misogimodel.com (order emails), added
  when the order flow is built
