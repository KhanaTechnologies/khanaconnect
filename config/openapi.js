/**
 * OpenAPI 3.0 specification for KhanaConnect API.
 * Served at GET /openapi.json and interactive docs at /api-docs.
 *
 * Covers routes mounted in app.js. Security reflects typical use:
 * - bearerAuth: HS256 JWT (client dashboard — payload includes clientID).
 * - customerBearer: same scheme/bearerFormat; token must include customerID (storefront / voting).
 * express-jwt may exempt some paths; route-level middleware can still require Bearer — prefer sending a token when unsure.
 */
const apiPath = process.env.API_URL || '/api/v1';

const R = {
  ok: { 200: { description: 'OK' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' } },
};

const B = [{ bearerAuth: [] }];
const C = [{ customerBearer: [] }];
const P = [];
const paramId = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const paramClientId = { name: 'clientId', in: 'path', required: true, schema: { type: 'string' } };

function op(method, tag, summary, security, extra = {}) {
  return {
    tags: [tag],
    summary,
    security,
    responses: R.ok,
    ...extra,
  };
}

function crudResource(basePath, tag, name, security = B) {
  const idPath = `${basePath}/{id}`;
  return {
    [basePath]: {
      get: op('get', tag, `List ${name}`, security),
      post: op('post', tag, `Create ${name}`, security),
    },
    [idPath]: {
      get: op('get', tag, `Get ${name} by id`, security, { parameters: [paramId] }),
      put: op('put', tag, `Update ${name}`, security, { parameters: [paramId] }),
      delete: op('delete', tag, `Delete ${name}`, security, { parameters: [paramId] }),
    },
  };
}

function buildPaths(a) {
  return {
    '/': {
      get: op('get', 'Meta', 'HTML home (Express view)', P, { responses: { 200: { description: 'HTML' } } }),
    },

    ...crudResource(`${a}/wishlists`, 'Wishlists', 'wishlist item'),
    ...crudResource(`${a}/categories`, 'Categories', 'category'),
    ...crudResource(`${a}/size`, 'Sizes', 'size'),
    ...crudResource(`${a}/staff`, 'Staff', 'staff member'),
    ...crudResource(`${a}/services`, 'Services', 'service'),
    ...crudResource(`${a}/resources`, 'Resources', 'resource'),

    [`${a}/emailsub/subscribe`]: { post: op('post', 'Email subscriptions', 'Subscribe (Bearer: client JWT)', B) },
    [`${a}/emailsub/unsubscribe`]: { post: op('post', 'Email subscriptions', 'Unsubscribe (Bearer: client JWT)', B) },
    [`${a}/emailsub/export`]: { get: op('get', 'Email subscriptions', 'Export subscribers CSV', B) },

    [`${a}/products`]: {
      get: op('get', 'Products', 'List products', B),
      post: op('post', 'Products', 'Create product (often multipart)', B),
    },
    [`${a}/products/get/featured/{count}`]: {
      get: op('get', 'Products', 'Featured products', B, {
        parameters: [{ name: 'count', in: 'path', required: true, schema: { type: 'integer' } }],
      }),
    },
    [`${a}/products/{id}`]: {
      get: op('get', 'Products', 'Get product by id', B, { parameters: [paramId] }),
      put: op('put', 'Products', 'Update product', B, { parameters: [paramId] }),
      delete: op('delete', 'Products', 'Delete product', B, { parameters: [paramId] }),
    },

    [`${a}/productsales`]: {
      get: op('get', 'Product sales', 'List product sales', B),
      post: op('post', 'Product sales', 'Create product sale', B),
    },
    [`${a}/productsales/{id}`]: { delete: op('delete', 'Product sales', 'Delete product sale', B, { parameters: [paramId] }) },

    [`${a}/discountcode/verify-discount-code`]: {
      post: op('post', 'Discount codes', 'Verify discount code for cart', B),
    },
    [`${a}/discountcode/createCheckoutCode`]: {
      post: op('post', 'Discount codes', 'Create checkout code', B),
    },
    [`${a}/discountcode/checkout-codes`]: {
      get: op('get', 'Discount codes', 'List checkout codes', B),
    },
    [`${a}/discountcode/checkout-codes/{id}`]: {
      put: op('put', 'Discount codes', 'Update checkout code', B, { parameters: [paramId] }),
      delete: op('delete', 'Discount codes', 'Delete checkout code', B, { parameters: [paramId] }),
    },

    [`${a}/orders`]: {
      get: op('get', 'Orders', 'List orders (client JWT)', B),
      post: op('post', 'Orders', 'Create order', B),
    },
    [`${a}/orders/{id}`]: {
      get: op('get', 'Orders', 'Get order', B, { parameters: [paramId] }),
      put: op('put', 'Orders', 'Update order', B, { parameters: [paramId] }),
      delete: op('delete', 'Orders', 'Delete order', B, { parameters: [paramId] }),
    },
    [`${a}/orders/update-order-payment`]: {
      post: op('post', 'Orders', 'Payment gateway callback (X-Webhook-Secret / X-Order-Webhook-Secret only when ORDER_PAYMENT_WEBHOOK_ENABLED=true)', P, {
        responses: { 200: { description: 'OK' }, 400: { description: 'Bad request' }, 401: { description: 'Unauthorized' } },
      }),
    },
    [`${a}/orders/get/totalsales`]: { get: op('get', 'Orders', 'Total sales (paid)', B) },
    [`${a}/orders/get/count`]: { get: op('get', 'Orders', 'Order count', B) },
    [`${a}/orders/get/userorders/{userid}`]: {
      get: op('get', 'Orders', 'Orders for customer user', B, {
        parameters: [{ name: 'userid', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    [`${a}/orders/analytics/customer/{customerId}`]: {
      get: op('get', 'Orders', 'Per-customer order analytics', B, {
        parameters: [{ name: 'customerId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    [`${a}/orders/analytics/sales`]: { get: op('get', 'Orders', 'Sales analytics', B) },

    [`${a}/bookings`]: {
      get: op('get', 'Bookings', 'List bookings', B),
      post: op('post', 'Bookings', 'Create booking', B),
    },
    [`${a}/bookings/{id}`]: {
      put: op('put', 'Bookings', 'Update booking', B, { parameters: [paramId] }),
      delete: op('delete', 'Bookings', 'Delete booking', B, { parameters: [paramId] }),
    },
    [`${a}/bookings/{id}/payment-confirmation`]: {
      post: op('post', 'Bookings', 'Payment confirmation (X-Webhook-Secret / X-Booking-Webhook-Secret only when BOOKING_PAYMENT_WEBHOOK_ENABLED=true)', P, {
        parameters: [paramId],
        responses: { 200: { description: 'OK' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } },
      }),
    },
    [`${a}/bookings/availability/check`]: {
      get: op('get', 'Bookings', 'Check availability for date', B, {
        parameters: [
          { name: 'date', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'duration', in: 'query', schema: { type: 'integer' } },
          { name: 'resourceId', in: 'query', schema: { type: 'string' } },
        ],
      }),
    },
    [`${a}/bookings/availability/advanced-check`]: {
      get: op('get', 'Bookings', 'Advanced availability check', B),
    },
    [`${a}/bookings/resources/available`]: { get: op('get', 'Bookings', 'Available resources', B) },
    [`${a}/bookings/waitlist`]: {
      get: op('get', 'Bookings', 'List waitlist', B),
      post: op('post', 'Bookings', 'Add to waitlist', B),
    },
    [`${a}/bookings/waitlist/{id}`]: {
      get: op('get', 'Bookings', 'Get waitlist entry', B, { parameters: [paramId] }),
      put: op('put', 'Bookings', 'Update waitlist entry', B, { parameters: [paramId] }),
      delete: op('delete', 'Bookings', 'Remove waitlist entry', B, { parameters: [paramId] }),
    },
    [`${a}/bookings/waitlist/{id}/convert-to-booking`]: {
      post: op('post', 'Bookings', 'Convert waitlist to booking', B, { parameters: [paramId] }),
    },
    [`${a}/bookings/debug/all-bookings`]: { get: op('get', 'Bookings', 'Debug: all bookings', B) },

    [`${a}/analytics/overview`]: { get: op('get', 'Analytics', 'Client analytics overview', B) },

    [`${a}/preorderpledge/interest-campaign-signup`]: {
      post: op('post', 'Preorder pledge', 'Interest campaign signup', B),
    },
    [`${a}/preorderpledge/funding-campaign-interest`]: {
      post: op('post', 'Preorder pledge', 'Funding campaign interest', B),
    },
    [`${a}/preorderpledge/funding-campaign-pledge`]: {
      post: op('post', 'Preorder pledge', 'Funding campaign pledge', B),
    },
    [`${a}/preorderpledge`]: { get: op('get', 'Preorder pledge', 'List pledges', B) },
    [`${a}/preorderpledge/{id}`]: { get: op('get', 'Preorder pledge', 'Get pledge', B, { parameters: [paramId] }) },
    [`${a}/preorderpledge/{id}/payment`]: {
      patch: op('patch', 'Preorder pledge', 'Update pledge payment', B, { parameters: [paramId] }),
    },
    [`${a}/preorderpledge/{id}/cancel`]: {
      patch: op('patch', 'Preorder pledge', 'Cancel pledge', B, { parameters: [paramId] }),
    },
    [`${a}/preorderpledge/campaign/{campaignId}/signups`]: {
      get: op('get', 'Preorder pledge', 'Campaign signups', B, {
        parameters: [{ name: 'campaignId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    [`${a}/preorderpledge/campaign/{campaignId}/export`]: {
      get: op('get', 'Preorder pledge', 'Export campaign signups', B, {
        parameters: [{ name: 'campaignId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    [`${a}/preorderpledge/campaign/{campaignId}/stats`]: {
      get: op('get', 'Preorder pledge', 'Campaign stats', B, {
        parameters: [{ name: 'campaignId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    [`${a}/preorderpledge/campaign/{campaignId}/notify`]: {
      post: op('post', 'Preorder pledge', 'Notify campaign (admin)', B, {
        parameters: [{ name: 'campaignId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },

    [`${a}/campaigns`]: {
      get: op('get', 'Campaigns', 'List campaigns', B),
      post: op('post', 'Campaigns', 'Create campaign', B),
    },
    [`${a}/campaigns/type/{type}`]: {
      get: op('get', 'Campaigns', 'Campaigns by type', B, {
        parameters: [{ name: 'type', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    [`${a}/campaigns/stats/by-type`]: { get: op('get', 'Campaigns', 'Stats by type', B) },
    [`${a}/campaigns/active`]: { get: op('get', 'Campaigns', 'Active campaigns', B) },
    [`${a}/campaigns/public/{campaignId}`]: {
      get: op('get', 'Campaigns', 'Public campaign page data', P, {
        parameters: [{ name: 'campaignId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK' } },
      }),
    },
    [`${a}/campaigns/{id}`]: {
      get: op('get', 'Campaigns', 'Get campaign', B, { parameters: [paramId] }),
      put: op('put', 'Campaigns', 'Update campaign', B, { parameters: [paramId] }),
      delete: op('delete', 'Campaigns', 'Delete campaign', B, { parameters: [paramId] }),
    },
    [`${a}/campaigns/{id}/status`]: {
      patch: op('patch', 'Campaigns', 'Update campaign status', B, { parameters: [paramId] }),
    },
    [`${a}/campaigns/{id}/upload-cover`]: { post: op('post', 'Campaigns', 'Upload cover image (multipart)', B, { parameters: [paramId] }) },
    [`${a}/campaigns/{id}/upload-gallery`]: {
      post: op('post', 'Campaigns', 'Upload gallery images (multipart)', B, { parameters: [paramId] }),
    },
    [`${a}/campaigns/{id}/rewards`]: { post: op('post', 'Campaigns', 'Add rewards', B, { parameters: [paramId] }) },
    [`${a}/campaigns/{id}/metrics`]: { get: op('get', 'Campaigns', 'Campaign metrics', B, { parameters: [paramId] }) },
    [`${a}/campaigns/{id}/signups`]: { get: op('get', 'Campaigns', 'List signups', B, { parameters: [paramId] }) },
    [`${a}/campaigns/{campaignId}/signups/{signupId}`]: {
      get: op('get', 'Campaigns', 'Single signup', B, {
        parameters: [
          { name: 'campaignId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'signupId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
    },
    [`${a}/campaigns/{id}/signups/export`]: {
      get: op('get', 'Campaigns', 'Export signups', B, { parameters: [paramId] }),
    },
    [`${a}/campaigns/{id}/cover`]: { delete: op('delete', 'Campaigns', 'Remove cover', B, { parameters: [paramId] }) },
    [`${a}/campaigns/{id}/gallery/{imageIndex}`]: {
      delete: op('delete', 'Campaigns', 'Remove gallery image', B, {
        parameters: [
          paramId,
          { name: 'imageIndex', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
    },

    [`${a}/votingcampaigns`]: {
      get: op('get', 'Voting campaigns', 'List voting campaigns', B),
      post: op('post', 'Voting campaigns', 'Create voting campaign', B),
    },
    [`${a}/votingcampaigns/type/{type}`]: {
      get: op('get', 'Voting campaigns', 'By type', B, {
        parameters: [{ name: 'type', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    [`${a}/votingcampaigns/active`]: { get: op('get', 'Voting campaigns', 'Active campaigns', B) },
    [`${a}/votingcampaigns/public/{id}`]: {
      get: op('get', 'Voting campaigns', 'Public campaign (no auth)', P, {
        parameters: [paramId],
        responses: { 200: { description: 'OK' } },
      }),
    },
    [`${a}/votingcampaigns/public/{id}/vote`]: {
      post: op('post', 'Voting campaigns', 'Cast vote (customer JWT)', C, { parameters: [paramId] }),
      delete: op('delete', 'Voting campaigns', 'Remove vote (customer JWT)', C, { parameters: [paramId] }),
    },
    [`${a}/votingcampaigns/public/{id}/my-vote`]: {
      get: op('get', 'Voting campaigns', 'Current customer vote (customer JWT)', C, { parameters: [paramId] }),
    },
    [`${a}/votingcampaigns/customer/votes`]: {
      get: op('get', 'Voting campaigns', 'Customer vote history (customer JWT)', C),
    },
    [`${a}/votingcampaigns/{id}`]: {
      get: op('get', 'Voting campaigns', 'Get campaign', B, { parameters: [paramId] }),
      put: op('put', 'Voting campaigns', 'Update campaign', B, { parameters: [paramId] }),
      delete: op('delete', 'Voting campaigns', 'Delete campaign (admin)', B, { parameters: [paramId] }),
    },
    [`${a}/votingcampaigns/{id}/status`]: {
      patch: op('patch', 'Voting campaigns', 'Update status', B, { parameters: [paramId] }),
    },
    [`${a}/votingcampaigns/{id}/upload-cover`]: {
      post: op('post', 'Voting campaigns', 'Upload cover (multipart)', B, { parameters: [paramId] }),
    },
    [`${a}/votingcampaigns/{id}/items`]: { post: op('post', 'Voting campaigns', 'Add item', B, { parameters: [paramId] }) },
    [`${a}/votingcampaigns/{id}/items/{itemId}`]: {
      put: op('put', 'Voting campaigns', 'Update item', B, {
        parameters: [
          paramId,
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
      delete: op('delete', 'Voting campaigns', 'Delete item (admin)', B, {
        parameters: [
          paramId,
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
    },
    [`${a}/votingcampaigns/{id}/items/{itemId}/images`]: {
      post: op('post', 'Voting campaigns', 'Upload item image', B, {
        parameters: [
          paramId,
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
      get: op('get', 'Voting campaigns', 'List item images', B, {
        parameters: [
          paramId,
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
      delete: op('delete', 'Voting campaigns', 'Delete item images', B, {
        parameters: [
          paramId,
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
    },
    [`${a}/votingcampaigns/{id}/items/{itemId}/images/bulk`]: {
      post: op('post', 'Voting campaigns', 'Bulk upload item images', B, {
        parameters: [
          paramId,
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
    },
    [`${a}/votingcampaigns/{id}/items/{itemId}/images/primary`]: {
      patch: op('patch', 'Voting campaigns', 'Set primary image', B, {
        parameters: [
          paramId,
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
    },
    [`${a}/votingcampaigns/{id}/items/{itemId}/images/reorder`]: {
      patch: op('patch', 'Voting campaigns', 'Reorder images', B, {
        parameters: [
          paramId,
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
    },
    [`${a}/votingcampaigns/{id}/results`]: { get: op('get', 'Voting campaigns', 'Results', B, { parameters: [paramId] }) },
    [`${a}/votingcampaigns/{id}/stats`]: { get: op('get', 'Voting campaigns', 'Stats', B, { parameters: [paramId] }) },
    [`${a}/votingcampaigns/{id}/duplicate`]: { post: op('post', 'Voting campaigns', 'Duplicate campaign', B, { parameters: [paramId] }) },
    [`${a}/votingcampaigns/analytics/overview`]: { get: op('get', 'Voting campaigns', 'Analytics overview', B) },

    [`${a}/admin/clients`]: { get: op('get', 'Admin', 'List clients', B) },
    [`${a}/admin/clients/{id}`]: {
      get: op('get', 'Admin', 'Get client', B, { parameters: [paramId] }),
      put: op('put', 'Admin', 'Update client', B, { parameters: [paramId] }),
    },
    [`${a}/admin/clients/{id}/token-expiration`]: {
      get: op('get', 'Admin', 'Token expiration (nested JWT)', B, { parameters: [paramId] }),
    },
    [`${a}/admin/clients/{id}/generate-client-token`]: {
      post: op('post', 'Admin', 'Generate client token', B, { parameters: [paramId] }),
    },
    [`${a}/admin/clients/{id}/delete-client-token`]: {
      post: op('post', 'Admin', 'Delete client token', B, { parameters: [paramId] }),
    },
    [`${a}/admin/numberOfClients`]: { get: op('get', 'Admin', 'Client count', B) },
    [`${a}/admin/clients/{id}/numberOfOrders`]: { get: op('get', 'Admin', 'Order count for client', B, { parameters: [paramId] }) },
    [`${a}/admin/clients/{id}/numberOfProducts`]: { get: op('get', 'Admin', 'Product count', B, { parameters: [paramId] }) },
    [`${a}/admin/clients/{id}/numberOfCategories`]: { get: op('get', 'Admin', 'Category count', B, { parameters: [paramId] }) },
    [`${a}/admin/clients/{id}/numberOfBookings`]: { get: op('get', 'Admin', 'Booking count', B, { parameters: [paramId] }) },
    [`${a}/admin/clients/{id}/numberOfServices`]: { get: op('get', 'Admin', 'Service count', B, { parameters: [paramId] }) },
    [`${a}/admin/clients/{id}/numberOfStaff`]: { get: op('get', 'Admin', 'Staff count', B, { parameters: [paramId] }) },
    [`${a}/admin/clients/{id}/numberOfSales`]: { get: op('get', 'Admin', 'Sales count', B, { parameters: [paramId] }) },
    [`${a}/admin/clients/{id}/numberOfDiscountCodes`]: { get: op('get', 'Admin', 'Discount code count', B, { parameters: [paramId] }) },
    [`${a}/admin/clients/{id}/permissions`]: {
      put: op('put', 'Admin', 'Update client permissions', B, { parameters: [paramId] }),
    },

    [`${a}/client`]: {
      get: op('get', 'Client', 'List clients (public GET per server config)', P, { responses: { 200: { description: 'OK' } } }),
      post: op('post', 'Client', 'Register / create client', P, { responses: { 200: { description: 'OK' }, 201: { description: 'Created' } } }),
    },
    [`${a}/client/login`]: {
      post: op('post', 'Client', 'Client login (returns JWT)', P, { responses: { 200: { description: 'Token issued' }, 401: { description: 'Invalid credentials' } } }),
    },
    [`${a}/client/logout`]: { post: op('post', 'Client', 'Logout', B) },
    [`${a}/client/{clientId}`]: {
      get: op('get', 'Client', 'Get client by id', B, { parameters: [paramClientId] }),
      put: op('put', 'Client', 'Update client', B, { parameters: [paramClientId] }),
      delete: op('delete', 'Client', 'Delete client', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/permissions`]: {
      get: op('get', 'Client', 'Get permissions', B, { parameters: [paramClientId] }),
      put: op('put', 'Client', 'Update permissions', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/analytics/config`]: {
      get: op('get', 'Client', 'Analytics config', B, { parameters: [paramClientId] }),
      put: op('put', 'Client', 'Update analytics config', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/analytics/performance`]: {
      get: op('get', 'Client', 'Analytics performance', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/analytics/traffic-sources`]: {
      get: op('get', 'Client', 'Traffic sources', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/analytics/dashboard`]: {
      get: op('get', 'Client', 'Analytics dashboard', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/analytics/test-connection`]: {
      post: op('post', 'Client', 'Test analytics connection', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/ad-integrations`]: {
      get: op('get', 'Client', 'Ad integrations summary', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/ad-integrations/meta`]: {
      put: op('put', 'Client', 'Update Meta ads', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/ad-integrations/google`]: {
      put: op('put', 'Client', 'Update Google ads', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/ad-integrations/tiktok`]: {
      put: op('put', 'Client', 'Update TikTok ads', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/ad-integrations/pinterest`]: {
      put: op('put', 'Client', 'Update Pinterest ads', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/ad-integrations/meta/test`]: {
      post: op('post', 'Client', 'Test Meta connection', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/ad-integrations/google/test`]: {
      post: op('post', 'Client', 'Test Google connection', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/ad-integrations/stats`]: {
      get: op('get', 'Client', 'Ad integration stats', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/ad-integrations/bulk-update`]: {
      post: op('post', 'Client', 'Bulk update ad integrations', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/tracking-settings`]: {
      put: op('put', 'Client', 'Tracking settings', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/event-logs`]: {
      get: op('get', 'Client', 'Event logs', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/{clientId}/reset-stats`]: {
      post: op('post', 'Client', 'Reset stats', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/migrate/rotate-encryption-key`]: { post: op('post', 'Client', 'Admin: rotate encryption key', B) },
    [`${a}/client/migrate/encrypt-merchant-fields`]: { post: op('post', 'Client', 'Admin: encrypt merchant fields', B) },
    [`${a}/client/migrate/switch-to-secret-encryption`]: { post: op('post', 'Client', 'Admin: switch encryption', B) },
    [`${a}/client/migrate/full-encryption-setup`]: { post: op('post', 'Client', 'Admin: full encryption setup', B) },
    [`${a}/client/debug/raw-encrypted-data`]: { get: op('get', 'Client', 'Admin: raw encrypted data', B) },
    [`${a}/client/debug/merchant-encryption-status`]: { get: op('get', 'Client', 'Admin: merchant encryption status', B) },
    [`${a}/client/debug/encryption-status`]: { get: op('get', 'Client', 'Admin: encryption status', B) },
    [`${a}/client/debug/verify-migration`]: { get: op('get', 'Client', 'Admin: verify migration', B) },
    [`${a}/client/debug/needs-encryption`]: { get: op('get', 'Client', 'Admin: needs encryption', B) },
    [`${a}/client/debug/test-old-key`]: { post: op('post', 'Client', 'Admin: test old key', B) },
    [`${a}/client/debug/decrypted-values/{clientId}`]: {
      get: op('get', 'Client', 'Admin: decrypted values', B, { parameters: [paramClientId] }),
    },
    [`${a}/client/debug/decrypt`]: { post: op('post', 'Client', 'Admin: decrypt debug', B) },
    [`${a}/client/debug/encrypt`]: { post: op('post', 'Client', 'Admin: encrypt debug', B) },
    [`${a}/client/{clientId}/test-encryption`]: {
      get: op('get', 'Client', 'Admin: test encryption for client', B, { parameters: [paramClientId] }),
    },

    [`${a}/customer`]: {
      get: op('get', 'Customer', 'List customers (Bearer: client JWT in header)', B),
      post: op('post', 'Customer', 'Create customer', B),
    },
    [`${a}/customer/login`]: {
      post: op('post', 'Customer', 'Customer login (Bearer: client JWT identifies tenant)', B, {
        responses: { 200: { description: 'OK' }, 401: { description: 'Unauthorized' } },
      }),
    },
    [`${a}/customer/verify/{token}`]: {
      post: op('post', 'Customer', 'Verify email with token in path', P, {
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    [`${a}/customer/resend-verification`]: { post: op('post', 'Customer', 'Resend verification', B) },
    [`${a}/customer/reset-password`]: {
      post: op('post', 'Customer', 'Request password reset (Bearer: client JWT)', B),
    },
    [`${a}/customer/reset-password/{token}`]: {
      post: op('post', 'Customer', 'Complete password reset', P, {
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    [`${a}/customer/get/count`]: { get: op('get', 'Customer', 'Customer count', B) },
    [`${a}/customer/{id}`]: {
      get: op('get', 'Customer', 'Get customer', B, { parameters: [paramId] }),
      put: op('put', 'Customer', 'Update customer', B, { parameters: [paramId] }),
      delete: op('delete', 'Customer', 'Delete customer', B, { parameters: [paramId] }),
    },
    [`${a}/customer/{id}/cart`]: {
      post: op('post', 'Customer', 'Add to cart', B, { parameters: [paramId] }),
      get: op('get', 'Customer', 'Get cart', B, { parameters: [paramId] }),
      delete: op('delete', 'Customer', 'Clear cart', B, { parameters: [paramId] }),
    },
    [`${a}/customer/{id}/cart/{productId}`]: {
      put: op('put', 'Customer', 'Update cart line', B, {
        parameters: [
          paramId,
          { name: 'productId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
      delete: op('delete', 'Customer', 'Remove cart line', B, {
        parameters: [
          paramId,
          { name: 'productId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
    },
    [`${a}/customer/{id}/orders`]: {
      post: op('post', 'Customer', 'Create order for customer', B, { parameters: [paramId] }),
      get: op('get', 'Customer', 'List customer orders', B, { parameters: [paramId] }),
    },
    [`${a}/customer/{id}/cart-reminder`]: { post: op('post', 'Customer', 'Cart reminder', B, { parameters: [paramId] }) },
    [`${a}/customer/{id}/send-cart-reminder`]: {
      post: op('post', 'Customer', 'Send cart reminder email', B, { parameters: [paramId] }),
    },
    [`${a}/customer/{id}/shopping-habits`]: {
      get: op('get', 'Customer', 'Shopping habits', B, { parameters: [paramId] }),
    },
    [`${a}/customer/{id}/analytics`]: { get: op('get', 'Customer', 'Customer analytics', B, { parameters: [paramId] }) },
    [`${a}/customer/analytics/behavior`]: { get: op('get', 'Customer', 'Behavior analytics', B) },
    [`${a}/customer/analytics/products/popular`]: { get: op('get', 'Customer', 'Popular products', B) },
    [`${a}/customer/analytics/purchase-patterns`]: { get: op('get', 'Customer', 'Purchase patterns', B) },
    [`${a}/customer/analytics/cart-abandonment`]: { get: op('get', 'Customer', 'Cart abandonment', B) },
    [`${a}/customer/migrate/encrypt-existing-data`]: { post: op('post', 'Customer', 'Admin: encrypt existing PII', B) },
    [`${a}/customer/debug/encryption-test/{customerId}`]: {
      get: op('get', 'Customer', 'Admin: encryption test', B, {
        parameters: [{ name: 'customerId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    [`${a}/customer/debug/decrypt`]: { post: op('post', 'Customer', 'Admin: decrypt debug', B) },
    [`${a}/customer/debug/encrypt`]: { post: op('post', 'Customer', 'Admin: encrypt debug', B) },

    [`${a}/email`]: {
      get: op(
        'get',
        'Email',
        'List threads / messages (client JWT). Syncs from IMAP into the DB on a cooldown unless `refresh=false`; `refresh=true` forces a sync. Requests that only open a thread (`threadId` set) skip IMAP unless `refresh=true` (DB-only thread load). See `EMAIL_IMAP_SYNC_COOLDOWN_MS` in `.env.example`.',
        B
      ),
      post: {
        tags: ['Email'],
        summary: 'Send / reply / reply-all / forward',
        description:
          '**send** / **forward**: `to` is required; `subject` required except when forward resolves the original by `inReplyTo` / `threadId`. **reply** / **replyAll**: omit `to` and `subject` — the server loads the original from `inReplyTo` (Mongo `_id` or Message-ID) and/or `threadId` (stored thread key, with or without `<>` brackets), then sets `To`/`Cc` and a `Re:` subject. Supply at least one of `html` or `text`. Returns 404 if the original cannot be found.',
        security: B,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/EmailSendBody' } },
          },
        },
        responses: {
          ...R.ok,
          400: { description: 'Bad request (e.g. missing body, missing `to` for send/forward, cannot resolve reply recipient)' },
          404: { description: 'Original message not found for reply / reply-all / forward' },
          500: { description: 'SMTP or server error' },
        },
      },
      put: op('put', 'Email', 'Bulk mailbox updates', B),
      delete: op('delete', 'Email', 'Trash or delete messages', B),
    },
    [`${a}/email/search`]: { get: op('get', 'Email', 'Search mailbox', B) },
    [`${a}/email/stats`]: { get: op('get', 'Email', 'Mailbox stats', B) },
    [`${a}/email/batch`]: { post: op('post', 'Email', 'Batch flag updates', B) },
    [`${a}/email/newsletter/send`]: { post: op('post', 'Email', 'Send newsletter (multipart)', B) },
    [`${a}/email/newsletter/subscribers`]: { get: op('get', 'Email', 'List newsletter subscribers', B) },
    [`${a}/email/newsletter/subscribers/bulk`]: { post: op('post', 'Email', 'Bulk subscriber action', B) },
    [`${a}/email/newsletter/subscribers/unsubscribe`]: { post: op('post', 'Email', 'Unsubscribe subscriber (dashboard)', B) },
    [`${a}/email/newsletter/subscribers/stats`]: { get: op('get', 'Email', 'Subscriber stats', B) },
    [`${a}/email/newsletter/rate-limit`]: { get: op('get', 'Email', 'Newsletter rate limit info', B) },
    [`${a}/email/newsletter/stats`]: { get: op('get', 'Email', 'Newsletter send stats', B) },
    [`${a}/email/newsletter/opens/stats`]: { get: op('get', 'Email', 'Open tracking summary', B) },
    [`${a}/email/newsletter/opens`]: { get: op('get', 'Email', 'Open tracking events', B) },
    [`${a}/email/newsletter/open.gif`]: {
      get: op('get', 'Email', 'Tracking pixel (public)', P, { responses: { 200: { description: 'GIF image' } } }),
    },
    [`${a}/email/newsletter/unsubscribe`]: {
      get: op('get', 'Email', 'One-click unsubscribe landing (public)', P, { responses: { 200: { description: 'OK' } } }),
    },
    [`${a}/email/subscribe`]: {
      post: op('post', 'Email', 'Public subscribe', P, { responses: { 201: { description: 'Created' } } }),
    },
    [`${a}/email/unsubscribe`]: {
      post: op('post', 'Email', 'Public unsubscribe', P, { responses: { 200: { description: 'OK' } } }),
    },
    [`${a}/email/subscribers/export`]: { get: op('get', 'Email', 'Export subscribers CSV', B) },
    [`${a}/email/health`]: { get: op('get', 'Email', 'Subsystem health', B) },
    [`${a}/email/contact`]: { post: op('post', 'Email', 'Contact form to business inbox', B) },
    [`${a}/email/rethread`]: { post: op('post', 'Email', 'Recalculate threads', B) },
    [`${a}/email/signature/image`]: {
      post: {
        tags: ['Email'],
        summary: 'Upload email signature image',
        description:
          'Multipart field `signature` (PNG, JPEG, GIF, or WebP; max 3MB). Saves HTML on the authenticated client profile; outbound mail merges it automatically. Query `mode=append` keeps existing HTML and adds the image below.',
        security: B,
        parameters: [
          {
            name: 'mode',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['append'] },
            description: 'Set to `append` to keep the current signature HTML and append the new image block.',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['signature'],
                properties: {
                  signature: {
                    type: 'string',
                    format: 'binary',
                    description: 'Signature image file',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Signature saved' },
          400: { description: 'Missing file or invalid type' },
          401: { description: 'Unauthorized' },
        },
      },
    },

    [`${a}/payments/payfast/itn`]: {
      post: op('post', 'Payments', 'PayFast ITN (form body; server-side validation)', P, {
        responses: { 200: { description: 'Acknowledged (empty body)' } },
      }),
    },

    [`${a}/events/health`]: { get: op('get', 'Tracking', 'Tracking DB health', B) },
    [`${a}/events/batch`]: {
      post: op('post', 'Tracking', 'Ingest tracking events', P, { responses: { 201: { description: 'Created' }, 429: { description: 'Too many requests' } } }),
    },
    [`${a}/events/convert-anonymous`]: {
      post: op('post', 'Tracking', 'Link anonymous events to customer (no express-jwt; optional client context via headers/body)', P),
    },
    [`${a}/events/stats/{clientId}`]: {
      get: op('get', 'Tracking', 'Event stats for client', B, {
        parameters: [{ name: 'clientId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    [`${a}/events/debug/queue-status`]: { get: op('get', 'Tracking', 'Queue status', B) },
    [`${a}/events/debug/test-simple/{clientId}`]: {
      post: op('post', 'Tracking', 'Debug test event', B, {
        parameters: [{ name: 'clientId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
  };
}

function spec() {
  const a = apiPath;
  return {
    openapi: '3.0.3',
    info: {
      title: 'KhanaConnect API',
      description:
        'REST API for KhanaConnect. Mount prefix is `API_URL` (default `/api/v1`). Client dashboard routes typically require a Bearer JWT from `POST .../client/login`. Storefront customer routes use a customer JWT from `POST .../customer/login`. PayFast ITN and some marketing endpoints are public. Order/booking payment callbacks optionally verify `X-Webhook-Secret` (or `X-Order-Webhook-Secret` / `X-Booking-Webhook-Secret`) only when `ORDER_PAYMENT_WEBHOOK_ENABLED` / `BOOKING_PAYMENT_WEBHOOK_ENABLED` is true and the matching `*_SECRET` is set. See `.env.example`.',
      version: process.env.npm_package_version || '0.0.0',
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Local' },
      { url: 'https://khanatechnologies.co.za', description: 'Production (example)' },
    ],
    tags: [
      { name: 'Meta', description: 'Non-API HTML' },
      { name: 'Auth', description: 'Authentication' },
      { name: 'Client', description: 'Tenant / business client profile, analytics, ads' },
      { name: 'Customer', description: 'End-customer accounts, cart, orders' },
      { name: 'Admin', description: 'Cross-tenant admin' },
      { name: 'Wishlists', description: 'Wishlists' },
      { name: 'Categories', description: 'Product categories' },
      { name: 'Products', description: 'Catalog' },
      { name: 'Sizes', description: 'Product sizes' },
      { name: 'Product sales', description: 'Sales records' },
      { name: 'Discount codes', description: 'Checkout and verify' },
      { name: 'Orders', description: 'Orders and webhooks' },
      { name: 'Bookings', description: 'Scheduling, waitlist, availability' },
      { name: 'Staff', description: 'Staff' },
      { name: 'Services', description: 'Bookable services' },
      { name: 'Resources', description: 'Bookable resources' },
      { name: 'Email subscriptions', description: 'Legacy emailsub routes' },
      { name: 'Email', description: 'IMAP-backed mailbox and newsletters' },
      { name: 'Payments', description: 'Gateways' },
      { name: 'Tracking', description: 'Event ingestion and stats' },
      { name: 'Analytics', description: 'Reporting' },
      { name: 'Preorder pledge', description: 'Campaign pledges' },
      { name: 'Campaigns', description: 'Marketing / signup campaigns' },
      { name: 'Voting campaigns', description: 'Contests and public voting' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'HS256 JWT with clientID (dashboard / most APIs).',
        },
        customerBearer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'HS256 JWT including customerID (storefront voting routes).',
        },
        webhookSecret: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Webhook-Secret',
          description:
            'Required only when the matching *_WEBHOOK_ENABLED env is true. Also accepted: X-Order-Webhook-Secret (orders), X-Booking-Webhook-Secret (bookings).',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: false },
            message: { type: 'string' },
            error: { type: 'string' },
          },
        },
        EmailSendBody: {
          type: 'object',
          description:
            'Unified outbound mail body. For **reply** and **replyAll**, leave `to` and `subject` empty; set `action` and identify the parent with `inReplyTo` and/or `threadId` (thread id often matches a root Message-ID — bracketed and unbracketed forms are accepted).',
          properties: {
            to: {
              type: 'string',
              description:
                'Recipients (comma-separated). **Required** for `send` and `forward`. **Omit** for `reply` / `replyAll` (filled from the original `From` / participants).',
            },
            subject: {
              type: 'string',
              description:
                '**Required** for `send`. **Omit** for `reply` / `replyAll` (server builds `Re: …`). For `forward`, optional if the original is found via `inReplyTo` / `threadId`.',
            },
            html: { type: 'string', description: 'HTML body; at least one of `html` or `text` required.' },
            text: { type: 'string', description: 'Plain-text body; at least one of `html` or `text` required.' },
            cc: { type: 'string' },
            bcc: { type: 'string' },
            action: {
              type: 'string',
              enum: ['send', 'reply', 'replyAll', 'forward'],
              default: 'send',
              description: '`reply` / `replyAll` resolve `to`, `subject`, threading headers from the stored original.',
            },
            inReplyTo: {
              type: 'string',
              description: 'Parent message: Mongo `_id` or Message-ID (`<id@host>` or bare `id@host`).',
            },
            threadId: {
              type: 'string',
              description:
                'Conversation key from `GET .../email` (same as stored `threadId`; may be Message-ID with or without angle brackets).',
            },
            references: {
              oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
              description: 'Optional; server extends from the original on reply.',
            },
            attachments: {
              type: 'array',
              items: {
                type: 'object',
                required: ['filename', 'content'],
                properties: {
                  filename: { type: 'string' },
                  content: { type: 'string', format: 'byte', description: 'Base64' },
                  contentType: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    paths: buildPaths(a),
  };
}

module.exports = { spec, apiPath };
