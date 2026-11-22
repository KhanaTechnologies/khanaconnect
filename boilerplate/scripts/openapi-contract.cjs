/**
 * Contract tooling shared by the boilerplate generator (scripts/gen-api.cjs) and the API repo's
 * check (tests/boilerplateApiContract.test.js). Plain Node, no dependencies.
 *
 *  loadSpec(root)                 → { spec, apiPath } from <root>/config/openapi.js
 *  buildContract(spec, apiPath, ops) → canonical snapshot of every operation the boilerplate uses
 *  generateTs(contract)           → src/api/generated/schema.ts source
 *  routeTable(root)               → Set of "GET /storefront/site" for routes really mounted in app.js
 *  validate(value, schema, comps) → list of mismatches (used to check real handler output)
 */
const fs = require('fs');
const path = require('path');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function loadSpec(root) {
  const file = path.join(root, 'config', 'openapi.js');
  delete require.cache[require.resolve(file)];
  delete require.cache[require.resolve(path.join(root, 'config', 'openapiStorefront.js'))];
  const mod = require(file);
  return { spec: mod.spec(), apiPath: mod.apiPath || '/api/v1' };
}

const refName = (ref) => ref.replace('#/components/schemas/', '');

/** Collect component names reachable from a schema. */
function collectRefs(schema, comps, out = new Set()) {
  if (!schema || typeof schema !== 'object') return out;
  if (schema.$ref) {
    const name = refName(schema.$ref);
    if (!out.has(name)) {
      out.add(name);
      if (!comps[name]) throw new Error(`Schema ${name} is referenced but not defined in components.schemas`);
      collectRefs(comps[name], comps, out);
    }
    return out;
  }
  for (const v of Object.values(schema)) {
    if (Array.isArray(v)) v.forEach((x) => collectRefs(x, comps, out));
    else if (v && typeof v === 'object') collectRefs(v, comps, out);
  }
  return out;
}

/** Keep only the keys that change the wire shape (descriptions/examples don't break clients). */
function shapeOf(schema) {
  if (Array.isArray(schema)) return schema.map(shapeOf);
  if (!schema || typeof schema !== 'object') return schema;
  const KEEP = ['$ref', 'type', 'enum', 'nullable', 'required', 'properties', 'items', 'additionalProperties', 'oneOf', 'anyOf', 'allOf'];
  const out = {};
  for (const k of KEEP) {
    if (!(k in schema)) continue;
    const v = schema[k];
    if (k === 'properties') {
      out.properties = {};
      for (const p of Object.keys(v).sort()) out.properties[p] = shapeOf(v[p]);
    } else if (k === 'required' || k === 'enum') {
      out[k] = [...v].sort();
    } else {
      out[k] = shapeOf(v);
    }
  }
  return out;
}

function jsonSchemaOf(content) {
  return content && content['application/json'] ? content['application/json'].schema : undefined;
}

/**
 * ops: [{ id, method, path }] with path relative to apiPath, e.g. "/storefront/site".
 * Throws one error listing every missing operation.
 */
function buildContract(spec, apiPath, ops) {
  const comps = (spec.components && spec.components.schemas) || {};
  const missing = [];
  const operations = {};
  const used = new Set();

  for (const { id, method, path: rel } of ops) {
    const full = `${apiPath}${rel}`;
    const op = spec.paths[full] && spec.paths[full][method.toLowerCase()];
    if (!op) {
      missing.push(`${method.toUpperCase()} ${rel} (operation "${id}")`);
      continue;
    }
    const params = (op.parameters || []).map((p) => ({
      name: p.name,
      in: p.in,
      required: !!p.required,
      schema: shapeOf(p.schema || { type: 'string' }),
    }));
    const request = op.requestBody ? shapeOf(jsonSchemaOf(op.requestBody.content)) : null;
    const okStatus = Object.keys(op.responses || {}).filter((s) => /^2\d\d$/.test(s)).sort()[0];
    const response = okStatus ? shapeOf(jsonSchemaOf(op.responses[okStatus].content)) || null : null;
    if (!response) missing.push(`${method.toUpperCase()} ${rel} (operation "${id}") has no typed 2xx JSON response`);
    [request, response, ...params.map((p) => p.schema)].forEach((s) => collectRefs(s, comps, used));
    operations[id] = { method: method.toUpperCase(), path: rel, status: Number(okStatus), params, request, response };
  }

  if (missing.length) {
    const err = new Error(
      `config/openapi.js no longer has ${missing.length} operation(s) the boilerplate uses:\n  - ${missing.join('\n  - ')}`
    );
    err.code = 'CONTRACT_MISSING';
    throw err;
  }

  const schemas = {};
  for (const name of [...used].sort()) schemas[name] = shapeOf(comps[name]);
  return { generatedFrom: 'config/openapi.js', operations, schemas };
}

// ---------------------------------------------------------------- TypeScript

function tsType(s, indent = '') {
  if (!s) return 'unknown';
  let t;
  if (s.$ref) t = refName(s.$ref);
  else if (s.enum) t = s.enum.map((v) => JSON.stringify(v)).join(' | ');
  else if (s.type === 'array') t = `Array<${tsType(s.items, indent)}>`;
  else if (s.type === 'object' || s.properties) {
    const props = s.properties || {};
    const keys = Object.keys(props);
    if (!keys.length) {
      t = s.additionalProperties ? `Record<string, ${tsType(s.additionalProperties, indent)}>` : 'Record<string, unknown>';
    } else {
      const req = new Set(s.required || []);
      const inner = indent + '  ';
      t = `{\n${keys
        .map((k) => `${inner}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${req.has(k) ? '' : '?'}: ${tsType(props[k], inner)};`)
        .join('\n')}\n${indent}}`;
    }
  } else if (s.type === 'integer' || s.type === 'number') t = 'number';
  else if (s.type === 'string') t = 'string';
  else if (s.type === 'boolean') t = 'boolean';
  else t = 'unknown';
  return s.nullable ? `${t} | null` : t;
}

