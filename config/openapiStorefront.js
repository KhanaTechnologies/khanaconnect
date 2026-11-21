/**
 * OpenAPI paths + schemas for the public client-website API (storefront token).
 * Merged into config/openapi.js.
 *
 * These schemas are a CONTRACT, not just docs:
 *  - tests/storefrontApi.test.js checks the real handlers' output against them;
 *  - the client-site boilerplate (boilerplate/) generates its TypeScript client from them, and
 *    tests/boilerplateApiContract.test.js fails if an operation it uses disappears or its
 *    schema changes without the boilerplate being regenerated.
 * When you change a storefront response, update the schema here, then run
 * `npm run boilerplate:api` (see boilerplate/README.md).
 */

const S = [{ storefrontToken: [] }];
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (name, description = 'OK') => ({
  description,
  content: { 'application/json': { schema: ref(name) } },
});
const body = (name) => ({
  required: true,
  content: { 'application/json': { schema: ref(name) } },
});
const errors = {
  400: json('StorefrontError', 'Bad request'),
  401: json('StorefrontError', 'Website token missing or invalid'),
  403: json('StorefrontError', 'Token type not allowed'),
  402: json('StorefrontError', 'Client subscription inactive'),
};

function opDef(summary, extra = {}) {
  const { responses = {}, ...rest } = extra;
  return {
    tags: ['Storefront'],
    summary,
    security: S,
    ...rest,
    responses: { ...errors, ...responses },
  };
}

