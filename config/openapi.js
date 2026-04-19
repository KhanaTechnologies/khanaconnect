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

const B = [{ bearerAuth: [] }];
const C = [{ customerBearer: [] }];
const P = [];
const paramId = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const paramClientId = { name: 'clientId', in: 'path', required: true, schema: { type: 'string' } };
const paramListId = { name: 'listId', in: 'path', required: true, schema: { type: 'string' } };
const paramItemId = { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } };

function schemaRef(name) {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonResponse(schemaName, description = 'OK') {
  return {
    description,
    content: { 'application/json': { schema: schemaRef(schemaName) } },
  };
}

function jsonErr(description) {
  return {
    description,
    content: { 'application/json': { schema: schemaRef('Error') } },
  };
}

/** Common JSON response shorthands (merge into operation `responses`). */
const J = {
  ok: jsonResponse('FlexibleJson', 'OK'),
  created: jsonResponse('FlexibleJson', 'Created'),
  badRequest: jsonErr('Bad request'),
  unauthorized: jsonErr('Unauthorized'),
  forbidden: jsonErr('Forbidden'),
  notFound: jsonErr('Not found'),
  serverError: jsonErr('Internal server error'),
};

const R = {
  ok: {
    200: J.ok,
    401: J.unauthorized,
    403: J.forbidden,
  },
};

function op(method, tag, summary, security, extra = {}) {
  const { responses: extraResponses, ...rest } = extra;
  return {
    tags: [tag],
    summary,
    security,
    responses: extraResponses ? { ...R.ok, ...extraResponses } : { ...R.ok },
    ...rest,
  };
}

const jsonBody = (schemaName, description) => ({
  requestBody: {
    required: true,
    description,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } },
  },
});

function crudResource(basePath, tag, name, security = B, createSchemaName, updateSchemaName, listSchemaName, itemSchemaName) {
  const idPath = `${basePath}/{id}`;
  const createRef = createSchemaName;
  const updateRef = updateSchemaName || createSchemaName;
  const listS = listSchemaName || 'FlexibleJson';
  const itemS = itemSchemaName || 'FlexibleJson';
  const mutateCreate = {
    requestBody: {
      required: true,
      description: `JSON body to create ${name}.`,
      content: {
        'application/json': { schema: { $ref: `#/components/schemas/${createRef}` } },
      },
    },
  };
  const mutateUpdate = {
    requestBody: {
      required: false,
      description: `JSON body to partially update ${name}.`,
      content: {
        'application/json': { schema: { $ref: `#/components/schemas/${updateRef}` } },
      },
    },
  };
  return {
    [basePath]: {
      get: op('get', tag, `List ${name}`, security, {
        description: `List ${name} for the tenant. Filtering, sorting, and pagination depend on the route implementation.`,
        responses: { 200: jsonResponse(listS, `List of ${name}`) },
      }),
      post: op('post', tag, `Create ${name}`, security, {
        ...mutateCreate,
        description: `Create ${name}.`,
        responses: { 201: jsonResponse(itemS, 'Created'), 400: J.badRequest },
      }),
    },
    [idPath]: {
      get: op('get', tag, `Get ${name} by id`, security, {
        parameters: [paramId],
        responses: { 200: jsonResponse(itemS), 404: J.notFound },
      }),
      put: op('put', tag, `Update ${name}`, security, {
        parameters: [paramId],
        ...mutateUpdate,
        responses: { 200: jsonResponse(itemS), 404: J.notFound },
      }),
      delete: op('delete', tag, `Delete ${name}`, security, {
        parameters: [paramId],
        responses: { 200: jsonResponse('SuccessMessage', 'Deleted'), 404: J.notFound },
      }),
    },
  };
}

/** List + create + update-by-id + delete-by-id only (no `GET /{id}`) — matches `routes/resources.js`. */
function crudResourceNoGetById(basePath, tag, name, security = B, createSchemaName, updateSchemaName, listSchemaName, itemSchemaName) {
  const idPath = `${basePath}/{id}`;
  const createRef = createSchemaName;
  const updateRef = updateSchemaName || createSchemaName;
  const listS = listSchemaName || 'FlexibleJson';
  const itemS = itemSchemaName || 'FlexibleJson';
  const mutateCreate = {
    requestBody: {
      required: true,
      description: `JSON body to create ${name}.`,
      content: {
        'application/json': { schema: { $ref: `#/components/schemas/${createRef}` } },
      },
    },
  };
  const mutateUpdate = {
    requestBody: {
      required: false,
      description: `JSON body to partially update ${name}.`,
      content: {
        'application/json': { schema: { $ref: `#/components/schemas/${updateRef}` } },
      },
    },
  };
  return {
    [basePath]: {
      get: op('get', tag, `List ${name}`, security, {
        description: `List ${name} for the tenant.`,
        responses: { 200: jsonResponse(listS, `List of ${name}`) },
      }),
      post: op('post', tag, `Create ${name}`, security, {
        ...mutateCreate,
        description: `Create ${name}.`,
        responses: { 201: jsonResponse(itemS, 'Created'), 400: J.badRequest },
      }),
    },
    [idPath]: {
      put: op('put', tag, `Update ${name}`, security, {
        parameters: [paramId],
        ...mutateUpdate,
        responses: { 200: jsonResponse(itemS), 404: J.notFound },
      }),
      delete: op('delete', tag, `Delete ${name}`, security, {
        parameters: [paramId],
        responses: { 200: jsonResponse('SuccessMessage', 'Deleted'), 404: J.notFound },
      }),
    },
  };
}

