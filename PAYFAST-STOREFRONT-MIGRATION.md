# PayFast checkout: storefront migration (Nov 2026)

Follows item 1 of `AUDIT-2026-11.md`.

Until now, storefronts signed the PayFast checkout form in the browser. To do that they read `merchant_key` and `passphrase` from `GET /api/v1/client/:clientId` with the storefront token, and that token is visible in public site code. So anyone could get the passphrase and sign any checkout for that business.

Now the API builds and signs the form itself. The storefront sends an order id and gets back a finished form to post to PayFast.

## What changed in the API

| Change | Where |
|---|---|
| New `POST /api/v1/payments/payfast/checkout` (orders) | `routes/payments.js`, `helpers/payfastCheckout.js` |
| New `POST /api/v1/payments/payfast/checkout/booking` (booking deposits) | same |
| `passphrase` removed from client payloads, except for the owner's settings view | `helpers/publicClientPayload.js`, `routes/client.js` |
| `PUT /client/:id` ignores a blank `passphrase` and only lets the owner change it | `routes/client.js` |
| Temporary switch `PAYFAST_LEGACY_STOREFRONT_PASSPHRASE` keeps old storefronts working | env on Render |

Who gets `passphrase` from `GET /client/:clientId` and `PUT /client/:clientId`:

| Caller | Gets passphrase? |
|---|---|
| Organisation owner (team sign-in), platform owner | Yes (settings view) |
| Storefront API token (`client.token`) | **Only while `PAYFAST_LEGACY_STOREFRONT_PASSPHRASE` is not `false`.** When it is sent, the response also has a `Deprecation: true` header and `client.payfastSigning.deprecated = true` |
| Shopper token, B2B buyer token, purpose tokens | Never (from deploy day) |
| Other team roles (admin, manager, staff) | Never |
| Platform-admin client list / create in `routes/client.js` | Never |

`merchant_key` is still returned, because it goes into the public PayFast form anyway. Only the passphrase is secret.

## What each storefront must change

### 1. Orders

Keep creating the order exactly as you do now (`POST /api/v1/orders`). Then, instead of building and signing the PayFast form in the browser:

```http
POST /api/v1/payments/payfast/checkout
Authorization: Bearer <storefront token, or the logged-in shopper's token>
Content-Type: application/json

{
  "orderId": "6730f1c2a9b8e4d5f6a7b8c9",
  "buyer": {
    "name_first": "Sipho",
    "name_last": "Dlamini",
    "email_address": "sipho@example.com",
    "cell_number": "0821234567"
  }
}
```

- `orderId` (required): the Mongo `_id` of the order you just created. `order_id` and `m_payment_id` are accepted as aliases.
- `buyer` (optional): it is signed, so pass it here, never add it to the form yourself. Invalid values are dropped: `cell_number` must be a 10-digit SA number starting with 0, and `email_address` must look like an email.

Response `200`:

```json
{
  "success": true,
  "kind": "order",
  "id": "6730f1c2a9b8e4d5f6a7b8c9",
  "method": "POST",
  "action": "https://www.payfast.co.za/eng/process",
  "host": "www.payfast.co.za",
  "fields": {
    "merchant_id": "10000100",
    "merchant_key": "46f0cd694581a",
    "return_url": "https://shop.example/checkout/success",
    "cancel_url": "https://shop.example/checkout/cancel",
    "notify_url": "https://khanaconnect.onrender.com/api/v1/payments/payfast/itn",
    "name_first": "Sipho",
    "name_last": "Dlamini",
    "email_address": "sipho@example.com",
    "cell_number": "0821234567",
    "m_payment_id": "6730f1c2a9b8e4d5f6a7b8c9",
    "amount": "349.90",
    "item_name": "Shop One order KC-1001",
    "custom_str1": "shop1",
    "custom_str2": "order",
    "signature": "3f2a…"
  }
}
```

Post every key in `fields` to `action`, unchanged, with `signature` included. If you add, remove or edit any field, PayFast rejects the signature.

