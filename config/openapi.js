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
    [`${a}/legal/policies`]: {
      get: {
        tags: ['Legal'],
        summary: 'Current ToS / AUP versions and take-down agent',
        security: P,
        responses: { 200: J.ok },
      },
    },
    [`${a}/client/legal-acceptance`]: {
      get: op('get', 'Client', 'Legal acceptance status', B),
      post: {
        tags: ['Client'],
        summary: 'Accept current Merchant Terms and AUP',
        security: B,
        ...jsonBody('LegalAcceptanceBody', 'Clickwrap acceptance'),
        responses: {
          200: J.ok,
          400: J.badRequest,
          403: J.forbidden,
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

/**
 * SaaS Meta ads routes (`routes/saas.js`, mounted at `${a}/saas`).
 * Tenant comes from the Bearer JWT's clientID (or `X-Client-Id` without a token); roles from the team member.
 * Responses use `{ ok, data }`.
 */
function buildSaasMetaPaths(a) {
  const s = `${a}/saas`;
  const T = 'SaaS · Meta ads';
  const ADMIN = 'SaaS · Admin ad tips';
  const read = ' Roles: owner, manager, operator, viewer.';
  const write = ' Roles: owner, manager.';
  const insightsQuery = [
    { name: 'days', in: 'query', schema: { type: 'integer', default: 30 }, description: 'Rolling window in days. Ignored when `month` or `preset` is set.' },
    { name: 'month', in: 'query', schema: { type: 'string', pattern: '^\\d{4}-\\d{2}$' }, description: 'Calendar month `YYYY-MM` (capped at today).' },
    {
      name: 'preset',
      in: 'query',
      schema: { type: 'string', enum: ['last_7d', 'last_14d', 'last_30d', 'last_90d', 'last_month', 'this_month', 'maximum'] },
      description: 'Meta date preset.',
    },
  ];
  const campaignId = { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Meta campaign id.' };
  const capNote =
    ' Returns **403** when the plan campaign limit is reached (`metaCampaignCapStatus` in `helpers/clientPlan.js`; archived/deleted campaigns do not count). Also checks campaign credits.';
  const okData = (schemaName, description = 'OK') => jsonResponse(schemaName, description);

  return {
    // Connection
    [`${s}/meta/oauth/start`]: {
      get: op('get', T, 'Facebook Login URL for this client', B, { description: `Returns \`{ url }\` to send the owner to Facebook.${write}` }),
    },
    [`${s}/meta/oauth/callback`]: {
      get: op('get', T, 'Facebook OAuth redirect (public)', P, {
        description: 'Redirect target registered with Meta. Client is read from the signed `state`. No Bearer needed.',
        parameters: [
          { name: 'code', in: 'query', schema: { type: 'string' } },
          { name: 'state', in: 'query', schema: { type: 'string' } },
          { name: 'error', in: 'query', schema: { type: 'string' } },
        ],
      }),
    },
    [`${s}/meta/oauth/complete`]: {
      post: op('post', T, 'Finish Facebook OAuth from the dashboard (public)', P, {
        description: 'Body `{ code, state }` (or `error`). Exchanges the code for a long-lived token and stores it encrypted.',
        ...jsonBody('SaasMetaOAuthCompleteBody', 'OAuth code and signed state'),
      }),
    },
    [`${s}/meta/oauth/status`]: {
      get: op('get', T, 'Connection status (page, ad account, Instagram, pixel)', B, { description: read.trim() }),
    },
    [`${s}/meta/oauth/disconnect`]: {
      post: op('post', T, 'Disconnect Facebook', B, { description: write.trim() }),
    },
    [`${s}/meta/refresh-token`]: {
      post: op('post', T, 'Force a token refresh', B, { description: write.trim() }),
    },
    [`${s}/meta/app-permissions`]: {
      get: op('get', T, 'Approved / pending Meta app permissions + 7-day API monitor summary', B, { description: read.trim() }),
    },
    [`${s}/meta/pages`]: {
      get: op('get', T, 'Facebook Pages the token can manage', B, { description: read.trim() }),
    },
    [`${s}/meta/ad-accounts`]: {
      get: op('get', T, 'Ad accounts the token can use', B, { description: read.trim() }),
    },
    [`${s}/meta/ad-accounts/create`]: {
      post: op('post', T, "Create an ad account under the client's Business Manager", B, {
        description: `Defaults to ZAR and Africa/Johannesburg (timezone 141). Spend stays on the client's own Meta payment method.${write}`,
        ...jsonBody('SaasMetaAdAccountCreateBody', 'Optional name, currency, timezone'),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/meta/selection`]: {
      put: op('put', T, 'Choose the Page and/or ad account', B, {
        description: `At least one of \`page_id\`, \`ad_account_id\`.${write}`,
        ...jsonBody('SaasMetaSelectionBody', 'Page and/or ad account'),
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/meta/setup`]: {
      get: op('get', T, 'Setup checklist, account health and plan campaign limit', B, {
        description: `Includes \`campaignCap\` ({ plan, planLabel, cap, unlimited, used, remaining, reached }).${read}`,
        responses: { 200: okData('SaasMetaSetupResponse') },
      }),
    },
    [`${s}/meta/pixel/test-event`]: {
      post: op('post', T, 'Send a test pixel event (Conversions API)', B, {
        description: 'Body `{ eventName?, testEventCode? }`. Roles: owner, manager, operator.',
        responses: { 400: J.badRequest },
      }),
    },

    // Results
    [`${s}/meta/insights`]: {
      get: op('get', T, 'Ad results for the selected ad account', B, {
        description: `Account totals, per-campaign rows and a daily series (\`time_increment=1\`). Uses \`ads_read\`. Results are picked in priority order: chats, purchases, leads, sign-ups, link clicks, engagements (\`helpers/metaAdResults.js\`).${read}`,
        parameters: insightsQuery,
        responses: { 200: okData('SaasMetaInsightsResponse'), 400: J.badRequest },
      }),
    },
    [`${s}/meta/insights/breakdowns`]: {
      get: op('get', T, 'Results split by age, gender, platform, device or country', B, {
        description: read.trim(),
        parameters: [
          ...insightsQuery,
          {
            name: 'breakdown',
            in: 'query',
            schema: { type: 'string', enum: ['age', 'gender', 'age,gender', 'publisher_platform', 'impression_device', 'country'], default: 'age' },
          },
        ],
        responses: { 400: J.badRequest },
      }),
    },

    // Targeting and audiences
    [`${s}/meta/targeting/search`]: {
      get: op('get', T, 'Search locations and interests for targeting', B, {
        description: read.trim(),
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'type', in: 'query', schema: { type: 'string', example: 'adgeolocation' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'country_code', in: 'query', schema: { type: 'string', example: 'ZA' } },
          { name: 'location_types', in: 'query', schema: { type: 'string' }, description: 'JSON array or comma list, e.g. `city,region`.' },
        ],
      }),
    },
    [`${s}/meta/audience-presets`]: {
      get: op('get', T, 'Built-in audience presets', B, { description: read.trim() }),
    },
    [`${s}/meta/custom-audiences`]: {
      get: op('get', T, 'Custom audiences on the ad account', B, { description: read.trim() }),
    },
    [`${s}/meta/custom-audiences/preview`]: {
      get: op('get', T, 'Preview a customer-list audience before creating it', B, {
        description: read.trim(),
        parameters: [{ name: 'preset', in: 'query', schema: { type: 'string' } }],
      }),
    },
    [`${s}/meta/custom-audiences/from-customers`]: {
      post: op('post', T, "Create a custom audience from the client's customers", B, {
        description: `Body \`{ name?, preset?, description? }\`. Contact details are hashed before upload.${write}`,
        responses: { 201: J.created },
      }),
    },

    // Campaigns
    [`${s}/meta/campaigns`]: {
      get: op('get', T, 'Campaigns created through Khana', B, { description: read.trim() }),
    },
    [`${s}/meta/campaigns/{id}/status`]: {
      post: op('post', T, 'Pause, activate or archive a campaign', B, {
        description: write.trim(),
        parameters: [campaignId],
        ...jsonBody('SaasMetaCampaignStatusBody', 'New status'),
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/meta/campaigns/{id}/budget`]: {
      post: op('post', T, 'Change the daily budget', B, {
        description: write.trim(),
        parameters: [campaignId],
        ...jsonBody('SaasMetaCampaignBudgetBody', 'Daily budget in account currency'),
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/meta/creatives/image`]: {
      post: op('post', T, 'Upload an ad image', B, {
        description: `Returns the Meta image \`hash\` to pass as \`image_hash\`.${write}`,
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: { type: 'object', required: ['image'], properties: { image: { type: 'string', format: 'binary' } } },
            },
          },
        },
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/meta/campaigns/whatsapp`]: {
      post: op('post', T, 'Create a click-to-WhatsApp campaign', B, {
        description: `Creates campaign, ad set and ad on Meta (spends money once active).${capNote}${write}`,
        ...jsonBody('SaasMetaWhatsAppCampaignBody', 'Campaign settings'),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/meta/campaigns/lead`]: {
      post: op('post', T, 'Create an instant-form lead ad', B, {
        description: `Leads stay in Meta Ads Manager (\`leads_retrieval\` is not approved).${capNote}${write}`,
        ...jsonBody('SaasMetaLeadCampaignBody', 'Campaign and form settings'),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/meta/catalog/sync`]: {
      post: op('post', T, 'Sync products to the Meta catalog', B, {
        description: `Body \`{ limit? }\`.${write}`,
      }),
    },
    [`${s}/meta/campaigns/catalog`]: {
      post: op('post', T, 'Create a catalog sales campaign', B, {
        description: `Needs a synced catalog.${capNote}${write}`,
        ...jsonBody('SaasMetaCampaignBaseBody', 'Campaign settings'),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/meta/posts`]: {
      get: op('get', T, 'Page posts that can be boosted', B, {
        description: `On a permission error returns \`posts: []\` with \`error\`.${read}`,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
      }),
    },
    [`${s}/meta/boost`]: {
      post: op('post', T, 'Boost a Page or Instagram post', B, {
        description: `Requires \`post_id\` and \`daily_budget\`. Optional \`days\`, \`country\`, \`status\`, \`targeting\`, \`source\` (facebook|instagram), \`name\`, \`caption\`.${write}`,
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/ads/accounts`]: {
      post: op('post', T, 'Attach an ad account by id (legacy)', B, {
        description: `Body \`{ ad_account_id, ownership_type?, meta_business_id? }\`.${write}`,
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/ads/campaigns`]: {
      post: op('post', T, 'Create a campaign (legacy)', B, {
        description: `Body \`{ name, objective, budget?, access_token? }\`. Supports \`Idempotency-Key\`. Also enforces the plan campaign limit.${write}`,
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },

    // Khana admin
    [`${s}/admin/meta/ad-tips/clients`]: {
      get: op('get', ADMIN, 'Clients with a connected ad account', [{ bearerAuth: [] }, { saasAdminApiKey: [] }], {
        description: 'Khana platform admins only (admin JWT or `X-Admin-Api-Key`). Clients never see this.',
        responses: { 200: okData('SaasAdTipsClientsResponse') },
      }),
    },
    [`${s}/admin/meta/ad-tips/{clientId}`]: {
      get: op('get', ADMIN, "Rule-based tips on one client's ads", [{ bearerAuth: [] }, { saasAdminApiKey: [] }], {
        description:
          'Khana platform admins only. Reads the client account with `ads_read` (read-only; no ads created) and runs `services/saas/adTipsRules.js`. Thresholds live in `config/adTipsThresholds.js`. Money rules are skipped for non-ZAR accounts.',
        parameters: [paramClientId, ...insightsQuery],
        responses: { 200: okData('SaasAdTipsResponse'), 400: J.badRequest },
      }),
    },
  };
}

/** Shared bits for the other `/saas` builders below (same conventions as `buildSaasMetaPaths`). */
const SAAS_ROLES = {
  all: ' Roles: owner, manager, operator, viewer.',
  ops: ' Roles: owner, manager, operator.',
  write: ' Roles: owner, manager.',
  billingAll: ' Roles: owner, manager, billing_admin, viewer, operator.',
  billingRead: ' Roles: owner, manager, billing_admin, viewer.',
};
const SAAS_ADMIN = [{ bearerAuth: [] }, { saasAdminApiKey: [] }];
const SAAS_ADMIN_NOTE = 'Khana platform admins only (admin JWT or `X-Admin-Api-Key`).';
const pathParam = (name, description) => ({ name, in: 'path', required: true, schema: { type: 'string' }, description });
const queryParam = (name, schema, description) => ({ name, in: 'query', schema, ...(description ? { description } : {}) });
const printParams = [
  queryParam('print', { type: 'string', enum: ['1'] }, '`1` returns printable HTML instead of JSON.'),
  queryParam('format', { type: 'string', enum: ['html'] }, 'Same as `print=1`.'),
];
const htmlOrJson = (schemaName) => ({
  description: 'JSON `{ ok, data }`, or `text/html` when `print=1` / `format=html`.',
  content: {
    'application/json': { schema: schemaRef(schemaName) },
    'text/html': { schema: { type: 'string' } },
  },
});

/**
 * WhatsApp Cloud API setup, templates, Flows, conversions and test sends (`routes/saas.js`).
 * Tenant from the Bearer JWT; role from the team member. Responses `{ ok, data }`.
 */
function buildSaasWhatsAppPaths(a) {
  const s = `${a}/saas/whatsapp`;
  const T = 'SaaS · WhatsApp';
  const { all, ops, write } = SAAS_ROLES;
  return {
    [`${s}/accounts`]: {
      post: op('post', T, 'Save Cloud API credentials (manual connect)', B, {
        description: `Encrypts the token, disables the client's other active numbers, subscribes the app to the WABA and links a Conversions dataset. **409** when the number is active for another client.${ops}`,
        ...jsonBody('SaasWhatsAppAccountBody', 'WABA, phone number id and access token'),
        responses: { 201: J.created, 400: J.badRequest, 409: jsonErr('Number connected to another client') },
      }),
    },
    [`${s}/accounts/disconnect`]: {
      post: op('post', T, 'Disconnect the Cloud API number', B, { description: write.trim() }),
    },
    [`${s}/setup`]: {
      get: op('get', T, 'Webhook callback URL, required templates and onboarding steps', B, {
        description: `\`verifyToken\` is only filled for owner/manager.${all}`,
      }),
    },
    [`${s}/embedded-signup/config`]: {
      get: op('get', T, 'Public Embedded Signup config (app id, config id)', B, { description: all.trim() }),
    },
    [`${s}/embedded-signup/complete`]: {
      post: op('post', T, 'Finish Meta Embedded Signup', B, {
        description: `Exchanges the code, saves the WABA, subscribes webhooks and registers the number.${write}`,
        ...jsonBody('SaasWhatsAppEmbeddedSignupBody', 'Code from the Embedded Signup popup'),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/register`]: {
      post: op('post', T, 'Re-register the Cloud API phone number', B, {
        description: `Use when auto-register failed during signup.${write}`,
        ...jsonBody('SaasWhatsAppRegisterBody', 'Optional 6-digit two-step PIN'),
      }),
    },
    [`${s}/account`]: {
      get: op('get', T, 'Active Cloud API account (no token)', B, {
        description: `\`data\` is \`null\` when nothing is connected.${all}`,
      }),
    },
    [`${s}/conversions/status`]: {
      get: op('get', T, 'Conversions API dataset status', B, { description: all.trim() }),
    },
    [`${s}/conversions/dataset`]: {
      post: op('post', T, "Create or bind the WABA's Conversions dataset", B, {
        description: `Body \`{ force? }\` (default true).${ops}`,
        responses: { 500: J.serverError },
      }),
    },
    [`${s}/conversions/decommission`]: {
      post: op('post', T, 'Unlink the Conversions dataset', B, { description: write.trim() }),
    },
    [`${s}/conversions/test-event`]: {
      post: op('post', T, 'Send a Conversions API test event', B, {
        description: ops.trim(),
        ...jsonBody('SaasWhatsAppConversionTestBody', 'Event to send'),
        responses: { 500: J.serverError },
      }),
    },
    [`${s}/status`]: {
      get: op('get', T, 'Notification readiness (toggle, sender, credits) and owner alert settings', B, {
        description: `Sends never fall back to Khana's WABA, so \`usingKhanaFallback\` is always false.${all}`,
        responses: { 200: jsonResponse('SaasWhatsAppStatusResponse') },
      }),
    },
    [`${s}/notifications`]: {
      put: op('put', T, 'Customer notifications toggle and owner alert settings', B, {
        description: `Every field is optional; only the ones sent change. **400** when nothing is sent or a value is invalid.${write}`,
        ...jsonBody('SaasWhatsAppNotificationsBody', 'Fields to change'),
        responses: { 400: J.badRequest, 404: J.notFound },
      }),
    },
    [`${s}/templates`]: {
      get: op('get', T, 'Synced message templates', B, {
        description: all.trim(),
        parameters: [queryParam('status', { type: 'string', example: 'APPROVED' })],
      }),
      post: op('post', T, 'Submit a template to Meta for approval', B, {
        description: `Send a \`starter\` id, or a custom \`name\` + \`body\` (or raw \`components\`).${write}`,
        ...jsonBody('SaasWhatsAppTemplateCreateBody', 'Starter id or custom template'),
        responses: { 201: J.created, 400: J.badRequest },
      }),
      delete: op('delete', T, 'Delete a template on Meta', B, {
        description: `\`name\` and \`language\` from the body or query.${write}`,
        parameters: [queryParam('name', { type: 'string' }), queryParam('language', { type: 'string' })],
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/templates/starters`]: {
      get: op('get', T, 'Built-in template starters', B, { description: all.trim() }),
    },
    [`${s}/templates/sync`]: {
      post: op('post', T, 'Pull templates and statuses from Meta', B, { description: ops.trim() }),
    },
    [`${s}/templates/coach`]: {
      post: op('post', T, 'Check a template draft before submitting', B, {
        description: `Returns issues and tips (\`helpers/whatsappTemplateCoach.js\`). Nothing is sent to Meta.${all}`,
        ...jsonBody('SaasWhatsAppTemplateCoachBody', 'Template draft'),
      }),
    },
    [`${s}/templates/pack`]: {
      post: op('post', T, 'Install the Khana template pack', B, {
        description: write.trim(),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/health`]: {
      get: op('get', T, 'Number quality and messaging health', B, { description: all.trim() }),
    },
    [`${s}/broadcasts/estimate`]: {
      post: op('post', T, 'Estimate credits for a broadcast', B, {
        description: all.trim(),
        ...jsonBody('SaasWhatsAppBroadcastEstimateBody', 'Recipient count and message type'),
      }),
    },
    [`${s}/messages/test-to-me`]: {
      post: op('post', T, 'Send a template to your own number', B, {
        description: `Body \`{ to?, templateName? (default hello_world), language? }\`.${write}`,
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/messages/template`]: {
      post: op('post', T, 'Send a template message (billed)', B, {
        description: `Deducts credits. Supports \`Idempotency-Key\`.${ops}`,
        parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
        ...jsonBody('SaasWhatsAppTemplateSendBody', 'Recipient and template'),
        responses: { 202: jsonResponse('FlexibleJson', 'Accepted') },
      }),
    },
    [`${s}/messages/test`]: {
      post: op('post', T, 'Send a sample Khana notification template', B, {
        description: `Fills the template with test data (order TEST-001, booking TEST-BK, code 123456).${ops}`,
        ...jsonBody('SaasWhatsAppTestSendBody', 'Recipient and template'),
        responses: { 202: jsonResponse('FlexibleJson', 'Accepted'), 400: J.badRequest },
      }),
    },
    [`${s}/audit`]: {
      get: op('get', T, 'Template and setup audit log', B, {
        description: all.trim(),
        parameters: [queryParam('limit', { type: 'integer', default: 40, maximum: 100 })],
      }),
    },
    [`${s}/flows/starters`]: {
      get: op('get', T, 'Built-in Flow starters (booking, leads, contact)', B, { description: all.trim() }),
    },
    [`${s}/flows`]: {
      get: op('get', T, 'Flows on the WABA', B, { description: all.trim() }),
      post: op('post', T, 'Create a Flow from a starter', B, {
        description: write.trim(),
        ...jsonBody('SaasWhatsAppFlowCreateBody', 'Starter id'),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/flows/sync`]: {
      post: op('post', T, 'Pull Flows from Meta', B, { description: ops.trim(), responses: { 400: J.badRequest } }),
    },
    [`${s}/flows/send`]: {
      post: op('post', T, 'Send a Flow message', B, {
        description: ops.trim(),
        ...jsonBody('SaasWhatsAppFlowSendBody', 'Recipient and Flow'),
        responses: { 202: jsonResponse('FlexibleJson', 'Accepted'), 400: J.badRequest },
      }),
    },
    [`${s}/flows/{flowId}/publish`]: {
      post: op('post', T, 'Publish a draft Flow', B, {
        description: write.trim(),
        parameters: [pathParam('flowId', 'Meta Flow id.')],
        responses: { 400: J.badRequest },
      }),
    },
  };
}

/** WhatsApp shared inbox: threads, notes, replies, broadcasts, auto-rules, canned replies. */
function buildSaasWhatsAppInboxPaths(a) {
  const s = `${a}/saas/whatsapp/inbox`;
  const T = 'SaaS · WhatsApp inbox';
  const { all, ops, write } = SAAS_ROLES;
  const contact = pathParam('contactWaId', 'Contact WhatsApp number (digits or E.164).');
  const accepted = { 202: jsonResponse('FlexibleJson', 'Accepted') };
  return {
    [`${s}/threads`]: {
      get: op('get', T, 'List conversation threads', B, {
        description: all.trim(),
        parameters: [
          queryParam('limit', { type: 'integer', default: 40 }),
          queryParam('q', { type: 'string' }, 'Search text (alias `search`).'),
          queryParam('stage', { type: 'string', enum: ['open', 'waiting', 'closed'] }),
          queryParam('label', { type: 'string' }),
          queryParam('assignee', { type: 'string' }),
          queryParam('unread', { type: 'string', enum: ['1', 'true'] }, 'Only unread threads (alias `unread_only=true`).'),
        ],
      }),
    },
    [`${s}/threads/{contactWaId}`]: {
      get: op('get', T, 'Messages in one thread', B, {
        description: all.trim(),
        parameters: [contact, queryParam('limit', { type: 'integer', default: 100 })],
      }),
      patch: op('patch', T, 'Update thread stage, labels or marketing opt-out', B, {
        description: ops.trim(),
        parameters: [contact],
        ...jsonBody('SaasWhatsAppThreadMetaBody', 'Fields to change'),
        responses: { 400: J.badRequest },
      }),
      delete: op('delete', T, 'Delete a thread from the inbox', B, { description: ops.trim(), parameters: [contact] }),
    },
    [`${s}/threads/{contactWaId}/notes`]: {
      get: op('get', T, 'Internal notes on a thread', B, { description: all.trim(), parameters: [contact] }),
      post: op('post', T, 'Add an internal note', B, {
        description: `Author comes from the team session.${ops}`,
        parameters: [contact],
        ...jsonBody('SaasWhatsAppThreadNoteBody', 'Note text'),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/threads/{contactWaId}/notes/{noteId}`]: {
      delete: op('delete', T, 'Delete a note', B, {
        description: `Operators can only delete their own notes.${ops}`,
        parameters: [contact, pathParam('noteId')],
      }),
    },
    [`${s}/threads/{contactWaId}/assign`]: {
      put: op('put', T, 'Assign a thread to a team member', B, {
        description: `Body \`{ member_id }\` (alias \`memberId\`); empty unassigns.${ops}`,
        parameters: [contact],
      }),
    },
    [`${s}/threads/{contactWaId}/template`]: {
      post: op('post', T, 'Send a template into a thread', B, {
        description: `For contacts outside the 24-hour window. Supports \`Idempotency-Key\`.${ops}`,
        parameters: [contact, { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
        ...jsonBody('SaasWhatsAppInboxTemplateBody', 'Template to send'),
        responses: accepted,
      }),
    },
    [`${s}/contacts/{contactWaId}/customer`]: {
      post: op('post', T, 'Create a store customer from a WhatsApp contact', B, {
        description: ops.trim(),
        parameters: [contact],
        ...jsonBody('SaasWhatsAppCustomerBody', 'Optional names and email'),
        responses: { 201: J.created },
      }),
    },
    [`${s}/contact-context/{contactWaId}`]: {
      get: op('get', T, 'Customer, orders and bookings linked to a contact', B, { description: all.trim(), parameters: [contact] }),
    },
    [`${s}/customers/{customerId}`]: {
      get: op('get', T, 'Customer summary', B, { description: all.trim(), parameters: [pathParam('customerId')] }),
      put: op('put', T, 'Edit a customer from the inbox', B, {
        description: ops.trim(),
        parameters: [pathParam('customerId')],
        ...jsonBody('SaasWhatsAppCustomerBody', 'Fields to change'),
      }),
    },
    [`${s}/messages/{wamid}/media`]: {
      get: op('get', T, 'Download message media (proxied from Meta)', B, {
        description: `Binary body with the media's own \`Content-Type\`.${all}`,
        parameters: [pathParam('wamid', 'WhatsApp message id.')],
        responses: { 200: { description: 'Media file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } },
      }),
    },
    [`${s}/messages/{wamid}`]: {
      delete: op('delete', T, 'Delete a message from the inbox', B, {
        description: ops.trim(),
        parameters: [pathParam('wamid', 'WhatsApp message id.')],
      }),
    },
    [`${s}/reply`]: {
      post: op('post', T, 'Send a text reply', B, {
        description: `Only inside the 24-hour window.${ops}`,
        ...jsonBody('SaasWhatsAppInboxReplyBody', 'Recipient and text'),
        responses: accepted,
      }),
    },
    [`${s}/product`]: {
      post: op('post', T, 'Share a store product', B, {
        description: `Body \`{ to, productId }\` (aliases \`contact_wa_id\`, \`product_id\`).${ops}`,
        responses: accepted,
      }),
    },
    [`${s}/media`]: {
      post: op('post', T, 'Send a file (max 16 MB)', B, {
        description: ops.trim(),
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file', 'to'],
                properties: {
                  file: { type: 'string', format: 'binary' },
                  to: { type: 'string', description: 'Alias `contact_wa_id`.' },
                  caption: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { ...accepted, 400: J.badRequest },
      }),
    },
    [`${s}/stats`]: {
      get: op('get', T, 'Inbox stats', B, { description: all.trim(), parameters: [queryParam('days', { type: 'integer', default: 30 })] }),
    },
    [`${s}/unread`]: {
      get: op('get', T, 'Unread summary', B, { description: all.trim() }),
    },
    [`${s}/mine`]: {
      get: op('get', T, 'Chats assigned to me', B, { description: `Returns \`{ chats, count, unread }\`.${all}` }),
    },
    [`${s}/assignees`]: {
      get: op('get', T, 'Team members a thread can be assigned to', B, { description: all.trim() }),
    },
    [`${s}/window-alerts`]: {
      get: op('get', T, 'Threads whose 24-hour window is closing (dry run)', B, { description: all.trim() }),
    },
    [`${s}/window-alerts/run`]: {
      post: op('post', T, 'Send window-closing alerts now', B, { description: write.trim() }),
    },
    [`${s}/auto-rules`]: {
      get: op('get', T, 'Keyword auto-reply rules', B, { description: all.trim() }),
      post: op('post', T, 'Create an auto-reply rule', B, {
        description: ops.trim(),
        ...jsonBody('SaasWhatsAppAutoRuleBody', 'Rule'),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/auto-rules/{id}`]: {
      patch: op('patch', T, 'Update an auto-reply rule', B, {
        description: ops.trim(),
        parameters: [paramId],
        ...jsonBody('SaasWhatsAppAutoRuleBody', 'Fields to change'),
        responses: { 400: J.badRequest, 404: J.notFound },
      }),
      delete: op('delete', T, 'Delete an auto-reply rule', B, { description: ops.trim(), parameters: [paramId] }),
    },
    [`${s}/broadcasts`]: {
      get: op('get', T, 'Broadcasts', B, { description: all.trim() }),
      post: op('post', T, 'Queue a template broadcast (max 200 recipients)', B, {
        description: `Template must be approved and synced, or a built-in inbox template.${ops}`,
        ...jsonBody('SaasWhatsAppBroadcastBody', 'Template and recipients'),
        responses: { ...accepted, 400: J.badRequest },
      }),
    },
    [`${s}/broadcasts/{id}`]: {
      get: op('get', T, 'One broadcast with progress', B, { description: all.trim(), parameters: [paramId] }),
    },
    [`${s}/canned`]: {
      get: op('get', T, 'Canned replies', B, { description: all.trim() }),
      post: op('post', T, 'Create a canned reply', B, {
        description: ops.trim(),
        ...jsonBody('SaasWhatsAppCannedReplyBody', 'Canned reply'),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/canned/{id}`]: {
      delete: op('delete', T, 'Delete a canned reply', B, { description: ops.trim(), parameters: [paramId] }),
    },
  };
}

/** CRM workspace: pipeline board, opportunities, tasks, vertical templates. */
function buildSaasCrmPaths(a) {
  const s = `${a}/saas/crm`;
  const T = 'SaaS · CRM';
  const { all, ops, write } = SAAS_ROLES;
  return {
    [`${s}/board`]: {
      get: op('get', T, 'Pipeline board (stages, opportunities, stats)', B, { description: all.trim() }),
    },
    [`${s}/stages`]: {
      put: op('put', T, 'Replace the pipeline stages', B, {
        description: write.trim(),
        ...jsonBody('SaasCrmStagesBody', 'Full stage list'),
      }),
    },
    [`${s}/opportunities`]: {
      post: op('post', T, 'Create an opportunity', B, {
        description: ops.trim(),
        ...jsonBody('SaasCrmOpportunityBody', '`title` is required'),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/opportunities/{id}`]: {
      patch: op('patch', T, 'Update an opportunity', B, {
        description: `Only \`title\`, \`stage_id\`, \`priority\`, \`status\`, \`value\`, \`notes\`, \`customer_*\` and \`owner_name\` can change.${ops}`,
        parameters: [paramId],
        ...jsonBody('SaasCrmOpportunityBody', 'Fields to change'),
      }),
    },
    [`${s}/tasks`]: {
      get: op('get', T, 'Tasks', B, {
        description: all.trim(),
        parameters: [
          queryParam('status', { type: 'string', enum: ['open', 'completed', 'cancelled'] }),
          queryParam('due', { type: 'string', enum: ['today', 'overdue', 'upcoming'] }, '`overdue` and `upcoming` only return open tasks.'),
        ],
      }),
      post: op('post', T, 'Create a task', B, {
        description: ops.trim(),
        ...jsonBody('SaasCrmTaskBody', '`title` is required'),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/tasks/{id}`]: {
      patch: op('patch', T, 'Update a task', B, {
        description: ops.trim(),
        parameters: [paramId],
        ...jsonBody('SaasCrmTaskBody', 'Fields to change'),
      }),
    },
    [`${s}/templates`]: {
      get: op('get', T, 'Industry pipeline templates', B, { description: all.trim() }),
    },
    [`${s}/templates/apply`]: {
      post: op('post', T, 'Apply an industry template', B, {
        description: `Replaces the stages and adds the template's starter tasks.${write}`,
        ...jsonBody('SaasCrmApplyTemplateBody', 'Vertical'),
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/export.csv`]: {
      get: op('get', T, 'Export opportunities or tasks as CSV', B, {
        description: all.trim(),
        parameters: [queryParam('type', { type: 'string', enum: ['opportunities', 'tasks'], default: 'opportunities' })],
        responses: { 200: { description: 'CSV file', content: { 'text/csv': { schema: { type: 'string' } } } } },
      }),
    },
    [`${s}/reminders/run`]: {
      post: op('post', T, 'Send due task reminders now', B, { description: write.trim() }),
    },
  };
}

/** Khana credits: balance, packs, EFT top-ups, invoices and statements, plus the public PayFast ITN. */
function buildSaasBillingPaths(a) {
  const s = `${a}/saas/billing`;
  const T = 'SaaS · Billing';
  const { write, billingAll, billingRead } = SAAS_ROLES;
  const reference = pathParam('reference', 'Invoice / transaction reference.');
  const range = [
    queryParam('from', { type: 'string', format: 'date' }),
    queryParam('to', { type: 'string', format: 'date' }),
  ];
  return {
    [s]: {
      get: op('get', T, 'Credit balance, recent transactions, WhatsApp usage and pricing', B, {
        description: `Tops up the month's included credits first if due.${billingAll}`,
      }),
    },
    [`${s}/credit-packs`]: {
      get: op('get', T, 'Prepaid credit packs', B, { description: billingAll.trim() }),
    },
    [`${s}/payfast/itn`]: {
      post: op('post', T, 'PayFast ITN for credit top-ups (public)', P, {
        description: 'Called by PayFast. Signature-checked in `PayFastCreditsService.handleTopupItn`. Always answers 200; `ok: false` means the ITN was rejected.',
        requestBody: {
          required: true,
          content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', additionalProperties: true } } },
        },
        responses: { 200: J.ok },
      }),
    },
    [`${s}/eft/request`]: {
      post: op('post', T, 'Request an EFT top-up', B, {
        description: `Credits stay pending until a Khana admin confirms payment.${write}`,
        ...jsonBody('SaasEftRequestBody', 'Pack or amount'),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/eft/requests`]: {
      get: op('get', T, 'My EFT top-up requests', B, {
        description: billingRead.trim(),
        parameters: [queryParam('limit', { type: 'integer', default: 20 })],
      }),
    },
    [`${s}/eft/mark-paid`]: {
      post: op('post', T, "Tell Khana you've paid an EFT", B, {
        description: write.trim(),
        ...jsonBody('SaasEftReferenceBody', 'EFT reference'),
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/eft/cancel`]: {
      post: op('post', T, 'Cancel a pending EFT request', B, {
        description: write.trim(),
        ...jsonBody('SaasEftReferenceBody', 'EFT reference'),
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/invoices`]: {
      get: op('get', T, 'Invoices', B, {
        description: billingRead.trim(),
        parameters: [queryParam('limit', { type: 'integer', default: 50 })],
      }),
    },
    [`${s}/invoices/{reference}`]: {
      get: op('get', T, 'One invoice (JSON or printable HTML)', B, {
        description: billingRead.trim(),
        parameters: [reference, ...printParams],
        responses: { 200: htmlOrJson('FlexibleJson') },
      }),
    },
    [`${s}/statement`]: {
      get: op('get', T, 'Account statement (JSON or printable HTML)', B, {
        description: billingRead.trim(),
        parameters: [...range, ...printParams],
        responses: { 200: htmlOrJson('FlexibleJson') },
      }),
    },
    [`${s}/topup/manual`]: {
      post: op('post', T, 'Record a manual top-up on this workspace', B, {
        description: `With \`pack_id\` credits follow the pack; otherwise \`credits\` at list rate. **403** if \`client_id\` is another workspace.${write}`,
        ...jsonBody('SaasManualTopupBody', 'Pack or credits'),
      }),
    },
  };
}

/** Khana admin tools under `/saas/admin` (ad tips are in `buildSaasMetaPaths`). */
function buildSaasAdminPaths(a) {
  const s = `${a}/saas/admin`;
  const T = 'SaaS · Admin';
  const N = SAAS_ADMIN_NOTE;
  const clientQuery = queryParam('client_id', { type: 'string' }, 'Alias `clientId`.');
  const accepted = { 202: jsonResponse('FlexibleJson', 'Accepted') };
  return {
    [`${s}/billing/eft/pending`]: {
      get: op('get', T, 'Pending EFT top-ups across clients', SAAS_ADMIN, {
        description: N,
        parameters: [clientQuery, queryParam('limit', { type: 'integer', default: 50 })],
      }),
    },
    [`${s}/billing/eft/confirm`]: {
      post: op('post', T, 'Confirm an EFT payment and release the credits', SAAS_ADMIN, {
        description: N,
        ...jsonBody('SaasEftReferenceBody', 'EFT reference'),
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/billing/invoices/{reference}`]: {
      get: op('get', T, 'Any invoice by reference', SAAS_ADMIN, {
        description: N,
        parameters: [pathParam('reference'), ...printParams],
        responses: { 200: htmlOrJson('FlexibleJson') },
      }),
    },
    [`${s}/billing/statement/{clientId}`]: {
      get: op('get', T, "A client's statement", SAAS_ADMIN, {
        description: N,
        parameters: [paramClientId, queryParam('from', { type: 'string', format: 'date' }), queryParam('to', { type: 'string', format: 'date' }), ...printParams],
        responses: { 200: htmlOrJson('FlexibleJson') },
      }),
    },
    [`${s}/billing/topup`]: {
      post: op('post', T, 'Credit any client', SAAS_ADMIN, {
        description: `${N} For EFTs confirmed offline or goodwill credits.`,
        ...jsonBody('SaasAdminTopupBody', 'Client and pack or credits'),
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/pricing`]: {
      get: op('get', T, 'All pricing rules', SAAS_ADMIN, { description: N }),
      post: op('post', T, 'Add a pricing rule', SAAS_ADMIN, {
        description: N,
        ...jsonBody('SaasPricingRuleBody', 'Rule'),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/whatsapp/messages/sandbox-phones`]: {
      post: op('post', T, 'List phone numbers on a sandbox WABA', SAAS_ADMIN, {
        description: `${N} Body \`{ waba_id?, access_token? }\`; blanks fall back to env.`,
      }),
    },
    [`${s}/whatsapp/messages/sandbox-validate`]: {
      post: op('post', T, 'Check sandbox credentials', SAAS_ADMIN, {
        description: `${N} Body \`{ phone_number_id?, access_token? }\`.`,
      }),
    },
    [`${s}/whatsapp/messages/sandbox-test`]: {
      post: op('post', T, 'Send a template from the sandbox number', SAAS_ADMIN, {
        description: `${N} Recipient must be on the Meta test allow-list.`,
        ...jsonBody('SaasAdminSandboxTestBody', 'Recipient, credentials and template'),
        responses: { ...accepted, 400: J.badRequest },
      }),
    },
    [`${s}/whatsapp/messages/test`]: {
      post: op('post', T, "Send a sample notification from a client's number", SAAS_ADMIN, {
        description: N,
        ...jsonBody('SaasAdminWhatsAppTestBody', 'Recipient, client and template'),
        responses: { ...accepted, 400: J.badRequest },
      }),
    },
    [`${s}/whatsapp/inbox/reprocess`]: {
      post: op('post', T, 'Re-run archived webhooks through the inbox', SAAS_ADMIN, {
        description: `${N} Body \`{ limit? (50), onlyUnprocessed? (true) }\`.`,
      }),
    },
    [`${s}/whatsapp/inbox/window-alerts/run`]: {
      post: op('post', T, 'Run window-closing alerts for all clients (or one)', SAAS_ADMIN, {
        description: `${N} Body \`{ clientId? }\`.`,
      }),
    },
    [`${s}/whatsapp/register`]: {
      post: op('post', T, "Register a client's Cloud API number", SAAS_ADMIN, {
        description: `${N} Body \`{ client_id? (default Khana), pin? }\`.`,
      }),
    },
    [`${s}/whatsapp-usage`]: {
      get: op('get', T, 'WhatsApp usage, billing and failures across clients', SAAS_ADMIN, {
        description: N,
        parameters: [queryParam('days', { type: 'integer', default: 30, minimum: 1, maximum: 365 })],
      }),
    },
    [`${s}/api-monitor/summary`]: {
      get: op('get', T, 'Meta / WhatsApp API monitor summary (all clients or one)', SAAS_ADMIN, {
        description: N,
        parameters: [clientQuery, queryParam('days', { type: 'integer', default: 7, minimum: 1, maximum: 90 })],
      }),
    },
    [`${s}/api-monitor/events`]: {
      get: op('get', T, 'API monitor events', SAAS_ADMIN, {
        description: N,
        parameters: [clientQuery, ...saasMonitorEventQuery()],
      }),
    },
  };
}

function saasMonitorEventQuery() {
  return [
    queryParam('days', { type: 'integer', default: 7, minimum: 1, maximum: 90 }),
    queryParam('integration', {
      type: 'string',
      enum: ['meta_oauth', 'meta_ads', 'meta_graph', 'whatsapp_cloud', 'whatsapp_capi', 'whatsapp_inbox', 'system'],
    }),
    queryParam('outcome', { type: 'string', enum: ['success', 'warning', 'error'] }),
    queryParam('cause', { type: 'string', example: 'permission_denied' }),
    queryParam('limit', { type: 'integer', default: 50, maximum: 200 }),
  ];
}

/** Public Meta webhooks (registered before `tenantResolver`). */
function buildSaasWebhookPaths(a) {
  const s = `${a}/saas/webhooks`;
  const T = 'SaaS · Webhooks';
  const challenge = (name) =>
    op('get', T, `Meta webhook verification for ${name} (public)`, P, {
      description: 'Echoes `hub.challenge` when `hub.verify_token` matches.',
      parameters: [
        queryParam('hub.mode', { type: 'string', example: 'subscribe' }),
        queryParam('hub.verify_token', { type: 'string' }),
        queryParam('hub.challenge', { type: 'string' }),
      ],
      responses: { 200: { description: 'The challenge as plain text', content: { 'text/plain': { schema: { type: 'string' } } } } },
    });
  const signed = { name: 'X-Hub-Signature-256', in: 'header', required: true, schema: { type: 'string' }, description: '`sha256=` HMAC of the raw body with the app secret.' };
  const metaBody = { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } };
  return {
    [`${s}/whatsapp`]: {
      get: challenge('WhatsApp'),
      post: op('post', T, 'WhatsApp Cloud API events (public, signed)', P, {
        description: 'Messages, Business-app echoes, delivery statuses and template status updates. Archived before ingest; always answers 200 `{ ok, received }`.',
        parameters: [signed],
        requestBody: metaBody,
      }),
    },
    [`${s}/meta-ads`]: {
      get: challenge('Meta ads'),
      post: op('post', T, 'Meta ads events (public, signed)', P, {
        description: 'Acknowledged only; nothing is processed yet.',
        parameters: [signed],
        requestBody: metaBody,
      }),
    },
  };
}

/** Workspace overview and the client's own API monitor. */
function buildSaasOverviewPaths(a) {
  const s = `${a}/saas`;
  const T = 'SaaS · Overview';
  const { write, billingAll } = SAAS_ROLES;
  return {
    [`${s}/overview`]: {
      get: op('get', T, 'Credits, connected accounts and plan', B, { description: billingAll.trim() }),
    },
    [`${s}/api-monitor/summary`]: {
      get: op('get', T, 'Meta / WhatsApp API health for this client', B, {
        description: write.trim(),
        parameters: [queryParam('days', { type: 'integer', default: 7, minimum: 1, maximum: 90 })],
      }),
    },
    [`${s}/api-monitor/events`]: {
      get: op('get', T, 'API monitor events for this client', B, {
        description: write.trim(),
        parameters: saasMonitorEventQuery(),
      }),
    },
  };
}

/** Instagram Login and organic Facebook/Instagram publishing and scheduling under `/saas/meta`. */
function buildSaasSocialPaths(a) {
  const s = `${a}/saas/meta`;
  const T = 'SaaS · Social posts';
  const { all, write } = SAAS_ROLES;
  const limit = [queryParam('limit', { type: 'integer' })];
  const filesUpload = (extra = {}) => ({
    required: true,
    content: {
      'multipart/form-data': {
        schema: {
          type: 'object',
          required: ['files'],
          properties: {
            files: { type: 'array', maxItems: 10, items: { type: 'string', format: 'binary' }, description: 'Images or videos, up to 100 MB each.' },
            ...extra,
          },
        },
      },
    },
  });
  return {
    [`${s}/instagram/oauth/start`]: {
      get: op('get', T, 'Instagram Login URL (no Facebook Page needed)', B, { description: `Returns \`{ url, debug }\`.${write}` }),
    },
    [`${s}/instagram/oauth/callback`]: {
      get: op('get', T, 'Instagram OAuth redirect (public)', P, {
        description: 'Client is read from the signed `state`. Redirects back to the dashboard with `instagram=connected` or `instagram=error`.',
        parameters: ['code', 'state', 'error', 'error_reason', 'error_description'].map((n) => queryParam(n, { type: 'string' })),
        responses: { 302: { description: 'Redirect to the dashboard' } },
      }),
    },
    [`${s}/instagram/oauth/complete`]: {
      post: op('post', T, 'Finish Instagram OAuth from the dashboard (public)', P, {
        description: 'Same exchange as the callback, for a dashboard-hosted redirect URI.',
        ...jsonBody('SaasMetaOAuthCompleteBody', 'OAuth code and signed state'),
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/instagram/oauth/status`]: {
      get: op('get', T, 'Instagram Login connection status', B, { description: all.trim() }),
    },
    [`${s}/instagram/oauth/disconnect`]: {
      post: op('post', T, 'Disconnect Instagram Login', B, { description: write.trim() }),
    },
    [`${s}/organic-posts`]: {
      get: op('get', T, 'Recent organic Page and Instagram posts', B, { description: all.trim(), parameters: limit }),
    },
    [`${s}/instagram/media`]: {
      get: op('get', T, 'Recent Instagram media', B, { description: all.trim(), parameters: limit }),
    },
    [`${s}/publish`]: {
      post: op('post', T, 'Publish now to Facebook and/or Instagram', B, {
        description: `Media must be public URLs (see \`/meta/instagram/upload\`).${write}`,
        ...jsonBody('SaasSocialPublishBody', 'Destinations, media and caption'),
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/facebook/publish`]: {
      post: op('post', T, 'Publish now to the Facebook Page', B, {
        description: `\`destinations\` is ignored.${write}`,
        ...jsonBody('SaasSocialPublishBody', 'Media and caption'),
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/instagram/publish`]: {
      post: op('post', T, 'Publish now to Instagram', B, {
        description: `\`destinations\` is ignored. Carousels need 2–10 images.${write}`,
        ...jsonBody('SaasSocialPublishBody', 'Media and caption'),
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/instagram/upload`]: {
      post: op('post', T, 'Upload media to public URLs (no publishing)', B, {
        description: `Returns \`{ files, imageUrls, videoUrl }\` to pass to publish or schedule.${write}`,
        requestBody: filesUpload(),
        responses: { 201: J.created, 400: J.badRequest },
      }),
    },
    [`${s}/instagram/publish-upload`]: {
      post: op('post', T, 'Upload and publish to Instagram in one step', B, {
        description: `Videos/Reels go straight to Meta (one file). Images are stored first; 2+ images become a carousel.${write}`,
        requestBody: filesUpload({
          mediaType: { type: 'string', enum: ['IMAGE', 'CAROUSEL', 'VIDEO', 'REELS'], default: 'IMAGE' },
          caption: { type: 'string' },
        }),
        responses: { 400: J.badRequest },
      }),
    },
    [`${s}/social-posts`]: {
      get: op('get', T, 'Last 50 scheduled and published posts', B, { description: all.trim() }),
    },
    [`${s}/social-posts/schedule`]: {
      post: op('post', T, 'Schedule a post', B, {
        description: `\`scheduledFor\` must be at least 30 seconds ahead. **503** when the job scheduler is off.${write}`,
        ...jsonBody('SaasSocialScheduleBody', 'Post and time'),
        responses: { 201: J.created, 400: J.badRequest, 503: jsonErr('Scheduler not running') },
      }),
    },
    [`${s}/social-posts/{id}/schedule`]: {
      delete: op('delete', T, 'Cancel a scheduled post', B, {
        description: write.trim(),
        parameters: [paramId],
        responses: { 404: J.notFound },
      }),
    },
  };
}

function buildPaths(a) {
  return {
    ...buildSaasMetaPaths(a),
    ...buildSaasWhatsAppPaths(a),
    ...buildSaasWhatsAppInboxPaths(a),
    ...buildSaasCrmPaths(a),
    ...buildSaasBillingPaths(a),
    ...buildSaasAdminPaths(a),
    ...buildSaasWebhookPaths(a),
    ...buildSaasOverviewPaths(a),
    ...buildSaasSocialPaths(a),
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
      post: op('post', 'Voting campaigns', 'Create voting campaign', B, {
        description:
          'Create a poll/campaign. Accepts JSON or multipart. Required: `title`, `description`, `campaignType` (`campaign`|`poll`), ISO `startDate`/`endDate`, and at least 2 `items` each with `title`. Item alias `name` is accepted. Codes are one-time-usable per customer elsewhere; this endpoint is campaign creation only.',
        ...jsonBody('VotingCampaignCreateBody', 'Voting campaign create payload'),
        responses: {
          201: jsonResponse('FlexibleJson', 'Created'),
          400: J.badRequest,
          403: J.forbidden,
        },
      }),
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

    [`${a}/admin/site-analytics/clients`]: {
      get: op('get', 'Admin site analytics', 'Client directory (admin JWT + DB role)', B),
    },
    [`${a}/admin/site-analytics/site-activity`]: {
      get: op('get', 'Admin site analytics', 'Site activity time series (TrackingEvent)', B),
    },
    [`${a}/admin/site-analytics/site-activity/compare`]: {
      get: op('get', 'Admin site analytics', 'Site activity + overlapping ad periods', B),
    },
    [`${a}/admin/site-analytics/site-activity/export`]: {
      get: op('get', 'Admin site analytics', 'Download site activity (CSV or JSON)', B),
    },
    [`${a}/admin/site-analytics/ad-periods`]: {
      get: op('get', 'Admin site analytics', 'List saved ad windows', B),
      post: op('post', 'Admin site analytics', 'Save ad window for comparisons', B),
    },
    [`${a}/admin/site-analytics/ad-periods/{id}`]: {
      put: op('put', 'Admin site analytics', 'Update ad window', B, { parameters: [paramId] }),
      delete: op('delete', 'Admin site analytics', 'Remove ad window', B, { parameters: [paramId] }),
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
                  templateId: {
                    type: 'string',
                    enum: ['promo_stack', 'hero_cta', 'announcement', 'product_spotlight', 'blank'],
                    description:
                      'Builder template id (metadata). When `html` is sent from the dashboard, it is validated and used as-is.',
                  },
                  builderPayload: {
                    type: 'string',
                    description:
                      'Optional JSON string of field values used by the builder (stored for reference; also used as fallback promo payload when templateId is promo_stack and html is omitted).',
                  },
                  draftId: {
                    type: 'string',
                    description:
                      'Optional saved draft Mongo id. Loads subject/html/text when those fields are omitted in the send request.',
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
    [`${a}/email/newsletter/templates`]: {
      get: op('get', 'Email', 'List newsletter builder templates (schemas)', B),
    },
    [`${a}/email/newsletter/templates/{templateId}`]: {
      get: op('get', 'Email', 'Get newsletter template incl. htmlStructure starter', B, {
        parameters: [
          {
            name: 'templateId',
            in: 'path',
            required: true,
            schema: {
              type: 'string',
              enum: ['promo_stack', 'hero_cta', 'announcement', 'product_spotlight', 'blank'],
            },
          },
        ],
      }),
    },
    [`${a}/email/newsletter/images`]: {
      post: {
        tags: ['Email'],
        summary: 'Upload newsletter builder image',
        description:
          'Multipart image for use in builder HTML (`image`, `file`, or `photo` field). Uploads to GitHub `public/uploads/` when configured, otherwise serves from `/public/uploads/`. Returns full URL for `<img src>`.',
        security: B,
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  image: { type: 'string', format: 'binary' },
                  file: { type: 'string', format: 'binary' },
                  photo: { type: 'string', format: 'binary' },
                },
              },
            },
          },
        },
        responses: {
          201: jsonResponse('NewsletterImageUploadResponse', 'Image URL for builder'),
          400: J.badRequest,
        },
      },
    },
    [`${a}/email/newsletter/preview`]: {
      post: {
        tags: ['Email'],
        summary: 'Validate builder HTML before send',
        description:
          'Dashboard sends composed HTML; server strips scripts/event handlers and returns sanitized html + plain-text fallback.',
        security: B,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/NewsletterPreviewBody' },
            },
          },
        },
        responses: {
          200: jsonResponse('NewsletterPreviewResponse', 'Sanitized preview'),
          400: J.badRequest,
        },
      },
    },
    [`${a}/email/newsletter/drafts`]: {
      get: op('get', 'Email', 'List newsletter drafts', B),
      post: {
        tags: ['Email'],
        summary: 'Save newsletter draft',
        security: B,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/NewsletterDraftBody' },
            },
          },
        },
        responses: { 201: jsonResponse('NewsletterDraftResponse', 'Draft saved'), 400: J.badRequest },
      },
    },
    [`${a}/email/newsletter/drafts/{id}`]: {
      get: op('get', 'Email', 'Get newsletter draft', B, { parameters: [paramId] }),
      put: {
        tags: ['Email'],
        summary: 'Update newsletter draft',
        security: B,
        parameters: [paramId],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/NewsletterDraftBody' },
            },
          },
        },
        responses: { 200: jsonResponse('NewsletterDraftResponse', 'Draft updated'), 400: J.badRequest, 404: J.notFound },
      },
      delete: op('delete', 'Email', 'Delete newsletter draft', B, { parameters: [paramId] }),
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
    [`${a}/payments/payfast/checkout`]: {
      post: op('post', 'Payments', 'Signed PayFast checkout for an order', B, {
        description:
          'Storefront API token or shopper token. Body `{ orderId, buyer? }` (`buyer`: `name_first`, `name_last`, `email_address`, `cell_number`). Builds the PayFast fields from the order (`amount` = `finalPrice`, `m_payment_id` = order id) and signs them with the business passphrase on the server. Returns `{ success, kind, id, method, action, host, fields }`; POST every key in `fields` unchanged to `action`. 404 unknown/other business, 409 paid/refunded/zero total/PayFast not set up.',
      }),
    },
    [`${a}/payments/payfast/checkout/booking`]: {
      post: op('post', 'Payments', 'Signed PayFast checkout for a booking deposit', B, {
        description:
          'Same as the order checkout, with body `{ bookingId, buyer? }`. `amount` = `payment.depositAmount`, `m_payment_id` = booking id, buyer defaults to the booking name and email.',
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
        name: 'Legal',
        description:
          'Public Merchant Terms, Acceptable Use Policy, and take-down pages at `/terms`, `/aup`, `/legal/takedown`. JSON versions at `/legal/policies.json` and `GET /legal/policies`.',
      },
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
          'IMAP mailbox (`/email`), send/reply/forward, **newsletter builder** (`GET .../newsletter/templates`, `POST .../newsletter/images`, `POST .../newsletter/preview`, draft CRUD), newsletters (**multipart** `POST .../email/newsletter/send` — send dashboard-composed **`html`** or legacy **promoTemplate one** + `promoPayload`), open tracking, public subscribe/unsubscribe.',
      },
      { name: 'Payments', description: 'PayFast ITN (`/payments/payfast/itn`) and related gateway hooks.' },
      {
        name: 'SaaS · Meta ads',
        description:
          'Meta (Facebook/Instagram) ads under `/saas/meta` and `/saas/ads` (`routes/saas.js`). Tenant from the Bearer JWT `clientID`; team role decides read vs write. Responses are `{ ok, data }`. Campaign creates spend real money once active and respect the plan campaign limit.',
      },
      {
        name: 'SaaS · Admin ad tips',
        description:
          'Khana-admin-only coaching for the managed ad service: rule-based tips with severity and the numbers behind each one. Never shown to clients.',
      },
      {
        name: 'SaaS · WhatsApp',
        description:
          'WhatsApp Cloud API under `/saas/whatsapp`: connect (Embedded Signup or manual), templates, Flows, Conversions API, notification settings and test sends. Each client sends from its own number; billed sends deduct Khana credits.',
      },
      {
        name: 'SaaS · WhatsApp inbox',
        description:
          'Shared team inbox under `/saas/whatsapp/inbox`: threads, notes, assignment, replies inside the 24-hour window, templates outside it, broadcasts, keyword auto-replies and canned replies.',
      },
      {
        name: 'SaaS · CRM',
        description:
          'Sales pipeline under `/saas/crm`: stages, opportunities, tasks with reminders, industry templates and CSV export.',
      },
      {
        name: 'SaaS · Billing',
        description:
          'Khana credits under `/saas/billing`: balance, prepaid packs, EFT top-ups, invoices and statements. `/saas/billing/payfast/itn` is the public PayFast callback.',
      },
      {
        name: 'SaaS · Admin',
        description:
          'Khana-admin-only tools under `/saas/admin` (admin JWT or `X-Admin-Api-Key`): EFT confirmation, top-ups, pricing rules, WhatsApp sandbox and usage, API monitor across clients.',
      },
      {
        name: 'SaaS · Webhooks',
        description:
          'Public Meta webhooks under `/saas/webhooks`. GET answers the verify challenge; POST bodies are checked against `X-Hub-Signature-256`.',
      },
      {
        name: 'SaaS · Overview',
        description:
          'Workspace summary (`/saas/overview`) and the Meta / WhatsApp API monitor for the signed-in client (`/saas/api-monitor`).',
      },
      {
        name: 'SaaS · Social posts',
        description:
          'Organic posting under `/saas/meta`: Instagram Login, publish now to Facebook/Instagram, media upload, and scheduled posts (needs the Agenda job scheduler).',
      },
      {
        name: 'Tracking',
        description: 'Browser/event pipeline (`/events`): batch ingest, stats, anonymous linking — see `routes/trackingEvents.js`.',
      },
      {
        name: 'Admin site analytics',
        description:
          'Khana-admin-only site activity under `/admin/site-analytics` (`routes/adminSiteAnalytics.js`): client directory, `TrackingEvent` time series, CSV/JSON export, and saved ad periods to compare traffic against. Needs a platform-admin dashboard session (`middleware/requireAdmin.js`); a plain Bearer token for the admin client is not enough.',
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
          'Cross-tenant administration (`/admin`): client list, nested tokens, per-client counts, permission overrides. **`/admin/site-analytics`** (separate router): requires **admin** role on the Client record; site-wide / per-tenant **TrackingEvent** aggregates, CSV/JSON export, and saved **ad activity periods** for before/after comparisons.',
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
        saasAdminApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Admin-Api-Key',
          description: 'Alternative to an admin JWT on `/saas/admin/*` routes. Must match `SAAS_ADMIN_API_KEY`.',
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
        SaasMetaOAuthCompleteBody: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            state: { type: 'string', description: 'Signed state from `/saas/meta/oauth/start`.' },
            error: { type: 'string' },
            error_description: { type: 'string' },
          },
        },
        SaasMetaAdAccountCreateBody: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            currency: { type: 'string', default: 'ZAR' },
            timezone_id: { type: 'integer', default: 141, description: 'Meta timezone id (141 = Africa/Johannesburg).' },
          },
        },
        SaasMetaSelectionBody: {
          type: 'object',
          properties: { page_id: { type: 'string' }, ad_account_id: { type: 'string', description: 'Without the `act_` prefix.' } },
        },
        SaasMetaCampaignCap: {
          type: 'object',
          properties: {
            plan: { type: 'string', example: 'starter' },
            planLabel: { type: 'string', example: 'Starter' },
            cap: { type: 'integer', nullable: true, example: 5 },
            unlimited: { type: 'boolean' },
            used: { type: 'integer', example: 4 },
            remaining: { type: 'integer', nullable: true, example: 1 },
            reached: { type: 'boolean' },
          },
        },
        SaasMetaSetupResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                checklist: { type: 'object', additionalProperties: { type: 'boolean' } },
                account: { type: 'object', additionalProperties: true },
                paymentHint: { type: 'string' },
                nextSteps: { type: 'array', items: { type: 'string' } },
                campaignCap: { $ref: '#/components/schemas/SaasMetaCampaignCap' },
              },
              additionalProperties: true,
            },
          },
        },
        SaasMetaResultSummary: {
          type: 'object',
          description: 'Spend and delivery totals plus the main result (`helpers/metaAdResults.js`).',
          properties: {
            spend: { type: 'number' },
            impressions: { type: 'number' },
            clicks: { type: 'number' },
            reach: { type: 'number' },
            ctr: { type: 'number', description: 'Percent.' },
            cpc: { type: 'number' },
            cpm: { type: 'number' },
            frequency: { type: 'number' },
            results: { type: 'number' },
            resultLabel: { type: 'string', example: 'Chats started' },
            resultSingular: { type: 'string', example: 'chat' },
            resultKey: { type: 'string', enum: ['chats', 'purchases', 'leads', 'signups', 'link_clicks', 'engagements', 'none'] },
            costPerResult: { type: 'number', nullable: true },
            conversionsTracked: { type: 'boolean' },
          },
        },
        SaasMetaDailyRow: {
          type: 'object',
          properties: {
            date: { type: 'string', format: 'date' },
            spend: { type: 'number' },
            impressions: { type: 'number' },
            clicks: { type: 'number' },
            reach: { type: 'number' },
            results: { type: 'number' },
          },
        },
        SaasMetaInsightsResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                adAccountId: { type: 'string' },
                adAccountName: { type: 'string' },
                label: { type: 'string', example: 'Last 30 days' },
                since: { type: 'string', format: 'date' },
                until: { type: 'string', format: 'date' },
                currency: { type: 'string', example: 'ZAR' },
                account: { $ref: '#/components/schemas/SaasMetaResultSummary' },
                campaigns: {
                  type: 'array',
                  items: {
                    allOf: [
                      { $ref: '#/components/schemas/SaasMetaResultSummary' },
                      { type: 'object', properties: { campaignId: { type: 'string' }, name: { type: 'string' } } },
                    ],
                  },
                },
                daily: { type: 'array', items: { $ref: '#/components/schemas/SaasMetaDailyRow' } },
                warnings: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        SaasMetaCampaignStatusBody: {
          type: 'object',
          required: ['status'],
          properties: { status: { type: 'string', enum: ['active', 'paused', 'archived', 'deleted'], description: 'Case-insensitive.' } },
        },
        SaasMetaCampaignBudgetBody: {
          type: 'object',
          required: ['daily_budget'],
          properties: { daily_budget: { type: 'number', example: 50, description: 'Account currency (e.g. rand), not cents.' } },
        },
        SaasMetaTargetingInput: {
          type: 'object',
          description: 'Optional targeting; anything left out uses SA defaults.',
          properties: {
            countries: { type: 'array', items: { type: 'string' }, example: ['ZA'] },
            cities: { type: 'array', items: { type: 'object', additionalProperties: true } },
            regions: { type: 'array', items: { type: 'object', additionalProperties: true } },
            age_min: { type: 'integer', example: 18 },
            age_max: { type: 'integer', example: 65 },
            genders: { type: 'array', items: { type: 'integer' }, description: '1 = men, 2 = women. Empty = all.' },
            interests: { type: 'array', items: { type: 'object', additionalProperties: true } },
            custom_audiences: { type: 'array', items: { type: 'object', additionalProperties: true } },
            publisher_platforms: { type: 'array', items: { type: 'string', enum: ['facebook', 'instagram'] }, description: 'Omit for Advantage+ placements.' },
            facebook_positions: { type: 'array', items: { type: 'string' } },
            instagram_positions: { type: 'array', items: { type: 'string' } },
            custom_locations: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Pins with lat/lng and radius.' },
            advantage_audience: { type: 'boolean' },
          },
          additionalProperties: true,
        },
        SaasMetaCampaignBaseBody: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            daily_budget: { type: 'number', example: 50 },
            days: { type: 'integer', example: 7, description: 'Run window, set at creation time.' },
            country: { type: 'string', default: 'ZA' },
            status: { type: 'string', enum: ['PAUSED', 'ACTIVE'], default: 'PAUSED' },
            targeting: { $ref: '#/components/schemas/SaasMetaTargetingInput' },
          },
        },
        SaasMetaWhatsAppCampaignBody: {
          allOf: [
            { $ref: '#/components/schemas/SaasMetaCampaignBaseBody' },
            {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Ad text; also prefilled in the WhatsApp chat (first 500 chars).' },
                image_hash: { type: 'string', description: 'From `POST /saas/meta/creatives/image`.' },
                image_url: { type: 'string' },
              },
            },
          ],
        },
        SaasMetaLeadCampaignBody: {
          allOf: [
            { $ref: '#/components/schemas/SaasMetaCampaignBaseBody' },
            {
              type: 'object',
              properties: {
                image_hash: { type: 'string' },
                headline: { type: 'string' },
                body: { type: 'string' },
                privacy_policy_url: { type: 'string', format: 'uri' },
                thank_you_message: { type: 'string' },
              },
            },
          ],
        },
        SaasAdTipsClientsResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                clients: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      clientId: { type: 'string' },
                      companyName: { type: 'string' },
                      plan: { type: 'string' },
                      adAccountId: { type: 'string' },
                      adAccountName: { type: 'string' },
                      pixelLinked: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
        SaasAdTip: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              example: 'high_frequency',
              description:
                'Rule id: no_conversion_tracking, pixel_no_conversions, high_frequency, low_ctr, high_cpm, ctr_declining, budget_fragmentation, learning_phase, weekday_weekend.',
            },
            severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
            scope: {
              type: 'object',
              properties: { type: { type: 'string', enum: ['account', 'campaign', 'adset'] }, id: { type: 'string' }, name: { type: 'string' } },
            },
            title: { type: 'string' },
            why: { type: 'string' },
            action: { type: 'string' },
            metrics: {
              type: 'array',
              items: {
                type: 'object',
                properties: { label: { type: 'string' }, value: { type: 'string' }, threshold: { type: 'string' } },
              },
            },
          },
        },
        SaasAdTipsResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                clientId: { type: 'string' },
                companyName: { type: 'string' },
                connected: { type: 'boolean' },
                message: { type: 'string', description: 'Set when not connected.' },
                adAccountId: { type: 'string' },
                adAccountName: { type: 'string' },
                label: { type: 'string' },
                currency: { type: 'string' },
                account: { $ref: '#/components/schemas/SaasMetaResultSummary' },
                campaigns: { type: 'array', items: { type: 'object', additionalProperties: true } },
                daily: { type: 'array', items: { $ref: '#/components/schemas/SaasMetaDailyRow' } },
                adsets: { type: 'array', items: { type: 'object', additionalProperties: true } },
                tips: { type: 'array', items: { $ref: '#/components/schemas/SaasAdTip' } },
                summary: {
                  type: 'object',
                  properties: { critical: { type: 'integer' }, warning: { type: 'integer' }, info: { type: 'integer' } },
                },
                warnings: { type: 'array', items: { type: 'string' } },
                campaignCap: { $ref: '#/components/schemas/SaasMetaCampaignCap' },
              },
            },
          },
        },
        SaasWhatsAppAccountBody: {
          type: 'object',
          required: ['waba_id', 'phone_number_id', 'access_token'],
          properties: {
            waba_id: { type: 'string' },
            phone_number_id: { type: 'string' },
            access_token: { type: 'string', description: 'Stored encrypted; never returned.' },
            mode: { type: 'string', default: 'embedded' },
          },
        },
        SaasWhatsAppEmbeddedSignupBody: {
          type: 'object',
          required: ['code'],
          properties: {
            code: { type: 'string' },
            waba_id: { type: 'string', description: 'Alias `wabaId`. From the popup session info.' },
            phone_number_id: { type: 'string', description: 'Alias `phoneNumberId`.' },
            event: { type: 'string', example: 'FINISH' },
            pin: { type: 'string', description: 'Two-step verification PIN for registration.' },
          },
        },
        SaasWhatsAppRegisterBody: {
          type: 'object',
          properties: { pin: { type: 'string', pattern: '^\\d{6}$' } },
        },
        SaasWhatsAppConversionTestBody: {
          type: 'object',
          properties: {
            eventName: { type: 'string', default: 'LeadSubmitted', description: 'Alias `event_name`.' },
            ctwaClid: { type: 'string', description: 'Click-to-WhatsApp click id. Alias `ctwa_clid`.' },
            contactWaId: { type: 'string', description: 'Alias `contact_wa_id`.' },
            currency: { type: 'string', default: 'ZAR' },
            value: { type: 'number' },
            testEventCode: { type: 'string', description: 'Alias `test_event_code`. Falls back to `WHATSAPP_CAPI_TEST_EVENT_CODE`.' },
          },
        },
        SaasWhatsAppOwnerAlertEvents: {
          type: 'object',
          properties: {
            booking: { type: 'boolean' },
            order: { type: 'boolean' },
            reschedule: { type: 'boolean' },
            message: { type: 'boolean' },
          },
        },
        SaasWhatsAppNotificationsBody: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'Customer notifications. Alias `notificationsEnabled`.' },
            ownerAlertsEnabled: { type: 'boolean' },
            ownerAlertPhone: { type: 'string', example: '+27821234567', description: 'Empty string clears it.' },
            ownerAlertTarget: { type: 'string', enum: ['personal', 'business'] },
            ownerAlertEvents: { $ref: '#/components/schemas/SaasWhatsAppOwnerAlertEvents' },
            ownerAlertEmailFallback: { type: 'boolean' },
          },
        },
        SaasWhatsAppStatusResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                notificationsEnabled: { type: 'boolean' },
                ownerAlertsEnabled: { type: 'boolean' },
                ownerAlertPhone: { type: 'string' },
                ownerAlertTarget: { type: 'string', enum: ['personal', 'business'] },
                ownerAlertBusinessNumber: { type: 'string' },
                ownerAlertEvents: { $ref: '#/components/schemas/SaasWhatsAppOwnerAlertEvents' },
                ownerAlertEmailFallback: { type: 'boolean' },
                hasSender: { type: 'boolean' },
                usingOwnAccount: { type: 'boolean' },
                usingKhanaFallback: { type: 'boolean', example: false },
                creditBalance: { type: 'number' },
                creditsOk: { type: 'boolean' },
                ready: { type: 'boolean' },
                sender: {
                  type: 'object',
                  nullable: true,
                  properties: { source: { type: 'string' }, phone_number_id: { type: 'string' }, waba_id: { type: 'string' } },
                },
                checklist: {
                  type: 'array',
                  items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, ok: { type: 'boolean' } } },
                },
              },
            },
          },
        },
        SaasWhatsAppTemplateCreateBody: {
          type: 'object',
          properties: {
            starter: { type: 'string', description: 'Starter id from `/whatsapp/templates/starters`. Aliases `starter_id`, `starterId`.' },
            name: { type: 'string', description: 'Lowercase, underscores.' },
            language: { type: 'string', example: 'en_US', description: 'Alias `language_code`.' },
            category: { type: 'string', enum: ['UTILITY', 'MARKETING', 'AUTHENTICATION'], default: 'UTILITY' },
            body: { type: 'string', description: 'Aliases `body_text`, `text`.' },
            header: { type: 'string', description: 'Alias `header_text`.' },
            footer: { type: 'string', description: 'Alias `footer_text`.' },
            body_examples: {
              oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', description: 'Pipe-separated.' }],
            },
            button_url: { type: 'string', description: 'Alias `buttonUrl`.' },
            button_text: { type: 'string', default: 'Open', maxLength: 25 },
            button_example: { type: 'string' },
            components: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Raw Meta components; overrides the fields above.' },
            allow_category_change: { type: 'boolean', default: true },
          },
        },
        SaasWhatsAppTemplateCoachBody: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            category: { type: 'string', default: 'UTILITY' },
            header: { type: 'string' },
            body: { type: 'string' },
            footer: { type: 'string' },
            button_url: { type: 'string' },
            body_examples: { type: 'array', items: { type: 'string' } },
          },
        },
        SaasWhatsAppBroadcastEstimateBody: {
          type: 'object',
          properties: {
            recipientCount: { type: 'integer', description: 'Alias `recipient_count`.' },
            messageType: { type: 'string', enum: ['utility', 'marketing', 'auth', 'service'], default: 'utility', description: 'Alias `message_type`.' },
          },
        },
        SaasWhatsAppTemplateSendBody: {
          type: 'object',
          required: ['to', 'templateName'],
          properties: {
            to: { type: 'string' },
            templateName: { type: 'string' },
            languageCode: { type: 'string', example: 'en_US' },
            components: { type: 'array', items: { type: 'object', additionalProperties: true } },
            messageType: { type: 'string', default: 'utility' },
          },
        },
        SaasWhatsAppTestSendBody: {
          type: 'object',
          required: ['to'],
          properties: {
            to: { type: 'string' },
            templateName: {
              type: 'string',
              enum: ['order_confirmation', 'order_status_update', 'booking_confirmation', 'booking_reminder', 'account_verification'],
              default: 'order_confirmation',
            },
          },
        },
        SaasWhatsAppFlowCreateBody: {
          type: 'object',
          required: ['starter'],
          properties: {
            starter: { type: 'string', description: 'Aliases `starterId`, `starter_id`.' },
            name: { type: 'string' },
            publish: { type: 'boolean', default: true },
          },
        },
        SaasWhatsAppFlowSendBody: {
          type: 'object',
          required: ['to'],
          properties: {
            to: { type: 'string' },
            flow_id: { type: 'string', description: 'Alias `flowId`. Or use `flow_name`.' },
            flow_name: { type: 'string', description: 'Alias `flowName`.' },
            body: { type: 'string' },
            header: { type: 'string' },
            footer: { type: 'string' },
            cta: { type: 'string', description: 'Button text. Alias `flow_cta`.' },
          },
        },
        SaasWhatsAppThreadMetaBody: {
          type: 'object',
          properties: {
            stage: { type: 'string', enum: ['open', 'waiting', 'closed'] },
            marketing_opt_out: { type: 'boolean', description: 'Alias `marketingOptOut`.' },
            labels: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Replaces all labels.' },
            add_labels: { type: 'array', items: { type: 'string' }, description: 'Alias `addLabels`.' },
            remove_labels: { type: 'array', items: { type: 'string' }, description: 'Alias `removeLabels`.' },
          },
        },
        SaasWhatsAppThreadNoteBody: {
          type: 'object',
          required: ['body'],
          properties: { body: { type: 'string', description: 'Alias `note`.' } },
        },
        SaasWhatsAppInboxTemplateBody: {
          type: 'object',
          properties: {
            templateName: { type: 'string', default: 'hello_world', description: 'Alias `template_name`.' },
            language: { type: 'string', description: 'Alias `template_language`.' },
            components: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        SaasWhatsAppCustomerBody: {
          type: 'object',
          properties: {
            first_name: { type: 'string', description: 'Alias `firstName`.' },
            last_name: { type: 'string', description: 'Alias `lastName`.' },
            email: { type: 'string', description: 'Alias `emailAddress`.' },
            phone: { type: 'string', description: 'Edit only. Alias `phoneNumber`.' },
            address: { type: 'string', description: 'Edit only.' },
            city: { type: 'string', description: 'Edit only.' },
            contact_name: { type: 'string', description: 'Create only: WhatsApp profile name, split into first/last when names are blank.' },
          },
        },
        SaasWhatsAppInboxReplyBody: {
          type: 'object',
          required: ['to', 'text'],
          properties: {
            to: { type: 'string', description: 'Aliases `contact_wa_id`, `contactWaId`.' },
            text: { type: 'string', description: 'Aliases `message`, `body`.' },
          },
        },
        SaasWhatsAppAutoRuleBody: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 80 },
            keywords: {
              oneOf: [{ type: 'array', items: { type: 'string' }, maxItems: 40 }, { type: 'string', description: 'Comma-separated.' }],
            },
            reply: { type: 'string', maxLength: 1000 },
            match_mode: { type: 'string', enum: ['any', 'all', 'short_greeting'], default: 'any', description: 'Alias `matchMode`.' },
            enabled: { type: 'boolean', default: true },
            sort_order: { type: 'integer', description: 'Alias `sortOrder`.' },
            cooldown_ms: { type: 'integer', nullable: true, description: 'Alias `cooldownMs`.' },
          },
        },
        SaasWhatsAppBroadcastBody: {
          type: 'object',
          required: ['template_name', 'contact_wa_ids'],
          properties: {
            template_name: { type: 'string', description: 'Alias `templateName`.' },
            language: { type: 'string', description: 'Defaults to the approved template language. Aliases `template_language`, `templateLanguage`.' },
            contact_wa_ids: { type: 'array', items: { type: 'string' }, maxItems: 200, description: 'Aliases `contactWaIds`, `recipients`.' },
            name: { type: 'string', maxLength: 120 },
          },
        },
        SaasWhatsAppCannedReplyBody: {
          type: 'object',
          required: ['title', 'body'],
          properties: { title: { type: 'string' }, body: { type: 'string' }, shortcut: { type: 'string' } },
        },
        SaasCrmStage: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string', maxLength: 80 },
            order: { type: 'integer' },
            color: { type: 'string', example: '#64748b' },
            isClosed: { type: 'boolean' },
          },
        },
        SaasCrmStagesBody: {
          type: 'object',
          required: ['stages'],
          properties: { stages: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/SaasCrmStage' } } },
        },
        SaasCrmOpportunityBody: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            stage_id: { type: 'string', description: 'Defaults to the first stage.' },
            status: { type: 'string', enum: ['open', 'won', 'lost'], default: 'open' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' },
            value: { type: 'number' },
            currency: { type: 'string', default: 'ZAR' },
            customer_name: { type: 'string' },
            customer_email: { type: 'string' },
            customer_phone: { type: 'string' },
            source: { type: 'string' },
            notes: { type: 'string' },
            owner_name: { type: 'string' },
            linked_order_id: { type: 'string' },
            linked_booking_id: { type: 'string' },
          },
        },
        SaasCrmTaskBody: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            status: { type: 'string', enum: ['open', 'completed', 'cancelled'], description: 'Update only; new tasks start open.' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' },
            due_at: { type: 'string', format: 'date-time' },
            reminder_at: { type: 'string', format: 'date-time' },
            assignee_name: { type: 'string' },
            assignee_user_id: { type: 'string' },
            linked_opportunity_id: { type: 'string' },
            linked_order_id: { type: 'string' },
            linked_booking_id: { type: 'string' },
            linked_whatsapp_contact: { type: 'string' },
            customer_name: { type: 'string' },
            customer_email: { type: 'string' },
            customer_phone: { type: 'string' },
          },
        },
        SaasCrmApplyTemplateBody: {
          type: 'object',
          required: ['vertical'],
          properties: {
            vertical: { type: 'string', enum: ['salon', 'restaurant', 'retail', 'services'] },
            assignee_name: { type: 'string' },
          },
        },
        SaasEftRequestBody: {
          type: 'object',
          properties: {
            pack_id: { type: 'string', description: 'Alias `packId`. Or send `amount_zar`.' },
            amount_zar: { type: 'number', description: 'Alias `amountZar`.' },
            note: { type: 'string' },
          },
        },
        SaasEftReferenceBody: {
          type: 'object',
          required: ['reference'],
          properties: { reference: { type: 'string' }, note: { type: 'string' } },
        },
        SaasManualTopupBody: {
          type: 'object',
          properties: {
            pack_id: { type: 'string' },
            credits: { type: 'number', description: 'Used when no `pack_id`.' },
            amount: { type: 'number' },
            reference: { type: 'string' },
            client_id: { type: 'string', description: 'Must be this workspace if sent.' },
          },
        },
        SaasAdminTopupBody: {
          type: 'object',
          required: ['client_id'],
          properties: {
            client_id: { type: 'string', description: 'Alias `clientId`.' },
            pack_id: { type: 'string', description: 'Alias `packId`.' },
            credits: { type: 'number', description: 'Used when no `pack_id`.' },
            amount: { type: 'number' },
            reference: { type: 'string' },
          },
        },
        SaasPricingRuleBody: {
          type: 'object',
          required: ['service'],
          properties: {
            service: { type: 'string', example: 'whatsapp' },
            message_type: { type: 'string', enum: ['marketing', 'utility', 'auth', 'service', 'setup', 'management', 'optimization'], default: 'service' },
            tier: { type: 'string', enum: ['all', 'starter', 'launch', 'growth', 'scale', 'enterprise'], default: 'all' },
            cost_per_unit: { type: 'number' },
            markup_percentage: { type: 'number' },
            active: { type: 'boolean', default: true },
            notes: { type: 'string' },
          },
        },
        SaasAdminSandboxTestBody: {
          type: 'object',
          required: ['to'],
          properties: {
            to: { type: 'string', description: 'Alias `phone`.' },
            phone_number_id: { type: 'string', description: 'Falls back to `WHATSAPP_TEST_PHONE_NUMBER_ID`.' },
            access_token: { type: 'string' },
            templateName: { type: 'string', default: 'hello_world' },
            languageCode: { type: 'string', default: 'en_US' },
          },
        },
        SaasAdminWhatsAppTestBody: {
          type: 'object',
          required: ['to'],
          properties: {
            to: { type: 'string', description: 'Alias `phone`.' },
            client_id: { type: 'string', description: "Defaults to the caller's client, then Khana." },
            templateName: { type: 'string', default: 'order_confirmation' },
          },
        },
        SaasSocialPublishBody: {
          type: 'object',
          properties: {
            destinations: {
              type: 'array',
              items: { type: 'string', enum: ['facebook', 'instagram', 'both'] },
              default: ['instagram'],
              description: '`/meta/publish` only.',
            },
            mediaType: { type: 'string', enum: ['IMAGE', 'CAROUSEL', 'VIDEO', 'REELS'], default: 'IMAGE', description: 'Alias `media_type`.' },
            imageUrl: { type: 'string', description: 'Alias `image_url`.' },
            imageUrls: { type: 'array', items: { type: 'string' }, description: 'Alias `image_urls`.' },
            videoUrl: { type: 'string', description: 'Alias `video_url`.' },
            caption: { type: 'string' },
          },
        },
        SaasSocialScheduleBody: {
          type: 'object',
          required: ['scheduledFor'],
          properties: {
            scheduledFor: { type: 'string', format: 'date-time' },
            destinations: { type: 'array', items: { type: 'string', enum: ['facebook', 'instagram', 'both'] }, default: ['instagram'] },
            mediaType: { type: 'string', enum: ['IMAGE', 'CAROUSEL', 'VIDEO', 'REELS'], default: 'IMAGE' },
            imageUrls: { type: 'array', items: { type: 'string' } },
            imageUrl: { type: 'string', description: 'Used when `imageUrls` is not sent.' },
            videoUrl: { type: 'string' },
            caption: { type: 'string' },
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
                templateId: { type: 'string', nullable: true },
                draftId: { type: 'string', nullable: true },
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
        NewsletterPreviewBody: {
          type: 'object',
          required: ['html'],
          properties: {
            html: { type: 'string', description: 'Full HTML composed by the dashboard builder.' },
            subject: { type: 'string' },
            text: { type: 'string', description: 'Optional plain-text override.' },
            templateId: { type: 'string' },
            payload: { type: 'object', description: 'Optional field values JSON for reference.' },
          },
        },
        NewsletterPreviewResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                subject: { type: 'string' },
                html: { type: 'string' },
                text: { type: 'string' },
                templateId: { type: 'string', nullable: true },
                payload: { type: 'object' },
                warnings: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        NewsletterImageUploadResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: true },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'Full HTTPS URL for img src' },
                fileName: { type: 'string' },
              },
            },
          },
        },
        NewsletterDraftBody: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            templateId: { type: 'string' },
            subject: { type: 'string' },
            html: { type: 'string' },
            text: { type: 'string' },
            payload: { type: 'object' },
          },
        },
        NewsletterDraftResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: true },
            data: { type: 'object' },
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
            plan: { type: 'string', enum: ['starter', 'launch', 'growth', 'scale', 'enterprise'], default: 'starter', description: 'Partnership plan. Sets team seats, monthly credits, Meta campaign limits and pricing rules. Old values bronze/silver/gold are accepted and mapped to starter/launch/growth.' },
            role: { type: 'string', enum: ['client', 'admin'], default: 'client' },
            permissions: { $ref: '#/components/schemas/ClientPermissionsFlags' },
            deliveryOptions: { type: 'array', items: { type: 'object', additionalProperties: true } },
            emailSignature: { type: 'string' },
            ga4PropertyId: { type: 'string' },
            imapHost: { type: 'string' },
            imapPort: { type: 'integer' },
            smtpHost: { type: 'string' },
            smtpPort: { type: 'integer' },
            acceptedLegalTerms: {
              type: 'boolean',
              description: 'Set true when the merchant accepted the current ToS and AUP (clickwrap).',
            },
          },
        },
        LegalAcceptanceBody: {
          type: 'object',
          required: ['acceptedLegalTerms'],
          properties: {
            acceptedLegalTerms: { type: 'boolean' },
            email: { type: 'string', format: 'email' },
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
            legalAcceptance: { type: 'object', additionalProperties: true },
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
        VotingCampaignCreateBody: {
          type: 'object',
          required: ['title', 'description', 'campaignType', 'startDate', 'endDate', 'items'],
          properties: {
            title: { type: 'string', example: 'Favorite scent' },
            description: { type: 'string', example: 'Help us pick the next product' },
            campaignType: { type: 'string', enum: ['campaign', 'poll'], example: 'poll' },
            startDate: { type: 'string', format: 'date-time', example: '2026-09-05T00:00:00.000Z' },
            endDate: { type: 'string', format: 'date-time', example: '2026-09-20T23:59:59.000Z' },
            items: {
              type: 'array',
              minItems: 2,
              description: 'At least 2 options. Each needs `title` (alias `name` accepted).',
              items: {
                type: 'object',
                required: ['title'],
                properties: {
                  title: { type: 'string', example: 'Rose' },
                  name: { type: 'string', description: 'Alias for title' },
                  description: { type: 'string' },
                  images: { type: 'array', items: { type: 'object' } },
                },
              },
            },
            shortDescription: { type: 'string' },
            votingRules: { type: 'object' },
            settings: { type: 'object' },
            media: { type: 'object' },
            categories: { type: 'array', items: { type: 'string' } },
            tags: { type: 'array', items: { type: 'string' } },
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