const str = { type: 'string' };
const num = { type: 'number' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const nullableStr = { type: 'string', nullable: true };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', required, properties });
const arr = (items) => ({ type: 'array', items });

const storefrontSchemas = {
  StorefrontError: obj({ error: str, code: str }, ['error']),

  StorefrontSite: obj({
    clientID: str,
    companyName: str,
    currency: { type: 'string', enum: ['ZAR'] },
    deliveryOptions: arr(obj({ type: str, price: num })),
    whatsappChatUrl: nullableStr,
  }),

  StorefrontCategory: obj({ id: str, name: str, description: str, image: nullableStr, parentId: nullableStr }),
  StorefrontCategoryList: obj({ categories: arr(ref('StorefrontCategory')) }),

  StorefrontVariantValue: obj({ value: str, unitPrice: num, inStock: bool }),
  StorefrontVariant: obj({ name: str, values: arr(ref('StorefrontVariantValue')) }),
  StorefrontProduct: obj({
    id: str,
    name: str,
    slug: str,
    description: str,
    richDescription: str,
    price: { type: 'number', description: 'List price before sale' },
    salePercentage: num,
    unitPrice: { type: 'number', description: 'What the shopper pays (sale applied), no variant' },
    images: arr(str),
    brand: str,
    category: { ...obj({ id: str, name: str }), nullable: true },
    tags: arr(str),
    isFeatured: bool,
    inStock: bool,
    stock: int,
    rating: num,
    numReviews: int,
    metaTitle: str,
    metaDescription: str,
    variants: arr(ref('StorefrontVariant')),
  }),
  StorefrontProductList: obj({ products: arr(ref('StorefrontProduct')) }),
  StorefrontProductResponse: obj({ product: ref('StorefrontProduct') }),

  StorefrontOrderCreate: obj(
    {
      customer: obj({ firstName: str, lastName: str, email: str, phone: str }),
      shipping: obj(
        { address: str, city: str, province: str, postalCode: str, country: { type: 'string', example: 'ZA' } },
        []
      ),
      deliveryType: { type: 'string', description: 'One of StorefrontSite.deliveryOptions[].type, or "collection" when none are set up' },
      items: arr(
        obj(
          {
            productId: str,
            quantity: { type: 'integer', minimum: 1, maximum: 99 },
            variant: obj({ name: str, value: str }),
          },
          ['productId', 'quantity']
        )
      ),
      notes: str,
    },
    ['customer', 'deliveryType', 'items']
  ),
  StorefrontOrderLine: obj({
    productId: nullableStr,
    name: str,
    image: nullableStr,
    variant: str,
    quantity: int,
    unitPrice: num,
    lineTotal: num,
  }),
  StorefrontOrder: obj({
    id: str,
    orderNumber: str,
    status: str,
    paid: bool,
    items: arr(ref('StorefrontOrderLine')),
    subtotal: num,
    deliveryType: str,
    deliveryPrice: num,
    discountAmount: num,
    total: num,
    currency: { type: 'string', enum: ['ZAR'] },
    createdAt: nullableStr,
  }),
  StorefrontOrderResponse: obj({ order: ref('StorefrontOrder') }),

  StorefrontService: obj(
    {
      _id: str,
      name: str,
      description: str,
      price: num,
      duration: int,
      category: str,
      image: str,
      staffIds: arr(str),
      bufferBeforeMin: int,
      bufferAfterMin: int,
    },
    ['_id', 'name', 'price', 'duration']
  ),
  StorefrontServiceList: obj({ services: arr(ref('StorefrontService')) }),
  StorefrontSlot: obj({ time: str, endTime: str, duration: int, available: bool }),
  StorefrontAvailability: obj({
    date: { type: 'string', example: '2026-12-01' },
    duration: int,
    hours: { type: 'object', description: 'Opening hours for the day: { start, end, closed? }' },
    availableSlots: arr(ref('StorefrontSlot')),
  }),
  StorefrontBookingCreate: obj(
    {
      customerName: str,
      customerEmail: str,
      customerPhone: str,
      services: arr(str),
      date: { type: 'string', example: '2026-12-01' },
      time: { type: 'string', example: '09:30' },
      duration: int,
      assignedTo: str,
      notes: str,
      depositAmount: num,
    },
    ['customerName', 'customerEmail', 'customerPhone', 'services', 'date', 'time']
  ),
  StorefrontBooking: obj(
    {
      _id: str,
      status: str,
      services: arr(str),
      date: str,
      time: str,
      endTime: str,
      duration: int,
      customerName: str,
      payment: obj({ status: str, depositAmount: num, currency: str }, ['status']),
    },
    ['_id', 'status', 'services', 'date', 'time', 'endTime', 'payment']
  ),
  StorefrontBookingCreated: obj({ booking: ref('StorefrontBooking'), depositRequired: bool, message: str }),

  PayfastBuyer: obj({ name_first: str, name_last: str, email_address: str, cell_number: str }, []),
  PayfastOrderCheckoutRequest: obj({ orderId: str, buyer: ref('PayfastBuyer') }, ['orderId']),
  PayfastBookingCheckoutRequest: obj({ bookingId: str, buyer: ref('PayfastBuyer') }, ['bookingId']),
  PayfastCheckoutResponse: obj({
    success: bool,
    kind: { type: 'string', enum: ['order', 'booking'] },
    id: str,
    method: { type: 'string', enum: ['POST'] },
    action: str,
    host: str,
    fields: { type: 'object', additionalProperties: { type: 'string' } },
  }),

  ContactRequest: obj(
    { name: str, email: str, phone: str, message: str, hp_field: { type: 'string', description: 'Honeypot: leave empty' } },
    ['name', 'email', 'message']
  ),
  ContactResponse: obj({ ok: bool, message: str }),
};

function storefrontPaths(a) {
  return {
    [`${a}/storefront/site`]: {
      get: opDef('Website settings: company name, delivery options, WhatsApp link', {
        responses: { 200: json('StorefrontSite') },
      }),
    },
    [`${a}/storefront/categories`]: {
      get: opDef('Catalogue categories', { responses: { 200: json('StorefrontCategoryList') } }),
    },
    [`${a}/storefront/products`]: {
      get: opDef('Published products', {
        parameters: [
          { name: 'category', in: 'query', schema: str, description: 'Category id' },
          { name: 'featured', in: 'query', schema: { type: 'string', enum: ['true'] } },
          { name: 'q', in: 'query', schema: str, description: 'Name search' },
        ],
        responses: { 200: json('StorefrontProductList') },
      }),
    },
    [`${a}/storefront/products/{idOrSlug}`]: {
      get: opDef('One published product by id or slug', {
        parameters: [{ name: 'idOrSlug', in: 'path', required: true, schema: str }],
        responses: { 200: json('StorefrontProductResponse'), 404: json('StorefrontError', 'Not found') },
      }),
    },
    [`${a}/storefront/orders`]: {
      post: opDef('Guest checkout: create an unpaid order', {
        description:
          'Prices, delivery cost and totals come from the database. Stock is reserved; unpaid orders expire. Then call `POST /payments/payfast/checkout` with the returned `order.id`. Errors carry `code`: `PRODUCT_UNAVAILABLE`, `UNKNOWN_VARIANT` (400), `OUT_OF_STOCK` (409).',
        requestBody: body('StorefrontOrderCreate'),
        responses: { 201: json('StorefrontOrderResponse', 'Created'), 409: json('StorefrontError', 'Out of stock') },
      }),
    },
    [`${a}/storefront/orders/{id}`]: {
      get: opDef('Order status for the confirmation page (no address or contact details)', {
        parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
        responses: { 200: json('StorefrontOrderResponse'), 404: json('StorefrontError', 'Not found') },
      }),
    },
    [`${a}/storefront/bookings/services`]: {
      get: opDef('Bookable services', { responses: { 200: json('StorefrontServiceList') } }),
    },
    [`${a}/storefront/bookings/availability`]: {
      get: opDef('Free time slots for a day', {
        parameters: [
          { name: 'date', in: 'query', required: true, schema: str },
          { name: 'serviceName', in: 'query', schema: str },
          { name: 'assignedTo', in: 'query', schema: str, description: 'Staff id' },
          { name: 'duration', in: 'query', schema: int },
        ],
        responses: { 200: json('StorefrontAvailability') },
      }),
    },
    [`${a}/storefront/bookings`]: {
      post: opDef('Book a slot', {
        description:
          'Status is `confirmed`, or `pending` when `depositAmount` > 0 (then call `POST /payments/payfast/checkout/booking`). 409 when the slot is taken.',
        requestBody: body('StorefrontBookingCreate'),
        responses: { 201: json('StorefrontBookingCreated', 'Created'), 409: json('StorefrontError', 'Slot taken') },
      }),
    },
    [`${a}/payments/payfast/checkout`]: {
      post: {
        ...opDef('Signed PayFast checkout for an order', {
          description:
            'Storefront API token or shopper token. Builds the PayFast fields from the order (`amount` = `finalPrice`, `m_payment_id` = order id) and signs them on the server. POST every key in `fields` unchanged to `action`. 404 unknown/other business; 409 with `code` `ALREADY_PAID`, `REFUNDED`, `NO_AMOUNT` or `PAYFAST_NOT_CONFIGURED`.',
          requestBody: body('PayfastOrderCheckoutRequest'),
          responses: { 200: json('PayfastCheckoutResponse'), 404: json('StorefrontError'), 409: json('StorefrontError') },
        }),
        tags: ['Payments'],
      },
    },
    [`${a}/payments/payfast/checkout/booking`]: {
      post: {
        ...opDef('Signed PayFast checkout for a booking deposit', {
          description:
            'Same as the order checkout. `amount` = `payment.depositAmount`, `m_payment_id` = booking id, buyer defaults to the booking name and email.',
          requestBody: body('PayfastBookingCheckoutRequest'),
          responses: { 200: json('PayfastCheckoutResponse'), 404: json('StorefrontError'), 409: json('StorefrontError') },
        }),
        tags: ['Payments'],
      },
    },
    [`${a}/email/contact`]: {
      post: {
        ...opDef('Website contact form → business inbox', {
          description: 'Storefront token. Rate-limited (5/hour per IP). A filled `hp_field` is treated as a bot and silently accepted.',
          requestBody: body('ContactRequest'),
          responses: { 200: json('ContactResponse'), 500: json('ContactResponse', 'Could not send') },
        }),
        tags: ['Email'],
      },
    },
  };
}

const storefrontSecurityScheme = {
  storefrontToken: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      "The client's storefront token (`client.token`, shown in the dashboard). It ships in public website code, so it can only read the catalogue and create orders/bookings.",
  },
};

const storefrontTag = {
  name: 'Storefront',
  description:
    'Public client-website API (`/storefront/*`). Used by the client-site boilerplate in `boilerplate/`; response shapes are a tested contract.',
};

module.exports = { storefrontPaths, storefrontSchemas, storefrontSecurityScheme, storefrontTag };