```js
async function payWithPayfast(orderId, buyer) {
  const res = await fetch(`${API}/payments/payfast/checkout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, buyer }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Could not start payment');

  const form = document.createElement('form');
  form.method = data.method;
  form.action = data.action;
  for (const [name, value] of Object.entries(data.fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}
```

Then **delete** from the storefront:

- any code that reads `client.passphrase` (and, if only signing used it, `client.merchant_key`) from `GET /client/:clientId`
- the MD5 / signature code
- any hard-coded `amount`, `notify_url`, `return_url` or `cancel_url` in the PayFast form

What the server now decides (the storefront can't override these):

| Field | Source |
|---|---|
| `amount` | `order.finalPrice`, 2 decimals |
| `m_payment_id` | order `_id` (the ITN handler needs this) |
| `item_name` | `"<companyName> order <orderNumber or id>"` |
| `return_url`, `cancel_url` | the client record (`cancel_url` falls back to `return_url`) |
| `notify_url` | the client's `notify_url` if it already ends in `/payments/payfast/itn`, otherwise this API's `/api/v1/payments/payfast/itn` |
| PayFast host | `PAYFAST_SANDBOX=true` gives `sandbox.payfast.co.za`, otherwise `www.payfast.co.za` |

To change where buyers return after paying, update `return_url` / `cancel_url` on the client record in the dashboard.

### 2. Booking deposits (only storefronts that take a PayFast deposit)

```http
POST /api/v1/payments/payfast/checkout/booking
Authorization: Bearer <storefront token>
Content-Type: application/json

{ "bookingId": "6730f1c2a9b8e4d5f6a7b8d0", "buyer": { … optional … } }
```

The response has the same shape, with `kind: "booking"`. `amount` comes from `booking.payment.depositAmount`. The buyer name and email default to the booking's `customerName` and `customerEmail`. `custom_str2` is `"booking"`. `notify_url` is the client's own `notify_url`, the same as before.

> Note: this API has no PayFast-format ITN handler for bookings. `POST /bookings/:id/payment-confirmation` expects its own JSON body, not a PayFast ITN. A paid deposit is therefore not marked paid automatically unless something outside this API handles it, which is also true today. This change does not fix or worsen that.

### Errors to handle

| Status | `code` | Meaning |
|---|---|---|
| 400 | | `orderId` / `bookingId` missing or not a 24-character id |
| 401 | | No token, or the token is invalid |
| 403 | | Token type not allowed (B2B buyer or purpose tokens) |
| 404 | | Order or booking not found for this business, or it belongs to another shopper |
| 409 | `ALREADY_PAID` | Already paid. Send the shopper to the success page |
| 409 | `REFUNDED` / `CANCELLED` | Order refunded or booking cancelled |
| 409 | `NO_AMOUNT` | Total or deposit is 0 |
| 409 | `PAYFAST_NOT_CONFIGURED` | The client has no `merchant_id` / `merchant_key` / `return_url` |

## Rollout

1. Deploy the API. Nothing breaks: storefront tokens still get `passphrase` and the old browser signing keeps working. Shopper tokens lose it straight away (see the risk below).
2. Move each storefront to `POST /payments/payfast/checkout` (and `/booking` if needed), and make a sandbox payment through it.
3. When every storefront has moved, set `PAYFAST_LEGACY_STOREFRONT_PASSPHRASE=false` on Render and redeploy. From then on, only the owner settings view returns the passphrase.
4. **Rotate every client's PayFast passphrase** in PayFast and in Khana. The old ones were public, so they must be treated as leaked.

**Risk in step 1:** a storefront that calls `GET /client/:clientId` with the logged-in shopper's token (rather than the storefront token) loses `passphrase` from day one, so checkout breaks for logged-in shoppers. If any storefront does this, move it first or deploy together with its migration.

## What was checked

- **Order ITN** (`routes/payments.js` `/payfast/itn`): finds the client by `merchant_id`, then the order by `m_payment_id` = order `_id` for that client. It then checks PayFast's validate response and `amount_gross` against `finalPrice` (±0.02). The signed form sends exactly those values. The offline test sends the generated fields back through the ITN handler and checks the order is fulfilled, and that a tampered amount is not.
- **Signature**: same encoding as `verifyPayFastSignature` (trim, URL-encode, spaces as `+`, `&passphrase=` appended). PHP also encodes `! ' ( ) * ~`, so the new code does too. Fields go in PayFast's checkout attribute order. Alphabetical order is only for PayFast's REST API and would fail on the checkout form.
- **Encrypted passphrases**: records migrated by `/client/migrate/encrypt-merchant-fields` store `iv:cipher`. The signer decrypts these, and plain values are used as they are.

Tests: `node tests/payfastCheckout.test.js` (offline, with stubbed express/mongoose/models, 17 checks).

## Not changed (follow-ups)

- `routes/admin.js` `GET /admin/clients` still returns the full client (including `passphrase` and `businessEmailPassword`) to the platform admin. It is admin-only, but it should use `stripClientSecrets` too.
- `fulfillGatewayPayment` overwrites `order.totalPrice` with `amount_gross`. Behaviour is unchanged here, but worth a look.
- A PayFast ITN handler for booking deposits.
