# misogimodel

3D-printed terrain models of the places that matter. Live at https://misogimodel.com.

## Pages

| Address | File | What it is |
|---|---|---|
| `/` | `index.html` | The landing page, built from the design canvas |
| `/studio/` | `studio/index.html` | The studio: pick a place, shape it, export it |
| anything missing | `404.html` | The "Off the map" page |
| `/brand/` | `brand/*` | Logo files: the mark, the stone, lockups (SVG + PNG) |
| `/favicon.svg` etc. | root icons | Browser tab and phone home-screen icons |

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

- `RESEND_API_KEY`: sending-only key for send.misogimodel.com (order emails)
- `STRIPE_SECRET_KEY`: `sk_test_…` while testing, `sk_live_…` to take real money
- `STRIPE_WEBHOOK_SECRET`: `whsec_…`, from the webhook endpoint below
- `ORDER_SECRET`: any long random string; signs the upload and download links
- `ORDER_EMAIL_TO`: where order emails go
- `ORDER_EMAIL_FROM` (optional): defaults to `misogimodel orders <orders@send.misogimodel.com>`

## Orders and the cart

- **Studio, Add to cart**: saves the model's print file and picture on the server
  (`POST /api/items`, then two uploads) and puts it in the cart kept in the visitor's browser.
- **/cart/**: lists the models; Remove, Open in the studio, delivery choice, one Checkout.
  The cart survives going back to the homepage, closing the tab and coming back.
- **Checkout** (`POST /api/checkout`): the server prices everything again from
  `order-pricing.js` and opens one Stripe page for the lot.
- **Paid** (`POST /api/stripe-webhook`): one email listing every model, each print file
  attached (up to about 28 MB in total; anything beyond that comes as a download link).
- **/thanks/** empties the cart.

Prices, delivery options and where you ship to all live in `order-pricing.js`.
Set `placeholder: false` once the real prices are in.

Setup, once:
1. Cloudflare → R2 → enable R2, create bucket `misogimodel-orders`.
2. Workers & Pages → misogimodel → Settings → Bindings → add R2 bucket, variable name `ORDERS`.
3. Add the secrets above.
4. Stripe → Developers → Webhooks → add endpoint `https://misogimodel.com/api/stripe-webhook`,
   events `checkout.session.completed` and `checkout.session.async_payment_succeeded`;
   copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