/** Full OpenAPI operations for `/client` (tenant profile, analytics, ads, migrations). */
function buildClientPaths(a, B, P, paramClientId) {
  return {
    [`${a}/client`]: {
      get: {
        tags: ['Client'],
        summary: 'List clients',
        description:
          'Returns every client document (password/token/sessionToken stripped). JWT is not required for GET in current `express-jwt` config; restrict at the edge in production if needed.',
        security: P,
        responses: {
          200: {
            description: 'Success',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientListResponse' } } },
          },
        },
      },
      post: {
        tags: ['Client'],
        summary: 'Register / onboard client',
        description:
          'Creates a tenant. Hashes `password`, generates internal `token`, initializes ad/tracking defaults. Response includes JWT-capable `token` payload field (separate from session).',
        security: P,
        ...jsonBody('ClientRegisterBody', 'Onboarding payload'),
        responses: {
          200: {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientRegisterResponse' } } },
          },
          400: J.badRequest,
        },
      },
    },
    [`${a}/client/login`]: {
      post: {
        tags: ['Client'],
        summary: 'Client login',
        description:
          'Authenticates with `clientID` + `password`. Returns HS256 JWT (`expiresIn: 1d`) and sets `sessionToken` / `isLoggedIn` on the client record.',
        security: P,
        ...jsonBody('ClientLoginBody', 'Credentials'),
        responses: {
          200: {
            description: 'Authenticated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientLoginResponse' } } },
          },
          400: J.badRequest,
        },
      },
    },
    [`${a}/client/logout`]: {
      post: {
        tags: ['Client'],
        summary: 'Logout',
        description: 'Clears `sessionToken`, `sessionExpires`, `isLoggedIn`. Requires `Authorization: Bearer <JWT>`.',
        security: B,
        responses: {
          200: {
            description: 'Logged out',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientLogoutResponse' } } },
          },
          400: J.badRequest,
        },
      },
    },
    [`${a}/client/{clientId}`]: {
      get: {
        tags: ['Client'],
        summary: 'Get client by clientID',
        description: 'Returns full client document minus `password`, `token`, `sessionToken`.',
        security: B,
        parameters: [paramClientId],
        responses: {
          200: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientSingleResponse' } } },
          },
          404: J.notFound,
        },
      },
      put: {
        tags: ['Client'],
        summary: 'Update client',
        description:
          'Partial update via `$set`. Cannot change `clientID`, `token`, or `sessionToken`. Hashes `password` if provided.',
        security: B,
        parameters: [paramClientId],
        ...jsonBody('ClientUpdateBody', 'Any mutable Client fields'),
        responses: {
          200: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientUpdateResponse' } } },
          },
          404: J.notFound,
        },
      },
      delete: {
        tags: ['Client'],
        summary: 'Delete client',
        security: B,
        parameters: [paramClientId],
        responses: {
          200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientDeleteResponse' } } } },
          404: J.notFound,
        },
      },
    },
    [`${a}/client/{clientId}/permissions`]: {
      get: {
        tags: ['Client'],
        summary: 'Get permissions and role',
        security: B,
        parameters: [paramClientId],
        responses: {
          200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientPermissionsGetResponse' } } } },
          404: J.notFound,
        },
      },
      put: {
        tags: ['Client'],
        summary: 'Replace permissions object',
        security: B,
        parameters: [paramClientId],
        ...jsonBody('ClientPermissionsBody', 'Wrapper with `permissions` key'),
        responses: {
          200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientPermissionsPutResponse' } } } },
          404: J.notFound,
        },
      },
    },
    [`${a}/client/{clientId}/analytics/config`]: {
      get: {
        tags: ['Client'],
        summary: 'Get GA4 / analytics config',
        security: B,
        parameters: [paramClientId],
        responses: {
          200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientAnalyticsConfigResponse' } } } },
          404: J.notFound,
        },
      },
      put: {
        tags: ['Client'],
        summary: 'Update analytics config',
        description: 'Sets `analyticsConfig.googleAnalytics` and mirrors `propertyId` to legacy `ga4PropertyId`.',
        security: B,
        parameters: [paramClientId],
        ...jsonBody('ClientAnalyticsConfigPutBody', 'Must include `googleAnalytics` object'),
        responses: {
          200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientAnalyticsConfigPutResponse' } } } },
          404: J.notFound,
        },
      },
    },
    [`${a}/client/{clientId}/analytics/performance`]: {
      get: {
        tags: ['Client'],
        summary: 'GA performance report',
        description: 'Requires dashboard permission `analytics`. Query: `startDate`, `endDate` (GA date strings, default `7daysAgo` / `today`).',
        security: B,
        parameters: [
          paramClientId,
          { name: 'startDate', in: 'query', schema: { type: 'string', default: '7daysAgo' } },
          { name: 'endDate', in: 'query', schema: { type: 'string', default: 'today' } },
        ],
        responses: {
          200: {
            description: '{ success, period, performance }',
            content: { 'application/json': { schema: schemaRef('FlexibleJson') } },
          },
          400: J.badRequest,
          403: J.forbidden,
        },
      },
    },
    [`${a}/client/{clientId}/analytics/traffic-sources`]: {
      get: {
        tags: ['Client'],
        summary: 'GA traffic sources',
        security: B,
        parameters: [
          paramClientId,
          { name: 'startDate', in: 'query', schema: { type: 'string', default: '7daysAgo' } },
          { name: 'endDate', in: 'query', schema: { type: 'string', default: 'today' } },
        ],
        responses: {
          200: {
            description: '{ success, period, traffic }',
            content: { 'application/json': { schema: schemaRef('FlexibleJson') } },
          },
          400: J.badRequest,
          403: J.forbidden,
        },
      },
    },
    [`${a}/client/{clientId}/analytics/dashboard`]: {
      get: {
        tags: ['Client'],
        summary: 'Analytics dashboard bundle',
        description: 'Requires `view` dashboard permission; embeds performance/traffic only if `sales` permission and GA enabled.',
        security: B,
        parameters: [
          paramClientId,
          { name: 'startDate', in: 'query', schema: { type: 'string', default: '7daysAgo' } },
          { name: 'endDate', in: 'query', schema: { type: 'string', default: 'today' } },
        ],
        responses: {
          200: {
            description: '{ success, dashboard }',
            content: { 'application/json': { schema: schemaRef('FlexibleJson') } },
          },
          404: J.notFound,
          500: J.serverError,
        },
      },
    },
    [`${a}/client/{clientId}/analytics/test-connection`]: {
      post: {
        tags: ['Client'],
        summary: 'Test GA4 Data API connection',
        description: 'Uses service credentials; returns sample session row when data exists.',
        security: B,
        parameters: [paramClientId],
        responses: { 200: J.ok, 400: J.badRequest, 404: J.notFound },
      },
    },
    [`${a}/client/{clientId}/ad-integrations`]: {
      get: {
        tags: ['Client'],
        summary: 'Ad platforms + tracking settings',
        description:
          'Returns `metaAds` (pixel, tokens, **adAccountId**, **campaigns[]**, ownership fields), `googleAds`, `tiktokAds`, `pinterestAds`, `trackingSettings`, `trackingStats`. Secrets may be decrypted by Mongoose getters.',
        security: B,
        parameters: [paramClientId],
        responses: {
          200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ClientAdIntegrationsResponse' } } } },
          404: J.notFound,
        },
      },
    },
    [`${a}/client/{clientId}/ad-integrations/meta`]: {
      put: {
        tags: ['Client'],
        summary: 'Update Meta (Facebook) ads / pixel',
        description:
          'Validates pixel when `enabled` and credentials present. Sets **adAccountId** (no `act_` prefix), **ownershipType**, **metaBusinessId**, **partnerRequestId** for Marketing API integrations.',
        security: B,
        parameters: [paramClientId],
        ...jsonBody('ClientMetaAdsPutBody', 'Meta ads configuration'),
        responses: {
          200: {
            description: '{ success, message, metaAds }',
            content: { 'application/json': { schema: schemaRef('FlexibleJson') } },
          },
          404: J.notFound,
        },
      },
    },
    [`${a}/client/{clientId}/ad-integrations/google`]: {
      put: {
        tags: ['Client'],
        summary: 'Update Google Ads conversion tracking',
        security: B,
        parameters: [paramClientId],
        ...jsonBody('ClientGoogleAdsPutBody', 'Google Ads configuration'),
        responses: { 200: J.ok, 404: J.notFound },
      },
    },
    [`${a}/client/{clientId}/ad-integrations/tiktok`]: {
      put: {
        tags: ['Client'],
        summary: 'Update TikTok Ads',
        security: B,
        parameters: [paramClientId],
        ...jsonBody('ClientTikTokAdsPutBody', 'TikTok pixel + token'),
        responses: { 200: J.ok, 404: J.notFound },
      },
    },
    [`${a}/client/{clientId}/ad-integrations/pinterest`]: {
      put: {
        tags: ['Client'],
        summary: 'Update Pinterest Ads',
        security: B,
        parameters: [paramClientId],
        ...jsonBody('ClientPinterestAdsPutBody', 'Pinterest ad account + token'),
        responses: { 200: J.ok, 404: J.notFound },
      },
    },
    [`${a}/client/{clientId}/ad-integrations/meta/test`]: {
      post: {
        tags: ['Client'],
        summary: 'Test Meta pixel + token',
        security: B,
        parameters: [paramClientId],
        ...jsonBody('ClientMetaTestBody', '`pixelId` + `accessToken` required'),
        responses: { 200: J.ok, 400: J.badRequest, 500: J.serverError },
      },
    },
    [`${a}/client/{clientId}/ad-integrations/google/test`]: {
      post: {
        tags: ['Client'],
        summary: 'Test Google conversion tag',
        security: B,
        parameters: [paramClientId],
        ...jsonBody('ClientGoogleTestBody', '`conversionId` required; `apiKey` optional'),
        responses: { 200: J.ok, 400: J.badRequest, 500: J.serverError },
      },
    },
    [`${a}/client/{clientId}/ad-integrations/stats`]: {
      get: {
        tags: ['Client'],
        summary: 'Tracking + platform health stats',
        description: 'Aggregates `TrackingEvent` over 7 days plus `platformStats` for Meta/Google.',
        security: B,
        parameters: [paramClientId],
        responses: { 200: J.ok, 404: J.notFound },
      },
    },
    [`${a}/client/{clientId}/ad-integrations/bulk-update`]: {
      post: {
        tags: ['Client'],
        summary: 'Enable/disable Meta & Google flags',
        security: B,
        parameters: [paramClientId],
        ...jsonBody('ClientAdBulkUpdateBody', '`platforms`: { meta?, google? }'),
        responses: { 200: J.ok, 400: J.badRequest, 404: J.notFound },
      },
    },
    [`${a}/client/{clientId}/tracking-settings`]: {
      put: {
        tags: ['Client'],
        summary: 'Batch size, retries, event types',
        security: B,
        parameters: [paramClientId],
        ...jsonBody('ClientTrackingSettingsPutBody', 'Partial `trackingSettings` fields'),
        responses: { 200: J.ok, 400: J.badRequest, 404: J.notFound },
      },
    },
    [`${a}/client/{clientId}/event-logs`]: {
      get: {
        tags: ['Client'],
        summary: 'Paged tracking event delivery log',
        description:
          'Query: `limit` (default 100), `page`, `status` (deliveryStatus), `eventType`, `startDate`, `endDate` (ISO).',
        security: B,
        parameters: [
          paramClientId,
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'eventType', in: 'query', schema: { type: 'string' } },
          { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: {
          200: {
            description: '{ success, events, pagination }',
            content: { 'application/json': { schema: schemaRef('FlexibleJson') } },
          },
        },
      },
    },
    [`${a}/client/{clientId}/reset-stats`]: {
      post: {
        tags: ['Client'],
        summary: 'Reset tracking counters',
        description: 'Caller JWT must resolve to a client with `role: admin`.',
        security: B,
        parameters: [paramClientId],
        responses: { 200: J.ok, 403: J.forbidden, 404: J.notFound },
      },
    },
    [`${a}/client/migrate/rotate-encryption-key`]: {
      post: {
        tags: ['Client'],
        summary: '[Admin] Rotate ENCRYPTION_KEY',
        security: B,
        responses: { 200: J.ok, 401: J.unauthorized, 403: J.forbidden },
      },
    },
    [`${a}/client/migrate/encrypt-merchant-fields`]: {
      post: { tags: ['Client'], summary: '[Admin] Encrypt merchant fields', security: B, responses: { 200: J.ok } },
    },
    [`${a}/client/migrate/switch-to-secret-encryption`]: {
      post: { tags: ['Client'], summary: '[Admin] Encryption migration', security: B, responses: { 200: J.ok } },
    },
    [`${a}/client/migrate/full-encryption-setup`]: {
      post: { tags: ['Client'], summary: '[Admin] Full encryption setup', security: B, responses: { 200: J.ok } },
    },
    [`${a}/client/debug/raw-encrypted-data`]: {
      get: { tags: ['Client'], summary: '[Admin] Raw ciphertext dump', security: B, responses: { 200: J.ok } },
    },
    [`${a}/client/debug/merchant-encryption-status`]: {
      get: { tags: ['Client'], summary: '[Admin] Merchant field status', security: B, responses: { 200: J.ok } },
    },
    [`${a}/client/debug/encryption-status`]: {
      get: { tags: ['Client'], summary: '[Admin] Encryption status', security: B, responses: { 200: J.ok } },
    },
    [`${a}/client/debug/verify-migration`]: {
      get: { tags: ['Client'], summary: '[Admin] Verify migration', security: B, responses: { 200: J.ok } },
    },
    [`${a}/client/debug/needs-encryption`]: {
      get: { tags: ['Client'], summary: '[Admin] Rows needing encryption', security: B, responses: { 200: J.ok } },
    },
    [`${a}/client/debug/test-old-key`]: {
      post: { tags: ['Client'], summary: '[Admin] Test legacy key', security: B, responses: { 200: J.ok } },
    },
    [`${a}/client/debug/decrypted-values/{clientId}`]: {
      get: {
        tags: ['Client'],
        summary: '[Admin] Inspect decrypted fields for one client',
        security: B,
        parameters: [paramClientId],
        responses: { 200: J.ok, 404: J.notFound },
      },
    },
    [`${a}/client/debug/decrypt`]: {
      post: {
        tags: ['Client'],
        summary: '[Admin] Decrypt arbitrary ciphertext',
        security: B,
        ...jsonBody('ClientDebugDecryptBody', ''),
        responses: { 200: J.ok, 400: J.badRequest },
      },
    },
    [`${a}/client/debug/encrypt`]: {
      post: {
        tags: ['Client'],
        summary: '[Admin] Encrypt arbitrary plaintext',
        security: B,
        ...jsonBody('ClientDebugEncryptBody', ''),
        responses: { 200: J.ok, 400: J.badRequest },
      },
    },
    [`${a}/client/{clientId}/test-encryption`]: {
      get: {
        tags: ['Client'],
        summary: '[Admin] Compare raw vs decrypted field values',
        security: B,
        parameters: [paramClientId],
        responses: { 200: J.ok, 404: J.notFound },
      },
    },
  };
}

