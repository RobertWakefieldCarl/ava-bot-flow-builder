'use strict';

const fs = require('fs');
const path = require('path');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

// Wrap-up codes carry no version field, so putRoutingWrapupcode is an unconditional
// full replacement: any omitted property is erased and the division can be moved,
// which silently changes who can see and use the code.
const HIGH_IMPACT_IDS = new Set([
  'putRoutingWrapupcode',
  'deleteRoutingWrapupcode',
]);

const DESTRUCTIVE_IDS = new Set([
  'deleteRoutingWrapupcode',
  'deleteRoutingQueueWrapupcode',
]);

const PAGED_IDS = new Set([
  'getRoutingWrapupcodes',
  'getRoutingWrapupcodesDivisionviews',
  'getRoutingQueueWrapupcodes',
  'getRoutingQueues',
  'getRoutingQueuesDivisionviews',
  'getAuthorizationDivisions',
]);

function defaultSubsetPath() {
  return path.resolve(__dirname, '..', '..', 'references', 'openapi', 'wrapup-codes.openapi.json');
}

function loadSubset(filePath = defaultSubsetPath()) {
  const spec = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (spec.swagger !== '2.0' || !spec['x-gc-wrapup-codes']) {
    throw new Error('Bundled wrap-up-code OpenAPI subset is invalid.');
  }
  return spec;
}

function buildOperationIndex(spec) {
  const output = new Map();
  for (const [apiPath, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !operation?.operationId) continue;
      output.set(operation.operationId, {
        apiPath,
        method: method.toLowerCase(),
        operation,
        pathParameters: pathItem.parameters || [],
      });
    }
  }
  return output;
}

function resolveRef(spec, value) {
  if (!value?.$ref) return value;
  const prefix = '#/definitions/';
  if (!value.$ref.startsWith(prefix)) throw new Error(`Unsupported OpenAPI reference: ${value.$ref}`);
  const definition = spec.definitions?.[value.$ref.slice(prefix.length)];
  if (!definition) throw new Error(`Missing OpenAPI definition: ${value.$ref}`);
  return definition;
}

function assertScalar(name, value, schema) {
  if (value === null || value === undefined) return;
  const type = schema.type;
  if (type === 'string' && typeof value !== 'string') throw new Error(`${name} must be a string.`);
  if (type === 'integer' && !Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  if (type === 'number' && typeof value !== 'number') throw new Error(`${name} must be a number.`);
  if (type === 'boolean' && typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`${name} must be one of: ${schema.enum.join(', ')}.`);
  }
  if (typeof value === 'string' && schema.minLength && value.length < schema.minLength) {
    throw new Error(`${name} is shorter than ${schema.minLength} characters.`);
  }
  if (Array.isArray(value) && schema.maxItems && value.length > schema.maxItems) {
    throw new Error(`${name} exceeds maximum item count ${schema.maxItems}.`);
  }
}

function validateSchema(spec, value, rawSchema, name = 'body', depth = 0) {
  if (depth > 20) throw new Error('OpenAPI schema nesting exceeds validation limit.');
  const schema = resolveRef(spec, rawSchema || {});
  if (schema.allOf) {
    for (const item of schema.allOf) validateSchema(spec, value, item, name, depth + 1);
    return;
  }
  assertScalar(name, value, schema);
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
    for (let index = 0; index < value.length; index += 1) {
      validateSchema(spec, value[index], schema.items || {}, `${name}[${index}]`, depth + 1);
    }
    return;
  }
  if (schema.type === 'object' || schema.properties) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
    for (const required of schema.required || []) {
      if (value[required] === undefined || value[required] === null) {
        throw new Error(`${name}.${required} is required.`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) validateSchema(spec, child, schema.properties[key], `${name}.${key}`, depth + 1);
    }
  }
}

function operationParameters(entry) {
  return [...entry.pathParameters, ...(entry.operation.parameters || [])];
}

// A Swagger array query parameter is only sent as repeated keys when its
// collectionFormat is "multi"; anything else must be flattened before transport.
function formatQueryArray(name, value, parameter) {
  if (!Array.isArray(value)) return value;
  const format = parameter.collectionFormat || 'csv';
  if (format === 'multi') return value;
  const separators = { csv: ',', ssv: ' ', tsv: '\t', pipes: '|' };
  const separator = separators[format];
  if (!separator) throw new Error(`Unsupported collectionFormat for ${name}: ${format}`);
  return value.join(separator);
}