function generateTs(contract) {
  const lines = [
    '/* eslint-disable */',
    '// GENERATED by scripts/gen-api.cjs from config/openapi.js. Do not edit by hand.',
    '// Regenerate after API changes:  npm run gen:api  (in boilerplate/)  or  npm run boilerplate:api  (repo root)',
    '',
  ];
  for (const [name, schema] of Object.entries(contract.schemas)) {
    const t = tsType(schema);
    lines.push(t.startsWith('{') ? `export interface ${name} ${t}` : `export type ${name} = ${t};`, '');
  }

  lines.push('export const operations = {');
  for (const [id, op] of Object.entries(contract.operations)) {
    lines.push(`  ${id}: { method: '${op.method}', path: '${op.path}', status: ${op.status} },`);
  }
  lines.push('} as const;', '', 'export interface OperationTypes {');
  for (const [id, op] of Object.entries(contract.operations)) {
    const group = (where) => {
      const ps = op.params.filter((p) => p.in === where);
      if (!ps.length) return 'Record<string, never>';
      return `{ ${ps.map((p) => `${p.name}${p.required ? '' : '?'}: ${tsType(p.schema)}`).join('; ')} }`;
    };
    lines.push(`  ${id}: {`);
    lines.push(`    path: ${group('path')};`);
    lines.push(`    query: ${group('query')};`);
    lines.push(`    body: ${op.request ? tsType(op.request, '    ') : 'undefined'};`);
    lines.push(`    response: ${tsType(op.response, '    ')};`);
    lines.push('  };');
  }
  lines.push('}', '', 'export type OperationId = keyof OperationTypes;', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- routes really mounted

/** Static read of app.js + routes/*.js: which METHOD + path pairs Express actually serves. */
function routeTable(root) {
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const vars = {};
  for (const m of app.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]\.\/routes\/([\w.-]+)['"]\s*\)/g)) {
    vars[m[1]] = m[2];
  }
  const mounts = [];
  for (const m of app.matchAll(/app\.use\(\s*`\$\{api\}([^`]*)`\s*,([^\n]*)\)\s*;/g)) {
    const prefix = m[1];
    const args = m[2];
    const inline = args.match(/require\(\s*['"]\.\/routes\/([\w.-]+)['"]\s*\)/);
    let file = inline ? inline[1] : null;
    if (!file) {
      const names = args.split(',').map((x) => x.trim()).filter(Boolean);
      const last = names[names.length - 1];
      file = vars[last] || null;
    }
    if (file) mounts.push({ prefix, file: file.replace(/\.js$/, '') });
  }

  const table = new Set();
  for (const { prefix, file } of mounts) {
    const src = fs.readFileSync(path.join(root, 'routes', `${file}.js`), 'utf8');
    const add = (method, p) => {
      const joined = `${prefix}${p === '/' ? '' : p}`.replace(/\/+$/, '') || '/';
      table.add(`${method.toUpperCase()} ${joined.replace(/:(\w+)/g, '{$1}')}`);
    };
    for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g)) add(m[1], m[2]);
    for (const m of src.matchAll(/router\.route\(\s*['"`]([^'"`]+)['"`]\s*\)([\s\S]*?)(?=router\.|$)/g)) {
      for (const mm of m[2].matchAll(/\.(get|post|put|patch|delete)\(/g)) add(mm[1], m[1]);
    }
  }
  return table;
}

/** Express path params have their own names; compare by position, not by name. */
function routeKey(method, p) {
  return `${method.toUpperCase()} ${p.replace(/\{[^}]+\}/g, '{}')}`;
}

// ---------------------------------------------------------------- runtime validation

function validate(value, schema, comps, at = '$') {
  if (!schema) return [];
  if (schema.$ref) return validate(value, comps[refName(schema.$ref)], comps, at);
  if (value === null) return schema.nullable ? [] : [`${at}: null but schema is not nullable`];
  if (value === undefined) return [`${at}: missing`];
  const errs = [];
  const type = schema.type || (schema.properties ? 'object' : undefined);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} not in enum`);
  switch (type) {
    case 'string':
      if (typeof value !== 'string') errs.push(`${at}: expected string, got ${typeof value}`);
      break;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) errs.push(`${at}: expected number`);
      break;
    case 'integer':
      if (!Number.isInteger(value)) errs.push(`${at}: expected integer, got ${JSON.stringify(value)}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errs.push(`${at}: expected boolean`);
      break;
    case 'array':
      if (!Array.isArray(value)) errs.push(`${at}: expected array`);
      else value.forEach((v, i) => errs.push(...validate(v, schema.items, comps, `${at}[${i}]`)));
      break;
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errs.push(`${at}: expected object`);
        break;
      }
      for (const k of schema.required || []) if (value[k] === undefined) errs.push(`${at}.${k}: required but missing`);
      const props = schema.properties || {};
      for (const [k, v] of Object.entries(value)) {
        if (props[k]) errs.push(...validate(v, props[k], comps, `${at}.${k}`));
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          errs.push(...validate(v, schema.additionalProperties, comps, `${at}.${k}`));
        }
      }
      break;
    }
    default:
      break;
  }
  return errs;
}

/** Canonical JSON so snapshots diff cleanly. */
function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

module.exports = {
  METHODS,
  loadSpec,
  buildContract,
  generateTs,
  routeTable,
  routeKey,
  validate,
  stableJson,
};
