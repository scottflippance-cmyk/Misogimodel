# misogimodel

3D-printed terrain models of the places that matter. Live at https://misogimodel.com.

## Pages

| Address | File | What it is |
|---|---|---|
| `/` | `index.html` | The landing page, built from the design canvas |
| `/studio/` | `studio/index.html` | The studio: pick a place, shape it, export it |
| `/studio/vendor/` | `studio/vendor/manifold.js`, `manifold.wasm` | Manifold 3.0.1, the geometry library the studio cuts the print parts with (frame, pins, tiles). Loaded only when a print file is made. Keep the two files together and at the same version |
| `/images/box/` | `model.webp`, `frame.webp`, `pin.webp` | The pictures in the basket's "What's in the box?" fold-out, rendered from the studio and the real print parts. Replace with photos of real prints whenever you like, at the same names |
| `/admin/` | `admin/index.html` | The admin page: colours, colour ways, frame finishes, prices and delivery, for this site. Locked to you by Cloudflare Access (see below). Its settings live in `site-settings.js` (rules and defaults) and in storage as `settings/preview.json` and `settings/live.json` |
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
- `RESEND_CONTACTS_KEY`: a **full-access** Resend key, used only for newsletter sign-ups
  (adding contacts needs full access; the order emails keep the sending-only key above)
- `NEWSLETTER_SEGMENT_ID` (optional): a Resend segment to put sign-ups in

## Newsletter

The box at the foot of the homepage (and the bar along the top that points to it) sends the
address to `POST /api/newsletter`, which adds it to your contacts in Resend. Until
`RESEND_CONTACTS_KEY` is set it says "Newsletter sign-up isn't switched on just yet".
Sign-ups appear in Resend under Contacts, and you send the newsletter from there.

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

## The questions (FAQ)

The homepage's questions live in `faq.txt`. To change them, open `faq.txt` on GitHub, click the
pencil, edit, and commit. Each question starts with `Q:` and its answer with `A:`; a blank line
inside an answer starts a new paragraph; web and email addresses become links. The homepage reads
the file every time it loads, so nothing else needs uploading.

## The admin page and its lock

`/admin` edits what the studio and basket offer and charge: which parts of the model are shown (water,
woodland, trees, shrubs, paths, roads, snow), filaments, colour ways (your own too: up to four filaments,
ticking which part prints in which), route and icon colours (each matte or standard), frame finishes,
prices, delivery and free delivery over a set spend, the homepage's titles and the lines under them, the
studio's section names, and the homepage's questions (which replace faq.txt once saved there). It won't save while something needs putting right
(a colour way using a filament you've removed, say): the panel on the right lists what. Preview and Live each keep
their own settings; the live page is red. On Live, each section shows a tick when it matches Preview and
a cross when it doesn't, with a copy button to bring Preview's across (copying only ever goes that way).
Nothing is saved in the code, so changes take effect straight away; if the settings can't be read, the
site falls back to what it was built with.

The lock is Cloudflare Access (Zero Trust, free for one person), with the server checking Access's signed
pass again on every admin request:

1. Cloudflare dashboard → Zero Trust (choose the Free plan) → Settings → Authentication: One-time PIN on.
2. Access → Applications → Add → Self-hosted, **misogimodel preview**: domain `preview.misogimodel.pages.dev`
   (the whole site), policy Allow → Emails → your address. Session 24 hours.
3. Add → Self-hosted, **misogimodel preview webhook**: `preview.misogimodel.pages.dev/api/stripe-webhook`,
   policy action **Bypass**, Include → Everyone (Stripe has to reach it; it checks Stripe's signature itself).
4. Add → Self-hosted, **misogimodel admin**: `misogimodel.com/admin`, `misogimodel.com/api/admin`
   (and the same on `misogimodel.pages.dev`), policy Allow → Emails → your address.
5. From the admin application's page, copy the **Application Audience (AUD) tag**; your team domain is
   under Settings → Custom Pages (`something.cloudflareaccess.com`). Add both to Workers & Pages →
   misogimodel → Settings → Variables (Production and Preview) as `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`.
   Plain text: neither is secret. Each Access application has its own AUD tag; give Preview's variable
   the preview application's tag, and Production's the admin one's.

Until both are set, every admin request is refused, so nothing can be changed. Only `ADMIN_EMAIL`
(or, if that's not set, `ORDER_EMAIL_TO`) is let in, even if the Access rule were wider.
