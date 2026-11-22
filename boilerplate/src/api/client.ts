/**
 * Typed khanaconnect API client. Every call goes through an operation id from
 * generated/schema.ts, so paths, params, bodies and responses are checked by TypeScript.
 *
 * Need an endpoint that isn't here? Add it to api.contract.json, run `npm run gen:api`,
 * then call it with api('<id>', …). Don't fetch() the API directly: the contract check in the
 * API repo only protects operations listed in api.contract.json.
 */
import { config } from '../config';
import { operations, type OperationId, type OperationTypes } from './generated/schema';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Args<K extends OperationId> = (OperationTypes[K]['path'] extends Record<string, never>
  ? { path?: undefined }
  : { path: OperationTypes[K]['path'] }) &
  (OperationTypes[K]['query'] extends Record<string, never> ? { query?: undefined } : { query: OperationTypes[K]['query'] }) &
  (OperationTypes[K]['body'] extends undefined ? { body?: undefined } : { body: OperationTypes[K]['body'] });

type OptionalArgs<K extends OperationId> = Record<string, never> extends Args<K> ? [args?: Args<K>] : [args: Args<K>];

export async function api<K extends OperationId>(id: K, ...rest: OptionalArgs<K>): Promise<OperationTypes[K]['response']> {
  const args = (rest[0] || {}) as { path?: Record<string, string>; query?: Record<string, unknown>; body?: unknown };
  const op = operations[id];

  let url = op.path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(args.path?.[name] ?? '')));
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(args.query || {})) if (v !== undefined && v !== '') qs.set(k, String(v));
  if ([...qs].length) url += `?${qs}`;

  if (!config.storefrontToken) {
    throw new ApiError('This site has no storefront token yet. Set VITE_STOREFRONT_TOKEN (see README).', 0, 'NO_TOKEN');
  }

  let res: Response;
  try {
    res = await fetch(`${config.apiBaseUrl}${url}`, {
      method: op.method,
      headers: {
        Authorization: `Bearer ${config.storefrontToken}`,
        ...(args.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0, 'NETWORK');
  }

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const d = (data || {}) as { error?: string; message?: string; code?: string };
    throw new ApiError(d.error || d.message || `Request failed (${res.status})`, res.status, d.code, data);
  }
  return data as OperationTypes[K]['response'];
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

export type * from './generated/schema';