function buildPaths(a) {
  return {
    '/': {
      get: op('get', 'Meta', 'HTML home (Express view)', P, {
        responses: {
          200: {
            description: 'HTML document',
            content: { 'text/html': { schema: { type: 'string', example: '<!DOCTYPE html><html>…</html>' } } },
          },
        },
      }),
    },

    [`${a}/wishlists/stats`]: {
      get: {
        tags: ['Wishlists'],
        summary: 'Merchant: wishlist popularity (aggregated)',
        description:
          '**Client dashboard JWT** (`Bearer` with `clientID` — same as `/client` routes). Returns products ranked by how often they appear on wish lists (lines + optional variant). Includes aggregate counts only — **no customer names or IDs**. Use `order=asc` for least-saved first. Product details are omitted if the SKU was deleted.',
        security: B,
        parameters: [
          {
            name: 'order',
            in: 'query',
            schema: { type: 'string', enum: ['desc', 'asc'], default: 'desc' },
            description: '`desc` = most saved first (default); `asc` = least saved first.',
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 50, minimum: 1, maximum: 200 },
          },
          {
            name: 'minSaves',
            in: 'query',
            schema: { type: 'integer', default: 1, minimum: 0 },
            description: 'Only include product+variant rows with at least this many wish list lines.',
          },
        ],
        responses: {
          200: jsonResponse('WishlistMerchantStatsResponse', 'Ranked aggregates'),
          401: J.unauthorized,
          403: J.forbidden,
        },
      },
    },
    [`${a}/wishlists`]: {
      get: {
        tags: ['Wishlists'],
        summary: 'List my wish list groups',
        description:
          'Requires **customerBearer** JWT (`POST /customer/login`). If you have no lists yet, the server creates a default group **My wish list** before returning. Each group can hold multiple products with optional sale/restock email alerts.',
        security: C,
        responses: {
          200: jsonResponse('WishlistsListResponse', 'Wish list groups for the logged-in customer'),
          401: J.unauthorized,
          403: J.forbidden,
        },
      },
      post: {
        tags: ['Wishlists'],
        summary: 'Create a wish list group',
        security: C,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/WishlistGroupCreateBody' } } },
        },
        responses: {
          201: jsonResponse('WishlistGroupDocument', 'Created list document'),
          400: J.badRequest,
          401: J.unauthorized,
          403: J.forbidden,
        },
      },
    },
    [`${a}/wishlists/{listId}`]: {
      get: {
        tags: ['Wishlists'],
        summary: 'Get one group with populated products',
        security: C,
        parameters: [paramListId],
        responses: {
          200: jsonResponse('WishlistGroupDetailResponse'),
          404: J.notFound,
          401: J.unauthorized,
          403: J.forbidden,
        },
      },
      put: {
        tags: ['Wishlists'],
        summary: 'Update group name / description',
        security: C,
        parameters: [paramListId],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/WishlistGroupUpdateBody' } } },
        },
        responses: {
          200: jsonResponse('WishlistGroupMutationResponse'),
          404: J.notFound,
          401: J.unauthorized,
          403: J.forbidden,
        },
      },
      delete: {
        tags: ['Wishlists'],
        summary: 'Delete group',
        security: C,
        parameters: [paramListId],
        responses: {
          200: jsonResponse('SuccessMessage'),
          404: J.notFound,
          401: J.unauthorized,
          403: J.forbidden,
        },
      },
    },
    [`${a}/wishlists/{listId}/items`]: {
      post: {
        tags: ['Wishlists'],
        summary: 'Add or merge a product line',
        description:
          'Same product + variant twice updates quantity/toggles. Alerts compare price/sale % and stock vs last snapshot when merchants edit products or stock changes.',
        security: C,
        parameters: [paramListId],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/WishlistItemAddBody' } } },
        },
        responses: {
          201: jsonResponse('WishlistItemMutationResponse', 'New line added'),
          200: jsonResponse('WishlistItemMutationResponse', 'Merged existing line (`updated: true`)'),
          400: J.badRequest,
          404: J.notFound,
          401: J.unauthorized,
          403: J.forbidden,
        },
      },
    },
    [`${a}/wishlists/{listId}/items/{itemId}`]: {
      patch: {
        tags: ['Wishlists'],
        summary: 'Update line (quantity, notes, notify toggles)',
        security: C,
        parameters: [paramListId, paramItemId],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/WishlistItemPatchBody' } } },
        },
        responses: {
          200: jsonResponse('WishlistGroupMutationResponse'),
          404: J.notFound,
          401: J.unauthorized,
          403: J.forbidden,
        },
      },
      delete: {
        tags: ['Wishlists'],
        summary: 'Remove a line',
        security: C,
        parameters: [paramListId, paramItemId],
        responses: {
          200: jsonResponse('WishlistGroupMutationResponse'),
          404: J.notFound,
          401: J.unauthorized,
          403: J.forbidden,
        },
      },
    },
    [`${a}/service-wishlist`]: {
      get: {
        tags: ['Service wishlist'],
        summary: 'List my service wish list reminders',
        description:
          'Requires **customerBearer** JWT (`POST /customer/login`). Each row is a service plus a calendar month/year; on the **1st of that month** the server emails a reminder (tenant SMTP) so the customer can book.',
        security: C,
        responses: {
          200: jsonResponse('ServiceWishlistListResponse'),
          401: J.unauthorized,
          403: J.forbidden,
        },
      },
      post: {
        tags: ['Service wishlist'],
        summary: 'Add a service + reminder month',
        description:
          'One reminder per (service, month, year) per customer. Cron default: **08:00 on day 1** each month (`SERVICE_WISHLIST_REMINDER_CRON`, optional `TZ`).',
        security: C,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ServiceWishlistCreateBody' } } },
        },
        responses: {
          201: jsonResponse('ServiceWishlistItemResponse', 'Created'),
          400: J.badRequest,
          404: J.notFound,
          409: jsonErr('Duplicate service for that month'),
          401: J.unauthorized,
          403: J.forbidden,
        },
      },
    },
    [`${a}/service-wishlist/{id}`]: {
      patch: {
        tags: ['Service wishlist'],
        summary: 'Update reminder month or notes',
        security: C,
        parameters: [paramId],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ServiceWishlistPatchBody' } } },
        },
        responses: {
          200: jsonResponse('ServiceWishlistItemResponse'),
          400: J.badRequest,
          404: J.notFound,
          409: jsonErr('Duplicate'),
          401: J.unauthorized,
          403: J.forbidden,
        },
      },
      delete: {
        tags: ['Service wishlist'],
        summary: 'Remove a reminder',
        security: C,
        parameters: [paramId],
        responses: {
          200: jsonResponse('FlexibleJson', 'Deleted'),
          404: J.notFound,
          401: J.unauthorized,
          403: J.forbidden,
        },
      },
    },
    [`${a}/categories`]: {
      get: op('get', 'Categories', 'List categories', B, {
        description: 'All categories for the tenant.',
        responses: { 200: jsonResponse('CategoryListResponse') },
      }),
      post: op('post', 'Categories', 'Create category', B, {
        description:
          '`multipart/form-data`: `name` required; optional `image` file (PNG/JPEG), plus text fields `icon`, `color`.',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: { $ref: '#/components/schemas/CategoryMultipartCreateBody' },
            },
          },
        },
        responses: { 201: jsonResponse('CategoryDocument', 'Created'), 400: J.badRequest },
      }),
    },
    [`${a}/categories/{id}`]: {
      get: op('get', 'Categories', 'Get category by id', B, {
        parameters: [paramId],
        responses: { 200: jsonResponse('CategoryDocument'), 404: J.notFound },
      }),
      put: op('put', 'Categories', 'Update category', B, {
        parameters: [paramId],
        description: 'Send at least one of `image`, `name`, `icon`, or `color` (matches route validation).',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: { $ref: '#/components/schemas/CategoryMultipartUpdateBody' },
            },
          },
        },
        responses: { 200: jsonResponse('CategoryDocument'), 400: J.badRequest, 404: J.notFound },
      }),
      delete: op('delete', 'Categories', 'Delete category', B, {
        parameters: [paramId],
        responses: { 200: jsonResponse('SuccessMessage'), 404: J.notFound },
      }),
    },
    ...crudResource(`${a}/size`, 'Sizes', 'size', B, 'SizeCreateBody', 'SizeUpdateBody', 'SizeListResponse', 'SizeDocument'),
    ...crudResource(`${a}/staff`, 'Staff', 'staff member', B, 'StaffCreateBody', 'StaffUpdateBody', 'StaffListResponse', 'StaffDocument'),
    ...crudResource(`${a}/services`, 'Services', 'service', B, 'ServiceCreateBody', 'ServiceUpdateBody', 'ServiceListResponse', 'ServiceDocument'),
    ...crudResourceNoGetById(
      `${a}/resources`,
      'Resources',
      'resource',
      B,
      'ResourceCreateBody',
      'ResourceUpdateBody',
      'ResourceListResponse',
      'ResourceDocument'
    ),

    [`${a}/emailsub/subscribe`]: { post: op('post', 'Email subscriptions', 'Subscribe (Bearer: client JWT)', B) },
    [`${a}/emailsub/unsubscribe`]: { post: op('post', 'Email subscriptions', 'Unsubscribe (Bearer: client JWT)', B) },
    [`${a}/emailsub/export`]: { get: op('get', 'Email subscriptions', 'Export subscribers CSV', B) },

    [`${a}/products`]: {
      get: op('get', 'Products', 'List products', B, {
        description: 'Supports query filters per implementation (category, client scope, etc.).',
        responses: { 200: jsonResponse('ProductListResponse') },
      }),
      post: op('post', 'Products', 'Create product', B, {
        description:
          '`multipart/form-data` only. Required text fields: `productName`, `price`, `category` (Mongo id), `countInStock`. At least one `images` file (field repeated up to 5 times). Optional: `description`, `richDescription`, `brand`, `ingredients`, `usage`, `variants` as a JSON string per route parser.',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: { $ref: '#/components/schemas/ProductMultipartCreateBody' },
            },
          },
        },
        responses: { 200: jsonResponse('ProductDocument', 'Created (handler returns saved product)'), 400: J.badRequest },
      }),
    },
    [`${a}/products/get/featured/{count}`]: {
      get: op('get', 'Products', 'Featured products', B, {
        parameters: [{ name: 'count', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: jsonResponse('ProductListResponse') },
      }),
    },
    [`${a}/products/{id}`]: {
      get: op('get', 'Products', 'Get product by id', B, {
        parameters: [paramId],
        responses: { 200: jsonResponse('ProductDocument'), 404: J.notFound },
      }),
      put: {
        tags: ['Products'],
        summary: 'Update product',
        description:
          '`multipart/form-data`: text fields (`productName`, `price`, `category`, `countInStock`, …) plus `images` files (up to 5). `variants` and `deletedImages` may be JSON strings. Validated by express-validator.',
        security: B,
        parameters: [paramId],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: { $ref: '#/components/schemas/ProductMultipartUpdateBody' },
            },
          },
        },
        responses: {
          200: jsonResponse('ProductDocument'),
          400: J.badRequest,
          404: J.notFound,
          401: J.unauthorized,
          403: J.forbidden,
        },
      },
      delete: op('delete', 'Products', 'Delete product', B, {
        parameters: [paramId],
        responses: { 200: jsonResponse('SuccessMessage'), 404: J.notFound },
      }),
    },

    [`${a}/productsales`]: {
      get: op('get', 'Product sales', 'List product sales', B, {
        responses: { 200: jsonResponse('SalesItemListResponse') },
      }),
      post: op('post', 'Product sales', 'Create product sale', B, {
        ...jsonBody('ProductSaleCreateBody', 'Sets `salePercentage` on the given products for the date window'),
        responses: { 201: jsonResponse('SalesItemDocument', 'Created'), 400: J.badRequest },
      }),
    },
    [`${a}/productsales/{id}`]: {
      delete: op('delete', 'Product sales', 'Delete product sale', B, {
        parameters: [paramId],
        responses: { 200: jsonResponse('SuccessMessage'), 404: J.notFound },
      }),
    },

    [`${a}/discountcode/verify-discount-code`]: {
      post: op('post', 'Discount codes', 'Verify discount code for cart', B, {
        ...jsonBody('DiscountVerifyBody', 'Discount code string plus cart product ids'),
        responses: { 200: jsonResponse('DiscountVerifyResponse'), 400: J.badRequest, 404: J.notFound },
      }),
    },
    [`${a}/discountcode/createCheckoutCode`]: {
      post: op('post', 'Discount codes', 'Create checkout code', B, {
        ...jsonBody('DiscountCheckoutCodeCreateBody', 'New code, percentage, scope, and product ids'),
        responses: { 201: jsonResponse('DiscountCheckoutCreateResponse'), 400: J.badRequest },
      }),
    },
    [`${a}/discountcode/checkout-codes`]: {
      get: op('get', 'Discount codes', 'List checkout codes', B, {
        responses: { 200: jsonResponse('DiscountCodeListResponse'), 404: J.notFound },
      }),
    },
    [`${a}/discountcode/checkout-codes/{id}`]: {
      put: op('put', 'Discount codes', 'Update checkout code', B, {
        parameters: [paramId],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/DiscountCheckoutCodeUpdateBody' } },
          },
        },
        responses: { 200: jsonResponse('DiscountCodeDocument'), 404: J.notFound },
      }),
      delete: op('delete', 'Discount codes', 'Delete checkout code', B, {
        parameters: [paramId],
        responses: { 200: jsonResponse('SuccessMessage'), 404: J.notFound },
      }),
    },

    [`${a}/orders`]: {
      get: op('get', 'Orders', 'List orders (client JWT)', B, {
        description: 'Tenant-scoped via JWT `clientId` / `clientID` claim.',
        responses: { 200: jsonResponse('OrderListResponse') },
      }),
      post: op('post', 'Orders', 'Create order', B, {
        description:
          'Creates `OrderItem` subdocuments, decrements stock, sends confirmation email when SMTP configured. Validates customer belongs to tenant.',
        ...jsonBody('OrderCreateBody', 'express-validator: orderItems[], address, postalCode, phone, customer'),
        responses: {
          201: jsonResponse('OrderDocument', 'Created order'),
          400: J.badRequest,
          404: J.notFound,
        },
      }),
    },
    [`${a}/orders/{id}`]: {
      get: op('get', 'Orders', 'Get order', B, {
        parameters: [paramId],
        responses: { 200: jsonResponse('OrderDocument'), 404: J.notFound },
      }),
      put: op('put', 'Orders', 'Update order (tracking / status)', B, {
        parameters: [paramId],
        description: 'If both `orderTrackingLink` and `orderTrackingCode` set, status becomes `shipped`.',
        ...jsonBody('OrderUpdateBody', 'Partial shipment fields'),
        responses: { 200: jsonResponse('OrderDocument'), 404: J.notFound },
      }),
      delete: op('delete', 'Orders', 'Delete order', B, {
        parameters: [paramId],
        responses: { 200: jsonResponse('SuccessMessage'), 404: J.notFound },
      }),
    },
    [`${a}/orders/update-order-payment`]: {
      post: op('post', 'Orders', 'Payment gateway callback (X-Webhook-Secret / X-Order-Webhook-Secret only when ORDER_PAYMENT_WEBHOOK_ENABLED=true)', P, {
        responses: { 200: J.ok, 400: J.badRequest, 401: J.unauthorized },
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
      get: op('get', 'Bookings', 'List bookings', B, {
        description: 'Tenant-scoped bookings; optional query params per `routes/booking.js`.',
      }),
      post: op('post', 'Bookings', 'Create booking', B, {
        description: 'Creates a booking; body shape follows Booking model (customer, resource/service, time window, etc.).',
      }),
    },
    [`${a}/bookings/{id}`]: {
      put: op('put', 'Bookings', 'Update booking', B, {
        parameters: [
          paramId,
          {
            name: 'notifyCustomer',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['true', 'false'], default: 'true' },
            description:
              'When `false`, skips customer notification emails after an update (default sends if details changed and SMTP is configured).',
          },
        ],
        description:
          'Updates booking fields. Optional JSON: `notifyCustomer` (boolean), `customerNotifyReason` (string) shown in the change email. When notifying, send **`customerNotifyChanges`** (or `notifyCustomerChanges`): an array of `{ label, from, to }` built by the UI after batch moves (if omitted, the server diffs previous vs saved booking). If the array is empty, no change email is sent even when `notifyCustomer` is true.',
      }),
      delete: op('delete', 'Bookings', 'Delete booking', B, { parameters: [paramId] }),
    },
    [`${a}/bookings/{id}/send-statement`]: {
      post: op('post', 'Bookings', 'Email booking statement to customer', B, {
        parameters: [paramId],
        description:
          'Emails the customer a record of the booking and payment on file. Copy states this is for their records only — not a payment request.',
        responses: {
          200: jsonResponse('FlexibleJson', 'Statement sent'),
          400: J.badRequest,
          404: J.notFound,
          503: jsonErr('Business email not configured'),
        },
      }),
    },
    [`${a}/bookings/{id}/payment-confirmation`]: {
      post: op('post', 'Bookings', 'Payment confirmation (X-Webhook-Secret / X-Booking-Webhook-Secret only when BOOKING_PAYMENT_WEBHOOK_ENABLED=true)', P, {
        parameters: [paramId],
        responses: { 200: J.ok, 401: J.unauthorized, 404: J.notFound },
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

    ...buildClientPaths(a, B, P, paramClientId),

    [`${a}/customer`]: {
      get: op('get', 'Customer', 'List customers (Bearer: client JWT in header)', B, {
        description: 'Tenant-scoped customer list; see `routes/customer.js` for query options.',
        responses: { 200: jsonResponse('CustomerListResponse') },
      }),
      post: op('post', 'Customer', 'Create / register customer', B, {
        description:
          'Validated by `validateCustomerInput` (first/last name, email, password ≥ 6). Optional address fields: `street`, `apartment`, `city`, `postalCode`, `phoneNumber`.',
        ...jsonBody('CustomerCreateBody', 'Storefront customer registration'),
        responses: {
          201: jsonResponse('CustomerRegisterResponse'),
          400: J.badRequest,
          409: jsonErr('Conflict (e.g. email already registered)'),
        },
      }),
    },
    [`${a}/customer/login`]: {
      post: op('post', 'Customer', 'Customer login (Bearer: client JWT identifies tenant)', B, {
        ...jsonBody('CustomerLoginBody', 'Credentials + tenant context per route'),
        responses: {
          200: jsonResponse('CustomerLoginResponse'),
          400: J.badRequest,
          401: J.unauthorized,
          403: J.forbidden,
        },
      }),
    },
    [`${a}/customer/wishlists`]: {
      get: op('get', 'Customer', 'Get wish lists for a customer', B, {
        description:
          'Returns wish list groups for a specific customer, scoped by authenticated tenant `clientID` and query `customerID`.',
        parameters: [
          {
            name: 'customerID',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'Customer Mongo ObjectId to fetch wish lists for (must belong to authenticated client).',
          },
        ],
        responses: {
          200: jsonResponse('CustomerWishlistsResponse'),
          400: J.badRequest,
          404: J.notFound,
        },
      }),
    },
    [`${a}/customer/verify/{token}`]: {
      post: op('post', 'Customer', 'Verify email with token in path', P, {
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: jsonResponse('SuccessMessage'), 400: J.badRequest },
      }),
    },
    [`${a}/customer/resend-verification`]: {
      post: op('post', 'Customer', 'Resend verification', B, { responses: { 200: jsonResponse('FlexibleJson') } }),
    },
    [`${a}/customer/reset-password`]: {
      post: op('post', 'Customer', 'Request password reset (Bearer: client JWT)', B, {
        responses: { 200: jsonResponse('FlexibleJson') },
      }),
    },
    [`${a}/customer/reset-password/{token}`]: {
      post: op('post', 'Customer', 'Complete password reset', P, {
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: jsonResponse('SuccessMessage'), 400: J.badRequest },
      }),
    },
    [`${a}/customer/get/count`]: {
      get: op('get', 'Customer', 'Customer count', B, { responses: { 200: jsonResponse('CustomerCountResponse') } }),
    },
    [`${a}/customer/{id}`]: {
      get: op('get', 'Customer', 'Get customer', B, {
        parameters: [paramId],
        responses: { 200: jsonResponse('CustomerPublic'), 404: J.notFound },
      }),
      put: op('put', 'Customer', 'Update customer', B, {
        parameters: [paramId],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomerUpdateBody' } } },
        },
        responses: { 200: jsonResponse('CustomerRegisterResponse'), 404: J.notFound },
      }),
      delete: op('delete', 'Customer', 'Delete customer', B, {
        parameters: [paramId],
        responses: { 200: jsonResponse('SuccessMessage'), 404: J.notFound },
      }),
    },
    [`${a}/customer/{id}/cart`]: {
      post: op('post', 'Customer', 'Add to cart', B, {
        parameters: [paramId],
        ...jsonBody('CustomerCartAddBody', 'Product id, quantity, optional variant'),
        responses: {
          200: jsonResponse('CartOperationResponse'),
          400: J.badRequest,
          404: J.notFound,
        },
      }),
      get: op('get', 'Customer', 'Get cart', B, {
        parameters: [paramId],
        responses: { 200: jsonResponse('CustomerCartGetResponse'), 404: J.notFound },
      }),
      delete: op('delete', 'Customer', 'Clear cart', B, {
        parameters: [paramId],
        responses: { 200: jsonResponse('SuccessMessage'), 404: J.notFound },
      }),
    },
    [`${a}/customer/{id}/cart/{productId}`]: {
      put: op('put', 'Customer', 'Update cart line', B, {
        parameters: [
          paramId,
          { name: 'productId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        ...jsonBody('CustomerCartLineUpdateBody', 'New quantity; optional variant to match line'),
        responses: { 200: jsonResponse('CartOperationResponse'), 400: J.badRequest, 404: J.notFound },
      }),
      delete: op('delete', 'Customer', 'Remove cart line', B, {
        parameters: [
          paramId,
          { name: 'productId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomerCartRemoveBody' } } },
        },
        responses: { 200: jsonResponse('CartOperationResponse'), 404: J.notFound },
      }),
    },
    [`${a}/customer/{id}/orders`]: {
      post: op('post', 'Customer', 'Append order to customer history', B, {
        parameters: [paramId],
        ...jsonBody('CustomerOrderHistoryAppendBody', 'Order id, line items, total; clears cart in handler'),
        responses: { 200: jsonResponse('CustomerOrderHistoryAppendResponse'), 400: J.badRequest, 404: J.notFound },
      }),
      get: op('get', 'Customer', 'List customer order history', B, {
        parameters: [paramId],
        responses: { 200: jsonResponse('CustomerOrderHistoryResponse'), 404: J.notFound },
      }),
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
      get: {
        tags: ['Email'],
        summary: 'List threads / messages (unified mailbox)',
        description:
          'Uses **validateClient** (Bearer JWT with `clientID`). Syncs from IMAP on a cooldown unless opening only a thread without `refresh=true`. See `EMAIL_IMAP_SYNC_COOLDOWN_MS` in `.env.example`.',
        security: B,
        parameters: [
          {
            name: 'view',
            in: 'query',
            schema: { type: 'string', enum: ['threads', 'messages', 'thread'], default: 'threads' },
            description: '`thread` + `threadId` returns one conversation.',
          },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['gmail', 'simple'], default: 'gmail' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
            description: 'Page size for threads or messages (default 10; use `page` for more).',
          },
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'label', in: 'query', schema: { type: 'string' } },
          {
            name: 'folder',
            in: 'query',
            schema: { type: 'string', enum: ['inbox', 'sent', 'all'], default: 'inbox' },
            description:
              '`inbound` vs `outbound` filter for `view=threads` / `view=messages`. Use **`sent`** for sent mail. **`all`** includes both directions.',
          },
          {
            name: 'syncSent',
            in: 'query',
            schema: { type: 'string', enum: ['true', 'false'] },
            description:
              'When `true` with an IMAP sync, also imports the server Sent folder into Mongo (avoids UID collisions by matching on Message-ID only). `folder=sent` and `refresh=true` triggers Sent sync automatically.',
          },
          {
            name: 'threadId',
            in: 'query',
            schema: { type: 'string' },
            description: 'When set with `view=thread`, loads that thread (mostly DB-only unless `refresh=true`).',
          },
          {
            name: 'refresh',
            in: 'query',
            schema: { type: 'string', enum: ['true', 'false'] },
            description: '`true` forces IMAP inbox sync (and Sent when `syncSent=true` or `folder=sent`).',
          },
          { name: 'includeSpamTrash', in: 'query', schema: { type: 'boolean', default: false } },
          { name: 'maxResults', in: 'query', schema: { type: 'integer', default: 50 } },
          {
            name: 'markAsRead',
            in: 'query',
            schema: { type: 'string', enum: ['true', 'false'] },
            description: 'When loading a single thread, optionally mark messages read.',
          },
        ],
        responses: R.ok,
      },
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
          400: J.badRequest,
          404: J.notFound,
          500: J.serverError,
        },
      },
      put: {
        tags: ['Email'],
        summary: 'Bulk mailbox updates (read, labels, trash, …)',
        description:
          'JSON body: `action` (markRead | markUnread | addLabel | removeLabel | trash | archive | spam), `ids` and/or `threadIds`, optional `label` / `labels` / `removeLabel`. Updates Mongo + IMAP flags when UIDs exist.',
        security: B,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/EmailMailboxPutBody' } } },
        },
        responses: { ...R.ok, 400: J.badRequest, 500: J.serverError },
      },
      delete: {
        tags: ['Email'],
        summary: 'Trash or permanently delete messages',
        description:
          'Query: `ids` (comma-separated Mongo ids), `threadIds`, `permanent=true` for hard delete from DB (IMAP delete not fully implemented).',
        security: B,
        parameters: [
          { name: 'ids', in: 'query', schema: { type: 'string' }, description: 'Comma-separated `_id` values' },
          { name: 'threadIds', in: 'query', schema: { type: 'string' } },
          { name: 'permanent', in: 'query', schema: { type: 'boolean', default: false } },
        ],
        responses: { ...R.ok, 400: J.badRequest, 500: J.serverError },
      },
    },
    [`${a}/email/search`]: {
      get: op('get', 'Email', 'Search mailbox', B, {
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search text' },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10, minimum: 1, maximum: 50 } },
          {
            name: 'field',
            in: 'query',
            schema: { type: 'string', enum: ['all', 'subject', 'from', 'to', 'body'], default: 'all' },
          },
        ],
      }),
    },
    [`${a}/email/stats`]: { get: op('get', 'Email', 'Mailbox stats', B) },
    [`${a}/email/batch`]: { post: op('post', 'Email', 'Batch flag updates', B) },
    [`${a}/email/newsletter/send`]: {
      post: {
        tags: ['Email'],
        summary: 'Send newsletter (multipart)',
        description:
          'Starts an async send to active subscribers or a custom recipient list. Use **multipart/form-data**.\n\n' +
          '- Default: provide **`subject`** and **`html`** (optional **`text`**).\n' +
          '- **Sales / “template one”**: set **`promoTemplate`** to `one`, `promo_one`, or `1`, and supply **`promoPayload`** as a JSON **string** (schema `NewsletterPromoPayload`) **or** pass **`promoBlocks`** as a JSON string array of `NewsletterPromoBlock`. In that case **`html`** may be omitted.\n' +
          '- Attach up to **5** files in **`attachments`**.\n' +
          '- Pacing is sequential per batch: env **`NEWSLETTER_BATCH_SIZE`**, **`NEWSLETTER_BATCH_DELAY_MS`**, **`NEWSLETTER_EMAIL_DELAY_MS`**.\n' +
          '- After SMTP retries, sends with `saveToSent: false` may be **queued** on the outbound-email worker (`EMAIL_OUTBOX_*`); completion logs include `totalQueued`.',
        security: B,
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['subject'],
                properties: {
                  subject: { type: 'string', description: 'Email subject line.' },
                  html: {
                    type: 'string',
                    description:
                      'Full HTML body. Omit when using `promoTemplate=one` with valid `promoPayload` / `promoBlocks`.',
                  },
                  text: { type: 'string', description: 'Plain-text part; defaults from HTML when omitted.' },
                  useSubscribers: {
                    type: 'string',
                    description: 'Default true. Set to `false` to use `customRecipients` only.',
                    enum: ['true', 'false'],
                  },
                  enableTracking: {
                    type: 'string',
                    description: 'Default true. Set to `false` to disable open pixel.',
                    enum: ['true', 'false'],
                  },
                  customRecipients: {
                    type: 'string',
                    description:
                      'JSON array when `useSubscribers=false`, e.g. `[{"address":"a@b.com","name":"Ann"}]` or `["x@y.com"]`.',
                  },
                  attachments: {
                    type: 'array',
                    maxItems: 5,
                    items: { type: 'string', format: 'binary' },
                    description: 'Optional files (field name `attachments`; up to 5).',
                  },
                  promoTemplate: {
                    type: 'string',
                    enum: ['one', 'promo_one', '1'],
                    description:
                      'When set, builds the stacked “template one” retail layout from `promoPayload` or `promoBlocks`.',
                  },
                  promoPayload: {
                    type: 'string',
                    description:
                      'JSON string matching `NewsletterPromoPayload` (must include `blocks` with at least one valid `imageUrl`).',
                  },
                  promoBlocks: {
                    type: 'string',
                    description:
                      'Alternative to `promoPayload`: JSON string of `[{ "imageUrl", "linkUrl?", "alt?" }, ...]` (same as `promoPayload.blocks`).',
                  },
                },
              },
            },
          },
        },
        responses: {
          ...R.ok,
          200: jsonResponse('EmailNewsletterSendStartedResponse', 'Send job accepted; delivery continues in the background'),
          400: J.badRequest,
        },
      },
    },
    [`${a}/email/newsletter/subscribers`]: { get: op('get', 'Email', 'List newsletter subscribers', B) },
    [`${a}/email/newsletter/subscribers/bulk`]: { post: op('post', 'Email', 'Bulk subscriber action', B) },
    [`${a}/email/newsletter/subscribers/unsubscribe`]: { post: op('post', 'Email', 'Unsubscribe subscriber (dashboard)', B) },
    [`${a}/email/newsletter/subscribers/stats`]: { get: op('get', 'Email', 'Subscriber stats', B) },
    [`${a}/email/newsletter/rate-limit`]: { get: op('get', 'Email', 'Newsletter rate limit info', B) },
    [`${a}/email/newsletter/stats`]: { get: op('get', 'Email', 'Newsletter send stats', B) },
    [`${a}/email/newsletter/opens/stats`]: { get: op('get', 'Email', 'Open tracking summary', B) },
    [`${a}/email/newsletter/opens`]: { get: op('get', 'Email', 'Open tracking events', B) },
    [`${a}/email/newsletter/open.gif`]: {
      get: op('get', 'Email', 'Tracking pixel (public)', P, {
        responses: {
          200: {
            description: '1×1 transparent GIF',
            content: { 'image/gif': { schema: { type: 'string', format: 'binary' } } },
          },
        },
      }),
    },
    [`${a}/email/newsletter/unsubscribe`]: {
      get: op('get', 'Email', 'One-click unsubscribe landing (public)', P, {
        responses: {
          200: {
            description: 'HTML confirmation page',
            content: { 'text/html': { schema: { type: 'string' } } },
          },
        },
      }),
    },
    [`${a}/email/subscribe`]: {
      post: op('post', 'Email', 'Public subscribe', P, { responses: { 201: J.created } }),
    },
    [`${a}/email/unsubscribe`]: {
      post: op('post', 'Email', 'Public unsubscribe', P, { responses: { 200: J.ok } }),
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
          200: jsonResponse('SuccessMessage', 'Signature image stored'),
          400: J.badRequest,
          401: J.unauthorized,
        },
      },
    },
    [`${a}/payments/payfast/itn`]: {
      post: op('post', 'Payments', 'PayFast ITN (form body; server-side validation)', P, {
        responses: {
          200: {
            description: 'Acknowledged (often empty body from server)',
            content: { 'text/plain': { schema: { type: 'string', example: '' } } },
          },
        },
      }),
    },

    [`${a}/events/health`]: { get: op('get', 'Tracking', 'Tracking DB health', B) },
    [`${a}/events/batch`]: {
      post: {
        tags: ['Tracking'],
        summary: 'Ingest tracking events',
        description:
          'Public batch endpoint (JWT exempt). Each event requires `clientId`, `sessionId`, `eventType`. Optional `Authorization` or `x-client-id` headers override inferred tenant.',
        security: P,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/TrackingBatchBody' } } },
        },
        responses: {
          201: jsonResponse('TrackingBatchAccepted', 'Events stored'),
          400: J.badRequest,
          429: jsonErr('Too many requests'),
        },
      },
    },
    [`${a}/events/convert-anonymous`]: {
      post: op('post', 'Tracking', 'Link anonymous events to customer (no express-jwt; optional client context via headers/body)', P, {
        ...jsonBody('TrackingConvertAnonymousBody', 'Browser anonymous id + customer Mongo id'),
        responses: {
          200: jsonResponse('TrackingConvertAnonymousResponse'),
          400: J.badRequest,
        },
      }),
    },
    [`${a}/events/stats/{clientId}`]: {
      get: op('get', 'Tracking', 'Event stats for client', B, {
        parameters: [{ name: 'clientId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    [`${a}/events/debug/queue-status`]: { get: op('get', 'Tracking', 'Queue status', B) },
    [`${a}/events/debug/queue`]: {
      get: op('get', 'Tracking', '[Dev] Queue + recent events', B, {
        description:
          '**Only registered when `NODE_ENV=development`.** Returns processor stats plus last 10 events.',
      }),
    },
    [`${a}/events/debug/test-error`]: {
      post: op('post', 'Tracking', '[Dev] Throw test error', P, {
        description:
          '**Only when `NODE_ENV=development`.** Intentional server error for failure pipelines. `POST /events/*` is JWT-exempt in `helpers/jwt.js`, so this may be callable without Bearer.',
      }),
    },
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
        'REST API for KhanaConnect. Mount prefix is `API_URL` (default `/api/v1`). Client dashboard routes typically require a Bearer JWT from `POST .../client/login`. Storefront customer routes use a customer JWT from `POST .../customer/login`. PayFast ITN and some marketing endpoints are public. Order/booking payment callbacks optionally verify `X-Webhook-Secret` (or `X-Order-Webhook-Secret` / `X-Booking-Webhook-Secret`) only when `ORDER_PAYMENT_WEBHOOK_ENABLED` / `BOOKING_PAYMENT_WEBHOOK_ENABLED` is true and the matching `*_SECRET` is set. See `.env.example`.\n\n**Request bodies** in this spec use named schemas aligned with `routes/` and `models/` (including multipart fields for categories and products).',
      version: process.env.npm_package_version || '0.0.0',
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Local' },
      { url: 'https://khanatechnologies.co.za', description: 'Production (example)' },
    ],
    tags: [
      { name: 'Meta', description: 'HTML home page served at `/` (Express view).' },
      { name: 'Auth', description: 'Reserved tag; primary auth flows live under **Client** and **Customer**.' },
      {
        name: 'Client',
        description:
          'Tenant onboarding (`POST /client`), JWT login, GA4 configuration, Meta/Google/TikTok/Pinterest ad integrations (including Marketing API **adAccountId** and **campaigns** on `metaAds`), tracking settings, event logs, and encryption admin tools.',
      },
      {
        name: 'Wishlists',
        description:
          'Customer wish list **groups** (`/wishlists`): first `GET /wishlists` ensures a default **My wish list** group; add products per group (optional variant + sale/restock alerts). Uses **customerBearer** JWT. **`GET /wishlists/stats`** (separate path) is **merchant-only**: aggregate popularity by product/variant for promos — no shopper PII. Emails use tenant SMTP when catalog price/sale or stock crosses thresholds (`services/wishlistNotifyService.js`).',
      },
      {
        name: 'Service wishlist',
        description:
          'Customer **service** reminders (`/service-wishlist`): add a catalog service + calendar month/year. Each row may set **`catchUpIfMissed`** (default true): the job sends once from the **start of that month** through **`SERVICE_WISHLIST_CATCH_UP_DAYS_AFTER_MONTH`** days after month-end if the server missed earlier runs. When false, only a run on the **1st of the target month** sends. Cron: `SERVICE_WISHLIST_REMINDER_CRON` (default `0 8 * * *` daily), optional `TZ`, disable with `SERVICE_WISHLIST_REMINDER_DISABLED=1`.',
      },
      {
        name: 'Categories',
        description:
          'Product categories (`/categories`). `POST /` and `PUT /{id}` use `multipart/form-data` (`name`, optional `image`, `icon`, `color`) — see `CategoryMultipartCreateBody` / `CategoryMultipartUpdateBody`.',
      },
      {
        name: 'Products',
        description:
          'Catalog (`/products`). List/get often public; mutating routes need client JWT. Create is usually multipart for images.',
      },
      { name: 'Sizes', description: 'Size options (`/size`) for product variants.' },
      {
        name: 'Product sales',
        description: 'Recorded sales lines (`/productsales`) linked to products and promotions.',
      },
      {
        name: 'Discount codes',
        description:
          'Verify codes for checkout (`verify-discount-code`), manage checkout codes (`checkout-codes`).',
      },
      {
        name: 'Orders',
        description:
          'Order lifecycle (`/orders`), totals, analytics, PayFast-related updates, optional payment webhooks (`update-order-payment`).',
      },
      {
        name: 'Bookings',
        description:
          'Appointments (`/bookings`): availability, resources, waitlist, payment confirmation webhooks.',
      },
      { name: 'Staff', description: 'Staff directory (`/staff`) for booking and dashboard.' },
      { name: 'Services', description: 'Bookable services (`/services`).' },
      {
        name: 'Resources',
        description:
          'Bookable resources (`/resources`): **list, create, update, delete** only — there is no `GET /resources/{id}` in the Express router.',
      },
      {
        name: 'Email subscriptions',
        description: 'Legacy subscriber routes under `/emailsub` (subscribe, unsubscribe, export).',
      },
      {
        name: 'Email',
        description:
          'IMAP mailbox (`/email`), send/reply/forward, newsletters (**multipart** `POST .../email/newsletter/send` — optional **promoTemplate one** + `promoPayload` / `promoBlocks` for stacked sales layouts), open tracking, public subscribe/unsubscribe.',
      },
      { name: 'Payments', description: 'PayFast ITN (`/payments/payfast/itn`) and related gateway hooks.' },
      {
        name: 'Tracking',
        description: 'Browser/event pipeline (`/events`): batch ingest, stats, anonymous linking — see `routes/trackingEvents.js`.',
      },
      { name: 'Analytics', description: 'Aggregated reporting (`/analytics/overview`).' },
      {
        name: 'Preorder pledge',
        description: 'Crowdfunding-style pledges (`/preorderpledge`), campaigns, exports, notifications.',
      },
      {
        name: 'Campaigns',
        description: 'Marketing campaigns (`/campaigns`): signups, rewards, assets, public landing data.',
      },
      {
        name: 'Voting campaigns',
        description: 'Contest voting (`/votingcampaigns`): public vote endpoints use **customerBearer** JWT.',
      },
      {
        name: 'Customer',
        description:
          'Storefront users (`/customer`): registration, login (with client tenant context), cart, orders segment, analytics.',
      },
      {
        name: 'Admin',
        description:
          'Cross-tenant administration (`/admin`): client list, nested tokens, per-client counts, permission overrides.',
      },
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
        FlexibleJson: {
          type: 'object',
          description:
            'Typical JSON payload; exact fields depend on the route. Prefer the operation summary and the matching `routes/*.js` handler when integrating.',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string' },
            error: { type: 'string' },
            data: { type: 'object' },
          },
          example: { success: true, message: 'OK' },
        },
        SuccessMessage: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string', example: 'Done' },
          },
        },
        NewsletterPromoBlock: {
          type: 'object',
          description: 'One promotional tile (stacked full-width row in “template one”).',
          required: ['imageUrl'],
          properties: {
            imageUrl: {
              type: 'string',
              description:
                'Public `https://` / `http://` URL, or site path under `/public/uploads/` (e.g. `/public/uploads/promotions/banner.png`).',
            },
            linkUrl: {
              type: 'string',
              description: 'Optional click-through URL (`https://`, `http://`, or same-origin path starting with `/`).',
            },
            alt: { type: 'string', description: 'Image alt text / accessibility label.' },
          },
        },
        NewsletterPromoPayload: {
          type: 'object',
          description:
            'JSON object serialized into the multipart field `promoPayload` when using `promoTemplate=one`. At least one block must have a valid `imageUrl`.',
          properties: {
            preheader: { type: 'string', description: 'Hidden preheader / preview text.' },
            headline: { type: 'string', description: 'Optional headline above the image stack.' },
            introHtml: {
              type: 'string',
              description:
                'Optional short HTML snippet below the headline (scripts and inline `on*` handlers are stripped server-side).',
            },
            blocks: {
              type: 'array',
              items: { $ref: '#/components/schemas/NewsletterPromoBlock' },
              description: 'Ordered promo images (frontend grid maps naturally to this list).',
            },
            ctaUrl: { type: 'string', description: 'Optional primary CTA link.' },
            ctaLabel: { type: 'string', description: 'Label for the CTA link.' },
            footerLines: {
              type: 'array',
              items: { type: 'string' },
              description: 'Small-print footer lines (plain text; escaped in HTML).',
            },
          },
        },
        EmailNewsletterSendStartedResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: true },
            message: { type: 'string', example: 'Newsletter sending started' },
            data: {
              type: 'object',
              properties: {
                recipientSource: { type: 'string', enum: ['subscribers', 'custom'] },
                totalRecipients: { type: 'integer' },
                totalBatches: { type: 'integer' },
                estimatedTime: {
                  type: 'string',
                  description:
                    'Rough duration based on `NEWSLETTER_EMAIL_DELAY_MS` between recipients and `NEWSLETTER_BATCH_DELAY_MS` between batches.',
                },
                enableTracking: { type: 'boolean' },
                rateLimit: {
                  type: 'object',
                  properties: {
                    currentHour: { type: 'integer' },
                    currentDay: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
        CategoryDocument: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            id: { type: 'string', description: 'Virtual id (hex)' },
            name: { type: 'string' },
            image: { type: 'string' },
            icon: { type: 'string' },
            color: { type: 'string' },
            clientID: { type: 'string' },
          },
        },
        CategoryListResponse: {
          type: 'array',
          items: { $ref: '#/components/schemas/CategoryDocument' },
        },
        SizeDocument: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            clientID: { type: 'string' },
          },
        },
        SizeListResponse: {
          type: 'array',
          items: { $ref: '#/components/schemas/SizeDocument' },
        },
        StaffDocument: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            role: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
            skills: { type: 'array', items: { type: 'string' } },
            isActive: { type: 'boolean' },
            clientID: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        StaffListResponse: {
          type: 'array',
          items: { $ref: '#/components/schemas/StaffDocument' },
        },
        ServiceDocument: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            price: { type: 'number' },
            clientID: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ServiceListResponse: {
          type: 'array',
          items: { $ref: '#/components/schemas/ServiceDocument' },
        },
        ResourceDocument: {
          type: 'object',
          description: 'Bookable resource; full model includes scheduling fields in `models/resource.js`.',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string' },
            description: { type: 'string' },
            capacity: { type: 'integer' },
            features: { type: 'array', items: { type: 'string' } },
            location: { type: 'string' },
            color: { type: 'string' },
            isActive: { type: 'boolean' },
            clientID: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ResourceListResponse: {
          type: 'array',
          items: { $ref: '#/components/schemas/ResourceDocument' },
        },
        ProductDocument: {
          type: 'object',
          description: 'Product returned by list/get routes (may include populated `category`).',
          properties: {
            _id: { type: 'string' },
            id: { type: 'string' },
            productName: { type: 'string' },
            description: { type: 'string' },
            richDescription: { type: 'string' },
            price: { type: 'number' },
            salePercentage: { type: 'number' },
            countInStock: { type: 'integer' },
            images: { type: 'array', items: { type: 'string' } },
            brand: { type: 'string' },
            category: { oneOf: [{ type: 'string' }, { $ref: '#/components/schemas/CategoryDocument' }] },
            rating: { type: 'number' },
            numReviews: { type: 'integer' },
            isFeatured: { type: 'boolean' },
            clientID: { type: 'string' },
            variants: { type: 'array', items: { type: 'object' } },
            ingredients: { type: 'string' },
            usage: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ProductListResponse: {
          type: 'array',
          items: { $ref: '#/components/schemas/ProductDocument' },
        },
        SalesItemDocument: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            itemType: { type: 'string', enum: ['service', 'product'] },
            selectedProductIds: { type: 'array', items: { type: 'string' } },
            discountPercentage: { type: 'number' },
            startDate: { type: 'string', format: 'date-time' },
            endDate: { type: 'string', format: 'date-time' },
            clientID: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        SalesItemListResponse: {
          type: 'array',
          items: { $ref: '#/components/schemas/SalesItemDocument' },
        },
        WishlistLineItemDocument: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            product: { oneOf: [{ type: 'string' }, { $ref: '#/components/schemas/ProductDocument' }] },
            quantity: { type: 'integer' },
            variantName: { type: 'string' },
            variantValue: { type: 'string' },
            notifyOnSale: { type: 'boolean' },
            notifyOnRestock: { type: 'boolean' },
            notes: { type: 'string' },
            addedAt: { type: 'string', format: 'date-time' },
          },
        },
        WishlistMerchantStatsResponse: {
          type: 'object',
          required: ['success', 'summary', 'items'],
          properties: {
            success: { type: 'boolean', example: true },
            summary: {
              type: 'object',
              properties: {
                totalWishlistLines: { type: 'integer', description: 'All wish list line rows for the tenant' },
                customersWithWishlistActivity: {
                  type: 'integer',
                  description: 'Distinct shoppers with ≥1 line (count only — not listed)',
                },
                rankedRowsReturned: { type: 'integer' },
              },
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  rank: { type: 'integer' },
                  productId: { type: 'string' },
                  variantName: { type: 'string' },
                  variantValue: { type: 'string' },
                  saveCount: { type: 'integer', description: 'Number of wish list lines (same product+variant)' },
                  totalQuantitySaved: { type: 'integer' },
                  customerCount: {
                    type: 'integer',
                    description: 'Distinct shoppers who saved this product+variant (aggregate count only)',
                  },
                  product: {
                    type: 'object',
                    nullable: true,
                    properties: {
                      productName: { type: 'string' },
                      price: { type: 'number' },
                      salePercentage: { type: 'number' },
                      countInStock: { type: 'integer' },
                      images: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
        WishlistGroupDocument: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            clientID: { type: 'string' },
            customerID: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            sortOrder: { type: 'number' },
            items: { type: 'array', items: { $ref: '#/components/schemas/WishlistLineItemDocument' } },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        WishlistsListResponse: {
          type: 'object',
          required: ['success', 'lists', 'count'],
          properties: {
            success: { type: 'boolean', example: true },
            count: { type: 'integer', example: 1 },
            lists: { type: 'array', items: { $ref: '#/components/schemas/WishlistGroupDocument' } },
          },
        },
        WishlistGroupDetailResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            list: { $ref: '#/components/schemas/WishlistGroupDocument' },
          },
        },
        WishlistGroupMutationResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            list: { $ref: '#/components/schemas/WishlistGroupDocument' },
          },
        },
        WishlistItemMutationResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            updated: { type: 'boolean', description: 'True when an existing line was merged' },
            list: { $ref: '#/components/schemas/WishlistGroupDocument' },
          },
        },
        DiscountVerifyResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            discountPercentage: { type: 'number' },
            totalDiscount: { type: 'number' },
            eligibleProducts: { type: 'array', items: { $ref: '#/components/schemas/ProductDocument' } },
          },
        },
        DiscountCheckoutCreateResponse: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            checkoutCode: { type: 'object' },
            newsletter: {
              type: 'object',
              nullable: true,
              description: 'Present when `notifySubscribers` was requested; `started` means sends are running asynchronously.',
              properties: {
                status: { type: 'string', enum: ['started', 'skipped'] },
                reason: { type: 'string' },
                estimatedRecipients: { type: 'integer' },
                newsletterId: { type: 'string' },
              },
            },
            wishlistAlerts: {
              type: 'object',
              nullable: true,
              description: 'Asynchronous wishlist alert dispatch status for product-targeted codes.',
              properties: {
                status: { type: 'string', enum: ['started', 'skipped'] },
                reason: { type: 'string' },
              },
            },
          },
        },
        CustomerWishlistsResponse: {
          type: 'object',
          required: ['success', 'clientID', 'customerID', 'count', 'wishlists'],
          properties: {
            success: { type: 'boolean', example: true },
            clientID: { type: 'string' },
            customerID: { type: 'string' },
            count: { type: 'integer', example: 1 },
            wishlists: { type: 'array', items: { $ref: '#/components/schemas/WishlistGroupDocument' } },
          },
        },
        DiscountCodeDocument: {
          type: 'object',
          description: 'Checkout / discount code record',
          properties: {
            _id: { type: 'string' },
            id: { type: 'string' },
            code: { type: 'string' },
            discount: { type: 'number' },
            type: { type: 'string' },
            appliesTo: { type: 'array', items: { type: 'string' } },
            appliesToModel: { type: 'string' },
            usageLimit: { type: 'integer' },
            usageCount: { type: 'integer' },
            isActive: { type: 'boolean' },
            clientID: { type: 'string' },
          },
        },
        DiscountCodeListResponse: {
          type: 'array',
          items: { $ref: '#/components/schemas/DiscountCodeDocument' },
        },
        OrderDocument: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            orderItems: { type: 'array', items: { type: 'string' } },
            address: { type: 'string' },
            phone: { type: 'string' },
            postalCode: { type: 'string' },
            deliveryType: { type: 'string' },
            deliveryPrice: { type: 'number' },
            status: { type: 'string' },
            totalPrice: { type: 'number' },
            finalPrice: { type: 'number' },
            customer: { type: 'string' },
            clientID: { type: 'string' },
            paid: { type: 'boolean' },
            orderTrackingLink: { type: 'string' },
            orderTrackingCode: { type: 'string' },
            checkoutCode: { type: 'string' },
            discountAmount: { type: 'number' },
            orderNotes: { type: 'string' },
            dateOrdered: { type: 'string', format: 'date-time' },
          },
        },
        OrderListResponse: {
          type: 'array',
          items: { $ref: '#/components/schemas/OrderDocument' },
        },
        CustomerPublic: {
          type: 'object',
          description: 'Customer fields returned to clients (no password hash or reset tokens).',
          properties: {
            _id: { type: 'string' },
            clientID: { type: 'string' },
            customerFirstName: { type: 'string' },
            customerLastName: { type: 'string' },
            emailAddress: { type: 'string' },
            phoneNumber: { type: 'string' },
            address: { type: 'string' },
            city: { type: 'string' },
            postalCode: { type: 'string' },
            isVerified: { type: 'boolean' },
            cart: { type: 'array', items: { type: 'object' } },
            preferences: { type: 'object' },
            lastActivity: { type: 'string', format: 'date-time' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        CustomerLoginResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string' },
            token: { type: 'string', description: 'Customer JWT (customerBearer)' },
            customer: { $ref: '#/components/schemas/CustomerPublic' },
          },
        },
        CustomerRegisterResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            customer: { $ref: '#/components/schemas/CustomerPublic' },
          },
        },
        CustomerCartAddBody: {
          type: 'object',
          required: ['productId'],
          properties: {
            productId: { type: 'string' },
            quantity: { type: 'integer', minimum: 1, default: 1 },
            variant: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
                price: { type: 'number' },
              },
            },
          },
        },
        CustomerCartLineUpdateBody: {
          type: 'object',
          required: ['quantity'],
          properties: {
            quantity: { type: 'integer', minimum: 0 },
            variant: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
              },
            },
          },
        },
        CustomerCartRemoveBody: {
          type: 'object',
          properties: {
            variant: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
              },
            },
          },
        },
        CartSummary: {
          type: 'object',
          properties: {
            totalItems: { type: 'integer' },
            totalValue: { type: 'number' },
          },
        },
        CartOperationResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            cart: { type: 'array', items: { type: 'object' } },
            cartSummary: { $ref: '#/components/schemas/CartSummary' },
          },
        },
        CustomerCountResponse: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
            success: { type: 'boolean' },
          },
        },
        CustomerListResponse: {
          type: 'array',
          items: { $ref: '#/components/schemas/CustomerPublic' },
        },
        CustomerCartGetResponse: {
          type: 'object',
          properties: {
            cart: { type: 'array', items: { type: 'object' } },
            summary: {
              type: 'object',
              properties: {
                totalItems: { type: 'integer' },
                totalValue: { type: 'number' },
                itemCount: { type: 'integer' },
              },
            },
          },
        },
        CustomerOrderHistoryAppendBody: {
          type: 'object',
          required: ['orderId', 'products', 'totalAmount'],
          properties: {
            orderId: { type: 'string' },
            totalAmount: { type: 'number' },
            status: { type: 'string', default: 'completed' },
            products: {
              type: 'array',
              items: {
                type: 'object',
                required: ['productId', 'productName', 'quantity', 'price'],
                properties: {
                  productId: { type: 'string' },
                  productName: { type: 'string' },
                  quantity: { type: 'integer' },
                  price: { type: 'number' },
                  image: { type: 'string' },
                  category: { type: 'string' },
                  variant: { type: 'object' },
                },
              },
            },
          },
        },
        CustomerOrderHistoryAppendResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            orderCount: { type: 'integer' },
            totalSpent: { type: 'number' },
          },
        },
        CustomerOrderHistoryResponse: {
          type: 'object',
          properties: {
            orders: { type: 'array', items: { type: 'object' } },
            summary: {
              type: 'object',
              properties: {
                totalOrders: { type: 'integer' },
                totalSpent: { type: 'number' },
                averageOrderValue: { type: 'number' },
              },
            },
          },
        },
        TrackingBatchAccepted: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            stored: { type: 'integer' },
            duplicates: { type: 'integer' },
            message: { type: 'string' },
          },
        },
        TrackingConvertAnonymousBody: {
          type: 'object',
          required: ['anonymousId', 'customerId'],
          properties: {
            anonymousId: { type: 'string' },
            customerId: { type: 'string' },
          },
        },
        TrackingConvertAnonymousResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            converted: { type: 'integer' },
            message: { type: 'string' },
          },
        },
        CategoryMultipartCreateBody: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', example: 'Beverages' },
            icon: { type: 'string', example: 'cup' },
            color: { type: 'string', example: '#0EA5E9' },
            image: { type: 'string', format: 'binary', description: 'Optional PNG or JPEG (max 5MB)' },
          },
        },
        CategoryMultipartUpdateBody: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            icon: { type: 'string' },
            color: { type: 'string' },
            image: { type: 'string', format: 'binary', description: 'New category image' },
          },
        },
        SizeCreateBody: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', example: 'Large' },
            description: { type: 'string', example: 'Fits most adults' },
          },
        },
        SizeUpdateBody: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
          },
        },
        StaffCreateBody: {
          type: 'object',
          required: ['name', 'role', 'email', 'phone'],
          properties: {
            name: { type: 'string', example: 'Alex Smith' },
            role: { type: 'string', example: 'Stylist' },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string', example: '+27821234567' },
            skills: { type: 'array', items: { type: 'string' }, example: ['colour', 'cuts'] },
            isActive: { type: 'boolean', default: true },
          },
        },
        StaffUpdateBody: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            role: { type: 'string' },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string' },
            skills: { type: 'array', items: { type: 'string' } },
            isActive: { type: 'boolean' },
          },
        },
        ServiceCreateBody: {
          type: 'object',
          required: ['name', 'price'],
          properties: {
            name: { type: 'string', example: 'Deep clean' },
            description: { type: 'string', example: 'Full detail' },
            price: { type: 'number', example: 450 },
          },
        },
        ServiceUpdateBody: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            price: { type: 'number' },
          },
        },
        ResourceCreateBody: {
          type: 'object',
          required: ['name', 'type'],
          properties: {
            name: { type: 'string', example: 'Court A' },
            type: {
              type: 'string',
              enum: ['room', 'treatment-room', 'meeting-room', 'facility', 'equipment', 'vehicle', 'court', 'field', 'other'],
              example: 'court',
            },
            description: { type: 'string' },
            capacity: { type: 'integer', minimum: 1, default: 1 },
            features: { type: 'array', items: { type: 'string' }, example: ['floodlights'] },
            location: { type: 'string' },
            color: { type: 'string', example: '#3B82F6' },
            duration: { type: 'number', description: 'Sent by route as `duration`; see `models/resource.js` for scheduling fields.' },
          },
        },
        ResourceUpdateBody: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: {
              type: 'string',
              enum: ['room', 'treatment-room', 'meeting-room', 'facility', 'equipment', 'vehicle', 'court', 'field', 'other'],
            },
            description: { type: 'string' },
            capacity: { type: 'integer', minimum: 1 },
            features: { type: 'array', items: { type: 'string' } },
            location: { type: 'string' },
            color: { type: 'string' },
            duration: { type: 'number' },
            isActive: { type: 'boolean' },
          },
        },
        ProductMultipartCreateBody: {
          type: 'object',
          required: ['productName', 'price', 'category', 'countInStock'],
          properties: {
            productName: { type: 'string', example: 'House blend 250g' },
            description: { type: 'string', default: '' },
            richDescription: { type: 'string', default: '' },
            brand: { type: 'string', default: '' },
            price: { type: 'number', example: 129 },
            category: { type: 'string', description: 'Category Mongo ObjectId' },
            countInStock: { type: 'integer', minimum: 0, example: 24 },
            ingredients: { type: 'string' },
            usage: { type: 'string' },
            variants: {
              type: 'string',
              description:
                'Optional JSON string; route maps `attributes[0].name` and `attributes[0].values[{ value, price, stock }]`.',
            },
            images: {
              type: 'array',
              minItems: 1,
              maxItems: 5,
              items: { type: 'string', format: 'binary' },
              description: 'At least one file required by the server; field name `images`.',
            },
          },
        },
        ProductMultipartUpdateBody: {
          type: 'object',
          properties: {
            productName: { type: 'string' },
            description: { type: 'string' },
            richDescription: { type: 'string' },
            brand: { type: 'string' },
            price: { type: 'number' },
            category: { type: 'string', description: 'Category Mongo ObjectId' },
            countInStock: { type: 'integer', minimum: 0 },
            salePercentage: { type: 'number', minimum: 0, maximum: 100 },
            rating: { type: 'number' },
            numReviews: { type: 'integer' },
            isFeatured: { type: 'boolean' },
            ingredients: { type: 'string' },
            usage: { type: 'string' },
            variants: { type: 'string', description: 'JSON string or parsed array (see route)' },
            deletedImages: { type: 'string', description: 'JSON string array of image URLs to remove' },
            images: {
              type: 'array',
              maxItems: 5,
              items: { type: 'string', format: 'binary' },
              description: 'New images to append',
            },
          },
        },
        ProductSaleCreateBody: {
          type: 'object',
          required: ['itemType', 'selectedProductIds', 'discountPercentage', 'startDate', 'endDate'],
          properties: {
            itemType: { type: 'string', enum: ['service', 'product'], example: 'product' },
            selectedProductIds: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              example: ['507f1f77bcf86cd799439011'],
            },
            discountPercentage: { type: 'number', minimum: 0, maximum: 100, example: 15 },
            startDate: { type: 'string', format: 'date-time' },
            endDate: { type: 'string', format: 'date-time' },
          },
        },
        DiscountVerifyBody: {
          type: 'object',
          required: ['discountCode', 'cartProductIds'],
          properties: {
            discountCode: { type: 'string', example: 'SPRING10' },
            cartProductIds: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              example: ['507f1f77bcf86cd799439011'],
            },
          },
        },
        DiscountCheckoutCodeCreateBody: {
          type: 'object',
          required: ['code', 'discount'],
          properties: {
            code: { type: 'string', example: 'WELCOME15' },
            discount: { type: 'number', minimum: 0, maximum: 100, example: 15 },
            type: { type: 'string', example: 'all', description: 'Defaults to `all` when omitted' },
            appliesTo: {
              type: 'array',
              items: { type: 'string' },
              description: 'Product ObjectIds when limiting scope',
              example: [],
            },
            appliesToModel: { type: 'string', example: 'Product', description: 'Defaults from `appliesTo` when omitted' },
            usageLimit: { type: 'integer', minimum: 1, default: 1 },
            isActive: { type: 'boolean', default: true },
            notifySubscribers: {
              type: 'boolean',
              default: false,
              description:
                'When true, queues a promotional email to active newsletter subscribers (same pipeline as dashboard newsletter; sending continues in the background).',
            },
            promoEmailSubject: {
              type: 'string',
              description: 'Optional custom subject when `notifySubscribers` is true (max 200 characters).',
            },
            promoEmailIntro: {
              type: 'string',
              description: 'Optional HTML-safe intro paragraph (plain text; line breaks preserved) when `notifySubscribers` is true.',
            },
          },
        },
        DiscountCheckoutCodeUpdateBody: {
          type: 'object',
          required: ['isActive'],
          properties: {
            isActive: { type: 'boolean', example: false },
          },
        },
        CustomerCreateBody: {
          type: 'object',
          required: ['customerFirstName', 'customerLastName', 'emailAddress', 'password'],
          properties: {
            customerFirstName: { type: 'string', example: 'Sam' },
            customerLastName: { type: 'string', example: 'Jones' },
            emailAddress: { type: 'string', format: 'email' },
            password: { type: 'string', format: 'password', minLength: 6 },
            street: { type: 'string' },
            apartment: { type: 'string' },
            city: { type: 'string' },
            postalCode: { type: 'string' },
            phoneNumber: { type: 'string' },
          },
        },
        CustomerUpdateBody: {
          type: 'object',
          properties: {
            customerFirstName: { type: 'string' },
            customerLastName: { type: 'string' },
            emailAddress: { type: 'string', format: 'email' },
            phoneNumber: { type: 'string' },
            address: { type: 'string' },
            city: { type: 'string' },
            postalCode: { type: 'string' },
            preferences: { $ref: '#/components/schemas/CustomerPreferencesPatch' },
            cartReminder: { $ref: '#/components/schemas/CustomerCartReminderPatch' },
          },
        },
        CustomerPreferencesPatch: {
          type: 'object',
          description: 'Partial preferences object; merged by route `$set`.',
          properties: {
            favoriteCategories: { type: 'array', items: { type: 'string' } },
            preferredPriceRange: {
              type: 'object',
              properties: {
                min: { type: 'number' },
                max: { type: 'number' },
              },
            },
            notificationPreferences: {
              type: 'object',
              properties: {
                cartReminders: { type: 'boolean' },
                promotions: { type: 'boolean' },
                restockAlerts: { type: 'boolean' },
              },
            },
          },
        },
        CustomerCartReminderPatch: {
          type: 'object',
          properties: {
            reminderType: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'custom'] },
            isActive: { type: 'boolean' },
            customHours: { type: 'number' },
          },
        },
        ClientPermissionsFlags: {
          type: 'object',
          properties: {
            bookings: { type: 'boolean' },
            orders: { type: 'boolean' },
            staff: { type: 'boolean' },
            categories: { type: 'boolean' },
            preorder: { type: 'boolean' },
            voting: { type: 'boolean' },
            sales: { type: 'boolean' },
            services: { type: 'boolean' },
            products: { type: 'boolean' },
            dashboard: { type: 'boolean' },
          },
        },
        ClientRegisterBody: {
          type: 'object',
          required: [
            'clientID',
            'companyName',
            'merchant_id',
            'merchant_key',
            'password',
            'passphrase',
            'return_url',
            'cancel_url',
            'notify_url',
            'businessEmail',
            'businessEmailPassword',
          ],
          properties: {
            clientID: { type: 'string', description: 'Stable tenant key used in JWT and URLs.' },
            companyName: { type: 'string' },
            merchant_id: { type: 'number' },
            merchant_key: { type: 'string' },
            password: { type: 'string', format: 'password' },
            passphrase: { type: 'string', description: 'PayFast passphrase' },
            return_url: { type: 'string', format: 'uri' },
            cancel_url: { type: 'string', format: 'uri' },
            notify_url: { type: 'string', format: 'uri' },
            businessEmail: { type: 'string', format: 'email' },
            businessEmailPassword: { type: 'string', format: 'password' },
            tier: { type: 'string', enum: ['bronze', 'silver', 'gold'], default: 'bronze' },
            role: { type: 'string', enum: ['client', 'admin'], default: 'client' },
            permissions: { $ref: '#/components/schemas/ClientPermissionsFlags' },
            deliveryOptions: { type: 'array', items: { type: 'object', additionalProperties: true } },
            emailSignature: { type: 'string' },
            ga4PropertyId: { type: 'string' },
            imapHost: { type: 'string' },
            imapPort: { type: 'integer' },
            smtpHost: { type: 'string' },
            smtpPort: { type: 'integer' },
          },
        },
        ClientRegisterResponse: {
          type: 'object',
          properties: {
            client: { type: 'object', additionalProperties: true, description: 'Saved Client without password' },
            token: { type: 'string' },
          },
        },
        ClientListResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            count: { type: 'integer' },
            clients: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        ClientLoginBody: {
          type: 'object',
          required: ['clientID', 'password'],
          properties: {
            clientID: { type: 'string' },
            password: { type: 'string', format: 'password' },
          },
        },
        ClientLoginResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            client: { type: 'object', additionalProperties: true },
            token: { type: 'string', description: 'HS256 JWT, 1d expiry' },
            permissions: { type: 'object', additionalProperties: true },
            role: { type: 'string' },
            tier: { type: 'string' },
            hasAdPlatforms: { type: 'boolean' },
            enabledAdPlatforms: { type: 'array', items: { type: 'string' } },
          },
        },
        ClientLogoutResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        ClientSingleResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            client: { type: 'object', additionalProperties: true },
          },
        },
        ClientUpdateBody: {
          type: 'object',
          description: 'Any subset of Client fields except clientID, token, sessionToken.',
          additionalProperties: true,
          properties: {
            companyName: { type: 'string' },
            password: { type: 'string' },
            businessEmail: { type: 'string' },
            tier: { type: 'string', enum: ['bronze', 'silver', 'gold'] },
            role: { type: 'string', enum: ['client', 'admin'] },
            permissions: { $ref: '#/components/schemas/ClientPermissionsFlags' },
            metaAds: { type: 'object', additionalProperties: true },
            googleAds: { type: 'object', additionalProperties: true },
            trackingSettings: { type: 'object', additionalProperties: true },
          },
        },
        ClientUpdateResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            client: { type: 'object', additionalProperties: true },
          },
        },
        ClientDeleteResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        ClientPermissionsBody: {
          type: 'object',
          required: ['permissions'],
          properties: {
            permissions: { $ref: '#/components/schemas/ClientPermissionsFlags' },
          },
        },
        ClientPermissionsGetResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            role: { type: 'string' },
            permissions: { $ref: '#/components/schemas/ClientPermissionsFlags' },
            isAdmin: { type: 'boolean' },
          },
        },
        ClientPermissionsPutResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            permissions: { $ref: '#/components/schemas/ClientPermissionsFlags' },
          },
        },
        GoogleAnalyticsNested: {
          type: 'object',
          properties: {
            measurementId: { type: 'string' },
            apiSecret: { type: 'string' },
            propertyId: { type: 'string' },
            isEnabled: { type: 'boolean' },
          },
        },
        ClientAnalyticsConfigResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            analyticsConfig: {
              type: 'object',
              properties: {
                googleAnalytics: { $ref: '#/components/schemas/GoogleAnalyticsNested' },
              },
            },
          },
        },
        ClientAnalyticsConfigPutBody: {
          type: 'object',
          required: ['googleAnalytics'],
          properties: {
            googleAnalytics: { $ref: '#/components/schemas/GoogleAnalyticsNested' },
          },
        },
        ClientAnalyticsConfigPutResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            analyticsConfig: { type: 'object', additionalProperties: true },
          },
        },
        MetaCampaignSubdoc: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            objective: { type: 'string' },
            budget: { type: 'number' },
            status: { type: 'string', enum: ['draft', 'active', 'paused', 'archived'] },
            meta_campaign_id: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ClientMetaAdsShape: {
          type: 'object',
          description: 'Sensitive fields stored encrypted at rest.',
          properties: {
            pixelId: { type: 'string' },
            accessToken: { type: 'string' },
            testEventCode: { type: 'string' },
            apiVersion: { type: 'string', example: 'v18.0' },
            adAccountId: { type: 'string', description: 'Digits only, no act_ prefix' },
            ownershipType: { type: 'string', enum: ['agency', 'client'] },
            metaBusinessId: { type: 'string' },
            partnerRequestId: { type: 'string' },
            campaigns: { type: 'array', items: { $ref: '#/components/schemas/MetaCampaignSubdoc' } },
            enabled: { type: 'boolean' },
            lastSync: { type: 'string', format: 'date-time' },
            status: { type: 'string', enum: ['active', 'inactive', 'error'] },
            errorMessage: { type: 'string' },
          },
        },
        ClientAdIntegrationsResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            metaAds: { $ref: '#/components/schemas/ClientMetaAdsShape' },
            googleAds: { type: 'object', additionalProperties: true },
            tiktokAds: { type: 'object', additionalProperties: true },
            pinterestAds: { type: 'object', additionalProperties: true },
            trackingSettings: { type: 'object', additionalProperties: true },
            trackingStats: { type: 'object', additionalProperties: true },
            hasEnabledPlatforms: { type: 'boolean' },
            enabledPlatforms: { type: 'array', items: { type: 'string' } },
          },
        },
        ClientMetaAdsPutBody: {
          type: 'object',
          properties: {
            pixelId: { type: 'string' },
            accessToken: { type: 'string' },
            testEventCode: { type: 'string' },
            apiVersion: { type: 'string' },
            enabled: { type: 'boolean' },
            adAccountId: { type: 'string' },
            ownershipType: { type: 'string', enum: ['agency', 'client'] },
            metaBusinessId: { type: 'string' },
            partnerRequestId: { type: 'string' },
          },
        },
        ClientGoogleAdsPutBody: {
          type: 'object',
          properties: {
            conversionId: { type: 'string' },
            apiKey: { type: 'string' },
            developerToken: { type: 'string' },
            clientId: { type: 'string' },
            clientSecret: { type: 'string' },
            refreshToken: { type: 'string' },
            customerId: { type: 'string' },
            conversionActionId: { type: 'string' },
            enabled: { type: 'boolean' },
          },
        },
        ClientTikTokAdsPutBody: {
          type: 'object',
          properties: {
            pixelId: { type: 'string' },
            accessToken: { type: 'string' },
            enabled: { type: 'boolean' },
          },
        },
        ClientPinterestAdsPutBody: {
          type: 'object',
          properties: {
            adAccountId: { type: 'string' },
            accessToken: { type: 'string' },
            enabled: { type: 'boolean' },
          },
        },
        ClientMetaTestBody: {
          type: 'object',
          required: ['pixelId', 'accessToken'],
          properties: {
            pixelId: { type: 'string' },
            accessToken: { type: 'string' },
          },
        },
        ClientGoogleTestBody: {
          type: 'object',
          required: ['conversionId'],
          properties: {
            conversionId: { type: 'string' },
            apiKey: { type: 'string' },
          },
        },
        ClientAdBulkUpdateBody: {
          type: 'object',
          required: ['platforms'],
          properties: {
            platforms: {
              type: 'object',
              properties: {
                meta: { type: 'boolean' },
                google: { type: 'boolean' },
              },
            },
          },
        },
        ClientTrackingSettingsPutBody: {
          type: 'object',
          properties: {
            batchSize: { type: 'integer', minimum: 1, maximum: 100 },
            retryAttempts: { type: 'integer', minimum: 1, maximum: 10 },
            retryDelayMs: { type: 'integer', minimum: 1000, maximum: 60000 },
            sendAnonymousEvents: { type: 'boolean' },
            sendAuthenticatedEvents: { type: 'boolean' },
            eventTypes: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['PAGE_VIEW', 'PRODUCT_VIEW', 'ADD_TO_CART', 'INITIATE_CHECKOUT', 'PURCHASE', 'LEAD'],
              },
            },
          },
        },
        ClientDebugDecryptBody: {
          type: 'object',
          required: ['encryptedValue'],
          properties: {
            encryptedValue: { type: 'string' },
          },
        },
        ClientDebugEncryptBody: {
          type: 'object',
          required: ['value'],
          properties: {
            value: { type: 'string' },
          },
        },
        OrderCreateBody: {
          type: 'object',
          required: ['orderItems', 'address', 'postalCode', 'phone', 'customer'],
          properties: {
            orderItems: {
              type: 'array',
              items: {
                type: 'object',
                required: ['product', 'quantity'],
                properties: {
                  product: { type: 'string', description: 'Product ObjectId' },
                  quantity: { type: 'integer', minimum: 1 },
                  variant: { type: 'string' },
                  variantPrice: { type: 'number' },
                },
              },
            },
            address: { type: 'string' },
            postalCode: { type: 'string' },
            phone: { type: 'string' },
            customer: { type: 'string', description: 'Customer ObjectId (must belong to tenant)' },
            deliveryType: { type: 'string' },
            deliveryPrice: { type: 'number' },
            discountCode: { type: 'string' },
            orderNotes: { type: 'string' },
          },
        },
        OrderUpdateBody: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            orderTrackingLink: { type: 'string', format: 'uri' },
            orderTrackingCode: { type: 'string' },
          },
        },
        TrackingBatchBody: {
          type: 'object',
          required: ['events'],
          properties: {
            events: {
              type: 'array',
              items: {
                type: 'object',
                required: ['clientId', 'sessionId', 'eventType'],
                properties: {
                  clientId: { type: 'string' },
                  sessionId: { type: 'string' },
                  eventType: {
                    type: 'string',
                    enum: ['PAGE_VIEW', 'PRODUCT_VIEW', 'ADD_TO_CART', 'INITIATE_CHECKOUT', 'PURCHASE', 'LEAD'],
                  },
                  metadata: {
                    type: 'object',
                    description: 'Optional client context',
                    properties: {
                      path: { type: 'string', example: '/products/123' },
                      url: { type: 'string', format: 'uri' },
                      productId: { type: 'string' },
                      referrer: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        CustomerLoginBody: {
          type: 'object',
          required: ['emailAddress', 'password'],
          description: 'Tenant is implied by **client** JWT on `POST /customer/login` (see `routes/customer.js`).',
          properties: {
            emailAddress: { type: 'string', format: 'email' },
            password: { type: 'string', format: 'password' },
          },
        },
        WishlistGroupCreateBody: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            sortOrder: { type: 'number', default: 0 },
          },
        },
        WishlistGroupUpdateBody: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            sortOrder: { type: 'number' },
          },
        },
        WishlistItemAddBody: {
          type: 'object',
          required: ['productId'],
          properties: {
            productId: { type: 'string', description: 'Mongo ObjectId of Product (same clientID)' },
            quantity: { type: 'integer', minimum: 1, default: 1 },
            variantName: { type: 'string', description: 'Must match Product.variants[].name when using variants' },
            variantValue: { type: 'string', description: 'Must match Product.variants[].values[].value' },
            notifyOnSale: { type: 'boolean', default: true },
            notifyOnRestock: { type: 'boolean', default: true },
            notes: { type: 'string' },
          },
        },
        WishlistItemPatchBody: {
          type: 'object',
          properties: {
            quantity: { type: 'integer', minimum: 1 },
            notes: { type: 'string' },
            notifyOnSale: { type: 'boolean' },
            notifyOnRestock: { type: 'boolean' },
          },
        },
        ServiceWishlistCreateBody: {
          type: 'object',
          required: ['serviceId', 'reminderYear', 'reminderMonth'],
          properties: {
            serviceId: { type: 'string', description: 'Mongo ObjectId of Service (same tenant `clientID`)' },
            reminderYear: { type: 'integer', example: 2026, minimum: 2000, maximum: 2100 },
            reminderMonth: { type: 'integer', minimum: 1, maximum: 12, description: '1 = January … 12 = December' },
            notes: { type: 'string', description: 'Optional note shown in the reminder email' },
            catchUpIfMissed: {
              type: 'boolean',
              default: true,
              description:
                'If true (default), unsent reminders are eligible from the first day of the target month through the grace period after month-end when the cron runs. If false, only a cron run on the 1st of the target month sends.',
            },
          },
        },
        ServiceWishlistPatchBody: {
          type: 'object',
          properties: {
            reminderYear: { type: 'integer', minimum: 2000, maximum: 2100 },
            reminderMonth: { type: 'integer', minimum: 1, maximum: 12 },
            notes: { type: 'string' },
            catchUpIfMissed: { type: 'boolean' },
          },
        },
        ServiceWishlistReminderItem: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            clientID: { type: 'string' },
            customerID: { type: 'string' },
            catchUpIfMissed: { type: 'boolean', description: 'When true, missed 1st-of-month sends are retried until grace after month-end.' },
            service: {
              type: 'object',
              properties: {
                _id: { type: 'string' },
                name: { type: 'string' },
                price: { type: 'number' },
                description: { type: 'string' },
                clientID: { type: 'string' },
              },
            },
            reminderYear: { type: 'integer' },
            reminderMonth: { type: 'integer' },
            notes: { type: 'string' },
            lastReminderSentAt: { type: 'string', format: 'date-time', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ServiceWishlistListResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            count: { type: 'integer' },
            items: { type: 'array', items: { $ref: '#/components/schemas/ServiceWishlistReminderItem' } },
          },
        },
        ServiceWishlistItemResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            item: { $ref: '#/components/schemas/ServiceWishlistReminderItem' },
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
        EmailMailboxPutBody: {
          type: 'object',
          required: ['action'],
          properties: {
            ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Mongo email document ids',
            },
            threadIds: { type: 'array', items: { type: 'string' } },
            action: {
              type: 'string',
              enum: ['markRead', 'markUnread', 'addLabel', 'removeLabel', 'trash', 'archive', 'spam'],
            },
            label: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
            removeLabel: { type: 'string' },
            destination: { type: 'string' },
          },
        },
      },
    },
    paths: buildPaths(a),
  };
}

module.exports = { spec, apiPath };
