#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCE = 'https://api.mypurecloud.com/api/v2/docs/swagger';
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '..', 'references', 'openapi');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

const OPERATION_IDS = Object.freeze([
  // Wrap-up code definitions
  'getRoutingWrapupcodes',
  'postRoutingWrapupcodes',
  'getRoutingWrapupcode',
  'putRoutingWrapupcode',
  'deleteRoutingWrapupcode',
  // Division-scoped wrap-up code views, which can also surface deleted codes
  'getRoutingWrapupcodesDivisionviews',
  'getRoutingWrapupcodesDivisionview',
  // Queue association
  'getRoutingQueueWrapupcodes',
  'postRoutingQueueWrapupcodes',
  'deleteRoutingQueueWrapupcode',
  // Queue discovery, needed to resolve and verify assignment targets
  'getRoutingQueues',
  'getRoutingQueue',
  'getRoutingQueuesDivisionviews',
  // Division discovery for division-aware create and move
  'getAuthorizationDivisions',
  'getAuthorizationDivision',
  'getAuthorizationDivisionsHome',
  // Read-only outbound dependency check before deleting a code
  'getOutboundWrapupcodemappings',
]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name.startsWith('confirm-')) {
      args[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    args[name] = value;
    index += 1;
  }
  return args;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function validateSpec(spec) {
  if (!spec || spec.swagger !== '2.0') {
    throw new Error('Expected a Swagger 2.0 document.');
  }
  if (spec.info?.title !== 'PureCloud Platform API') {
    throw new Error(`Unexpected OpenAPI title: ${spec.info?.title || '<missing>'}`);
  }
  if (!spec.paths || typeof spec.paths !== 'object') {
    throw new Error('OpenAPI document has no paths object.');
  }
}

function operationIndex(spec) {
  const index = new Map();
  for (const [apiPath, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !operation?.operationId) continue;
      if (index.has(operation.operationId)) {
        throw new Error(`Duplicate operationId: ${operation.operationId}`);
      }
      index.set(operation.operationId, { apiPath, method: method.toLowerCase(), operation });
    }
  }
  return index;
}

function referencedDefinitionNames(value, names = new Set()) {
  if (!value || typeof value !== 'object') return names;
  if (Array.isArray(value)) {
    for (const item of value) referencedDefinitionNames(item, names);
    return names;
  }
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/definitions/')) {
    names.add(decodeURIComponent(value.$ref.slice('#/definitions/'.length)));
  }
  for (const child of Object.values(value)) referencedDefinitionNames(child, names);
  return names;
}

function collectDefinitions(spec, selectedPaths) {
  const names = referencedDefinitionNames(selectedPaths);
  const queue = [...names];
  while (queue.length) {
    const name = queue.shift();
    const definition = spec.definitions?.[name];
    if (!definition) throw new Error(`Referenced definition is missing: ${name}`);
    const nested = referencedDefinitionNames(definition);
    for (const child of nested) {
      if (!names.has(child)) {
        names.add(child);
        queue.push(child);
      }
    }
  }
  return Object.fromEntries([...names].sort().map((name) => [name, spec.definitions[name]]));
}

function buildSubset(spec) {
  validateSpec(spec);
  const all = operationIndex(spec);
  const selectedIds = new Set(OPERATION_IDS);
  const missing = OPERATION_IDS.filter((id) => !all.has(id));
  if (missing.length) throw new Error(`Required operationIds missing: ${missing.join(', ')}`);

  const deprecated = OPERATION_IDS.filter((id) => all.get(id).operation.deprecated === true);
  if (deprecated.length) throw new Error(`Allowlisted operationIds became deprecated: ${deprecated.join(', ')}`);

  const paths = {};
  for (const [apiPath, pathItem] of Object.entries(spec.paths)) {
    const output = {};
    if (pathItem.parameters) output.parameters = pathItem.parameters;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (selectedIds.has(operation?.operationId)) output[method] = operation;
    }
    if (Object.keys(output).some((key) => HTTP_METHODS.has(key.toLowerCase()))) paths[apiPath] = output;
  }

  const usedTags = new Set(
    Object.values(paths)
      .flatMap((item) => Object.entries(item))
      .filter(([method]) => HTTP_METHODS.has(method.toLowerCase()))
      .flatMap(([, operation]) => operation.tags || []),
  );

  return {
    swagger: spec.swagger,
    info: {
      ...spec.info,
      description: `${spec.info?.description || ''}\n\nLocal allowlisted wrap-up-code subset generated from the official definition.`.trim(),
    },
    host: spec.host,
    basePath: spec.basePath,
    schemes: spec.schemes,
    consumes: spec.consumes,
    produces: spec.produces,
    tags: (spec.tags || []).filter((tag) => usedTags.has(tag.name)),
    paths,
    definitions: collectDefinitions(spec, paths),
    securityDefinitions: spec.securityDefinitions,
    'x-gc-wrapup-codes': {
      generatedFrom: DEFAULT_SOURCE,
      operationIds: [...OPERATION_IDS],
      exclusions: [
        'deprecated operations',
        'queue create/update/delete',
        'queue membership administration',
        'outbound wrap-up code mapping mutation',
        'per-conversation wrap-up submission',
        'task management workitem wrap-ups',
        'division structure mutation',
      ],
    },
  };
}