function validateAndBuild(spec, operationId, inputs = {}) {
  const entry = buildOperationIndex(spec).get(operationId);
  if (!entry) throw new Error(`Operation is not allowlisted: ${operationId}`);
  if (entry.operation.deprecated) throw new Error(`Deprecated operation is blocked: ${operationId}`);
  const pathParams = inputs.pathParams || {};
  const query = { ...(inputs.query || {}) };
  const allowedPath = new Map();
  const allowedQuery = new Map();
  let bodyParameter = null;
  for (const parameter of operationParameters(entry)) {
    if (parameter.in === 'path') allowedPath.set(parameter.name, parameter);
    if (parameter.in === 'query') allowedQuery.set(parameter.name, parameter);
    if (parameter.in === 'body') bodyParameter = parameter;
  }
  for (const key of Object.keys(pathParams)) {
    if (!allowedPath.has(key)) throw new Error(`Unknown path parameter for ${operationId}: ${key}`);
  }
  for (const key of Object.keys(query)) {
    if (!allowedQuery.has(key)) throw new Error(`Unknown query parameter for ${operationId}: ${key}`);
  }
  let apiPath = entry.apiPath;
  for (const [name, parameter] of allowedPath) {
    const value = pathParams[name];
    if (parameter.required && (value === undefined || value === null || value === '')) {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    assertScalar(`path.${name}`, value, parameter);
    apiPath = apiPath.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  if (apiPath.includes('{')) throw new Error(`Not all path parameters were resolved for ${operationId}.`);
  for (const [name, parameter] of allowedQuery) {
    const value = query[name];
    if (parameter.required && (value === undefined || value === null || value === '')) {
      throw new Error(`Missing required query parameter: ${name}`);
    }
    assertScalar(`query.${name}`, value, parameter);
    if (value !== undefined && value !== null) {
      if (parameter.type === 'array' && !Array.isArray(value)) {
        throw new Error(`query.${name} must be an array.`);
      }
      if (parameter.items?.enum) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (!parameter.items.enum.includes(item)) {
            throw new Error(`query.${name} values must be one of: ${parameter.items.enum.join(', ')}.`);
          }
        }
      }
      query[name] = formatQueryArray(`query.${name}`, value, parameter);
    }
  }
  if (PAGED_IDS.has(operationId)) {
    query.pageSize = Math.min(Math.max(Number(query.pageSize) || 25, 1), 100);
  }
  if (bodyParameter?.required && inputs.body === undefined) throw new Error(`${operationId} requires a request body.`);
  if (!bodyParameter && inputs.body !== undefined) throw new Error(`${operationId} does not accept a request body.`);
  if (bodyParameter && inputs.body !== undefined) validateSchema(spec, inputs.body, bodyParameter.schema, 'body');

  return {
    operationId,
    apiPath,
    method: entry.method.toUpperCase(),
    query,
    body: inputs.body,
    summary: entry.operation.summary || '',
    scopes: (entry.operation.security || []).flatMap((item) => Object.values(item).flat()),
    permissions: entry.operation['x-inin-requires-permissions'] || null,
  };
}

function nestedArrayCount(value) {
  if (Array.isArray(value)) return value.length + value.reduce((sum, item) => sum + nestedArrayCount(item), 0);
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((sum, item) => sum + nestedArrayCount(item), 0);
  }
  return 0;
}

function classifySafety(request) {
  const write = WRITE_METHODS.has(request.method.toLowerCase());
  const destructive = request.method === 'DELETE' || DESTRUCTIVE_IDS.has(request.operationId);
  const highImpact = HIGH_IMPACT_IDS.has(request.operationId) || nestedArrayCount(request.body) > 50;
  return { write, destructive, highImpact };
}

function requiredConfirmations(safety) {
  const flags = [];
  if (safety.write) flags.push('--confirm-apply');
  if (safety.destructive) flags.push('--confirm-delete');
  if (safety.highImpact) flags.push('--confirm-high-impact');
  return flags;
}

function confirmationsSatisfied(safety, flags = {}) {
  return (!safety.write || Boolean(flags.confirmApply))
    && (!safety.destructive || Boolean(flags.confirmDelete))
    && (!safety.highImpact || Boolean(flags.confirmHighImpact));
}

function missingConfirmations(safety, flags = {}) {
  return requiredConfirmations(safety).filter((flag) => {
    if (flag === '--confirm-apply') return !flags.confirmApply;
    if (flag === '--confirm-delete') return !flags.confirmDelete;
    if (flag === '--confirm-high-impact') return !flags.confirmHighImpact;
    return true;
  });
}

module.exports = {
  DESTRUCTIVE_IDS,
  HIGH_IMPACT_IDS,
  PAGED_IDS,
  buildOperationIndex,
  classifySafety,
  confirmationsSatisfied,
  defaultSubsetPath,
  formatQueryArray,
  loadSubset,
  missingConfirmations,
  requiredConfirmations,
  resolveRef,
  validateAndBuild,
  validateSchema,
};
