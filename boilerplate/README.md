# Khana client-site boilerplate

A React + Vite + TypeScript website for a Khana client: an online **store**, **bookings**, or **both**, wired to the khanaconnect API (this repo) out of the box. PayFast payments, WhatsApp/email confirmations and owner alerts are handled by the API.

| Store | Bookings | Always |
|---|---|---|
| Shop listing (search, categories) · product page (images, one variant group) · cart · checkout → PayFast · order confirmation | Services · day + time picker from live availability · booking form · optional PayFast deposit · booking confirmation | Home · contact form · WhatsApp button |

## Why it lives in this repo

The boilerplate is a thin layer over the API's public storefront endpoints, and the two must change together. Keeping it in `boilerplate/` means an API change and the matching boilerplate update land in **one PR**, and the API repo's tests can check the boilerplate's contract directly (`tests/boilerplateApiContract.test.js`), with no cross-repo version pinning. Client sites are created by copying this folder into their own repo (see below), so this copy stays the clean template.

## Launch a new client site

1. **Copy the folder** into a new repo for the client (keep `scripts/` and `api.contract.json`).
2. **Edit `site.config.ts`**. It's the only file you normally touch:
   - `mode`: `'store'`, `'bookings'` or `'both'`. This switches routes, nav and home sections.
   - `name`, `tagline`, `hero`, `contact`
   - `bookings.depositPercent` (0 = no deposit; >0 = PayFast deposit as % of the service price) and `daysAhead`
   - `theme`: colours, fonts (with optional Google Fonts URL), corner radius, `logoUrl`. Plain data on purpose, so template-gallery skins can become `theme` objects.
3. **Set the environment** in `.env.local` (see `.env.example`):
   - `VITE_API_BASE_URL`: `https://khanaconnect.onrender.com/api/v1` for live sites, a local or staging API while building
   - `VITE_STOREFRONT_TOKEN`: the client's storefront token (`client.token`, from the dashboard). It's public by design: it can only read the catalogue and create orders and bookings.
4. **In the dashboard, on the client record**:
   - PayFast `merchant_id` / `merchant_key` / passphrase
   - `return_url` = `https://<site>/checkout/success`, `cancel_url` = `https://<site>/checkout/cancel` (used for both orders and booking deposits)
   - delivery options (type + price): if there are none, only "collection" is offered
   - for bookings: services, opening hours, staff
5. `npm install`, `npm run dev`, then `npm run build` and deploy `dist/` (any static host; route all paths to `index.html`).

## Develop

```bash
npm install
npm run dev:mock          # mock API on :4010 (contract-checked, simulated PayFast)
npm run dev               # site on http://localhost:5180
```

Against a real API instead, set `VITE_API_BASE_URL=http://localhost:3000/api/v1` and a real storefront token. Run the API with `PAYFAST_SANDBOX=true`. Never use production data for testing.

| Script | What it does |
|---|---|
| `npm run dev` / `dev:mock` | Vite dev server / mock API |
| `npm run gen:api` | Regenerate the typed client from `../config/openapi.js` |
| `npm run gen:check` | Fail if the generated client is out of date (runs before `build`) |
| `npm run typecheck` | TypeScript only |
| `npm run build` | `gen:check` + typecheck + production build |
| `npm run e2e` | Every store/booking flow over HTTP, each response checked against the contract. `E2E_API` + `E2E_TOKEN` pick the API (defaults to the mock). Refuses production and live PayFast forms. |

## How the API client stays in sync

```
config/openapi.js ─┐  (Storefront* schemas in config/openapiStorefront.js)
                   ├─ npm run gen:api ─→ src/api/generated/schema.ts             (TS types + operation table)
api.contract.json ─┘                    src/api/generated/contract.snapshot.json (wire shapes it was built from)
```

- `api.contract.json` lists **every** operation the site calls. `src/api/client.ts` only accepts those operation ids, so every path, param, body and response is type-checked. Don't `fetch()` the API directly: unlisted calls aren't protected.
- In the API repo, `npm run test:contract` fails when:
  1. an operation the boilerplate uses is removed from `config/openapi.js`,
  2. no Express route is mounted for it any more (static read of `app.js` + `routes/`), or
  3. its request/response schema changed since the boilerplate was generated (wording-only edits to descriptions don't count).
- `npm run test:storefront` checks that the real handlers return what the schemas promise.

### After an API change

1. Change the route **and** its schema in `config/openapiStorefront.js` (the storefront payloads come from `helpers/storefrontCatalog.js`).
2. `npm run boilerplate:api` (repo root), or `npm run gen:api` in `boilerplate/`.
3. `cd boilerplate && npm run typecheck`. TypeScript now points at every page that uses a changed or removed field. Fix them.
4. Update `mock/server.mjs` if it returns the changed shape (it validates its own answers and returns 500 with a log line when stale).
5. `npm run test:contract && npm run test:storefront` at the root, then `npm run e2e` here. Commit the API change, the regenerated `src/api/generated/*` and the page fixes together.

### Using a new endpoint

Add `{ "id": "…", "method": "GET", "path": "/…" }` to `api.contract.json`. Make sure the operation has a typed 2xx JSON response in `config/openapi.js` (the generator refuses loose `FlexibleJson`-only operations). Then run `npm run gen:api` and call it with `api('<id>', …)`.

Existing client sites (copies) update the same way: pull the new `config/openapi.js` (or set `KHANA_API_REPO=<path to an API checkout>`), run `npm run gen:api`, then `npm run typecheck`.

## API endpoints used

All need `Authorization: Bearer <storefront token>`.

| Operation | Endpoint |
|---|---|
| getSite | `GET /storefront/site`: company name, delivery options, WhatsApp link |
| listCategories / listProducts / getProduct | `GET /storefront/categories`, `/storefront/products?category&featured&q`, `/storefront/products/{idOrSlug}` (published only, no cost prices) |
| createOrder | `POST /storefront/orders`: guest checkout. The API prices lines, adds delivery, reserves stock, creates an unpaid order. |
| payfastOrderCheckout | `POST /payments/payfast/checkout`: the API-signed PayFast form (passphrase never leaves the API) |
| getOrder | `GET /storefront/orders/{id}`: status for the confirmation page (no address or contact details) |
| listServices / getAvailability / createBooking | `GET /storefront/bookings/services`, `/storefront/bookings/availability`, `POST /storefront/bookings` |
| payfastBookingCheckout | `POST /payments/payfast/checkout/booking`: deposit form |
| sendContact | `POST /email/contact`: to the business inbox (honeypot field included) |

## Known limits

- **Booking deposits** are sent by the site (`depositAmount` = `depositPercent` × price), and the API trusts that number. The API also has no PayFast ITN handler for booking deposits yet, so a paid deposit isn't marked paid automatically.
- One variant group per product is offered (the order API prices one name/value per line).
- No customer accounts or discount codes yet (the API has endpoints for both, so they can be added through `api.contract.json`).
- PayFast returns to a fixed `return_url` without our ids, so the success page reads the last checkout from `localStorage` (or `?order=` / `?booking=`).