async function readSource(args) {
  if (args.input) {
    return {
      source: path.resolve(args.input),
      buffer: fs.readFileSync(path.resolve(args.input)),
    };
  }
  const source = args.source || DEFAULT_SOURCE;
  const parsed = new URL(source);
  if (parsed.protocol !== 'https:') throw new Error('OpenAPI source must use HTTPS.');
  const response = await fetch(parsed, {
    headers: { Accept: 'application/json', 'User-Agent': 'gc-wrapup-codes-skill/1.0' },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`OpenAPI download failed with HTTP ${response.status}.`);
  const arrayBuffer = await response.arrayBuffer();
  return { source, buffer: Buffer.from(arrayBuffer) };
}

function atomicWrite(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const backupPath = `${filePath}.${process.pid}.bak`;
  fs.writeFileSync(tempPath, value);
  if (!fs.existsSync(filePath)) {
    fs.renameSync(tempPath, filePath);
    return;
  }
  fs.renameSync(filePath, backupPath);
  try {
    fs.renameSync(tempPath, filePath);
    fs.rmSync(backupPath, { force: true });
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    if (!fs.existsSync(filePath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, filePath);
    throw error;
  }
}

async function refresh(args) {
  if (!args['confirm-refresh']) {
    throw new Error('OpenAPI refresh is write-gated. Pass --confirm-refresh.');
  }
  const outputDir = path.resolve(args['output-dir'] || DEFAULT_OUTPUT_DIR);
  fs.mkdirSync(outputDir, { recursive: true });
  const { source, buffer } = await readSource(args);
  if (buffer.length > 100 * 1024 * 1024) throw new Error('OpenAPI document exceeds 100 MiB safety limit.');

  let spec;
  try {
    spec = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('OpenAPI source is not valid JSON.');
  }
  validateSpec(spec);
  const subset = buildSubset(spec);
  const subsetBuffer = Buffer.from(`${JSON.stringify(subset, null, 2)}\n`);
  const metadata = {
    source,
    canonicalSource: DEFAULT_SOURCE,
    fetchedAt: new Date().toISOString(),
    title: spec.info.title,
    apiVersion: spec.info.version,
    swaggerVersion: spec.swagger,
    upstreamLicense: spec.info.license || null,
    full: {
      file: 'purecloud-platform-api-v2.json',
      bytes: buffer.length,
      sha256: sha256(buffer),
    },
    subset: {
      file: 'wrapup-codes.openapi.json',
      bytes: subsetBuffer.length,
      sha256: sha256(subsetBuffer),
      operations: OPERATION_IDS.length,
      definitions: Object.keys(subset.definitions || {}).length,
    },
  };

  atomicWrite(path.join(outputDir, metadata.full.file), buffer);
  atomicWrite(path.join(outputDir, metadata.subset.file), subsetBuffer);
  atomicWrite(path.join(outputDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

async function main() {
  try {
    const metadata = await refresh(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ ok: true, metadata }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  DEFAULT_SOURCE,
  OPERATION_IDS,
  buildSubset,
  operationIndex,
  parseArgs,
  refresh,
  sha256,
  validateSpec,
};
