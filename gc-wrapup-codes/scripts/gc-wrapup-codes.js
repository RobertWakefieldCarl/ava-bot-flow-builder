#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { resolveMcpCredentials } = require('./lib/mcp-credentials');
const { resolveTarget } = require('./lib/regions');
const { ApiError, GenesysClient, sanitizedValue } = require('./lib/genesys-client');
const {
  buildOperationIndex,
  classifySafety,
  confirmationsSatisfied,
  loadSubset,
  missingConfirmations,
  requiredConfirmations,
  validateAndBuild,
} = require('./lib/openapi-operations');

const BOOLEAN_FLAGS = new Set([
  'confirm-apply',
  'confirm-delete',
  'confirm-high-impact',
  'clear-description',
  'replace',
  'skip-usage-scan',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A queue fan-out is many independent writes with no transaction around them, so
// the blast radius grows with the queue count rather than with any single request.
const FANOUT_HIGH_IMPACT_QUEUES = 5;
const FANOUT_MAX_QUEUES = 50;
const FANOUT_MAX_WRITES = 200;
const MAX_PAGES = 25;
const DEFAULT_USAGE_SCAN_QUEUES = 200;

const HELP = `Genesys Cloud Wrap-up Codes

Usage:
  gc-wrapup-codes.js help
  gc-wrapup-codes.js spec-info

Discovery:
  gc-wrapup-codes.js list-codes [--name <fragment>] [--division-ids <csv>]
      [--page-size 25] [--page-number 1] [--include-state Active|Deleted|ActiveAndDeleted]
  gc-wrapup-codes.js get-code --code-id <uuid>
  gc-wrapup-codes.js list-queues [--name <fragment>] [--division-ids <csv>]
      [--page-size 25] [--page-number 1]
  gc-wrapup-codes.js list-queue-codes --queue-id <uuid>
  gc-wrapup-codes.js resolve-codes --names <csv>
  gc-wrapup-codes.js resolve-queues --names <csv>
  gc-wrapup-codes.js code-usage --code-id <uuid> [--queue-scan-limit 200]

Wrap-up code CRUD:
  gc-wrapup-codes.js create-code --name <text> [--description <text>]
      [--division-id <uuid>] [--confirm-apply]
  gc-wrapup-codes.js create-code --body <json-file> [--confirm-apply]
  gc-wrapup-codes.js update-code --code-id <uuid> [--name <text>]
      [--description <text>] [--clear-description] [--division-id <uuid>]
      [--body <json-file>] [--replace] [--confirm-apply] [--confirm-high-impact]
  gc-wrapup-codes.js delete-code --code-id <uuid> [--skip-usage-scan]
      --confirm-apply --confirm-delete --confirm-high-impact

Queue assignment (one queue or a group of queues):
  gc-wrapup-codes.js assign --queue-ids <csv> --code-ids <csv> [--confirm-apply]
  gc-wrapup-codes.js unassign --queue-ids <csv> --code-ids <csv>
      [--confirm-apply] [--confirm-delete]
  gc-wrapup-codes.js sync-queue-codes --queue-ids <csv> --code-ids <csv>
      [--confirm-apply] [--confirm-delete] [--confirm-high-impact]

  Assignment targets also accept --queue-names <csv> and --code-names <csv>.
  A name must match exactly one entity or the command refuses to run.

AVA / Architect telephony (Track 1 — bot flow After Contact):
  gc-wrapup-codes.js discover-telephony --inbound-flow-id <uuid> | --flow-name <name>
      [--bot-flow-id <uuid>] [--bot-flow-name <name>] [--escalation-queue-id <uuid>]
      [--sage-agent-id <uuid>] [--out-dir <path>] [--out <telephony-bindings.json>]
  gc-wrapup-codes.js create-codes-batch --file <wrap-up-codes.json> [--confirm-apply]
  gc-wrapup-codes.js plan-bot-wrapup --file <wrap-up-codes.json> [--bindings <telephony-bindings.json>]
      [--bot-yaml <path>] [--out <plan-dir>]
  gc-wrapup-codes.js apply-bot-after-contact-fragment [--bindings <path>] [--bot-lifecycle-dir <path>]
      [--summary-setting-id <uuid>] [--confirm-apply]
  gc-wrapup-codes.js write-session-html --session-dir <path> [--file <wrap-up-codes.json>]
      [--bindings <telephony-bindings.json>] [--sage-agent-id <uuid>] [--ava-name <text>]
      [--queue-id <uuid>] [--queue-name <text>] [--change-note <text>]

  Telephony commands accept --session-dir to force the session root for wrap-up-codes-handoff.html.

Escape hatch:
  gc-wrapup-codes.js invoke --operation-id <id> [--path-params <json-file>]
      [--query <json-file>] [--body <json-file>] [confirmation flags]

Runtime options:
  --mcp-config <path>   Override the Cursor MCP config path (primarily for tests)
  --region <region>     Must match AVA_HABITAT from the selected AVA harness

Writes are dry-run unless every required confirmation flag is present.

A wrap-up code has no version field, so PUT replaces the whole record. update-code
reads the current code and merges by default; pass --replace to send a literal body.
`;

function parseArgs(argv) {
  const command = argv[0] || 'help';
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      options[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`Missing required option --${name}.`);
  }
  return value;
}

function requireUuid(value, name) {
  if (!UUID.test(String(value))) throw new Error(`${name} must be a UUID.`);
  return String(value);
}

function parseList(value, name) {
  const items = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length) throw new Error(`${name} must contain at least one value.`);
  const unique = [...new Set(items)];
  if (unique.length !== items.length) throw new Error(`${name} contains duplicate values.`);
  return unique;
}

function parseUuidList(value, name) {
  return parseList(value, name).map((item, index) => requireUuid(item, `${name}[${index}]`));
}

function readJson(filePath, label) {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${resolved}`);
  if (stat.size > 5 * 1024 * 1024) throw new Error(`${label} exceeds 5 MiB.`);
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON: ${resolved}`);
    throw error;
  }
}

function flagsFrom(options) {
  return {
    confirmApply: Boolean(options['confirm-apply']),
    confirmDelete: Boolean(options['confirm-delete']),
    confirmHighImpact: Boolean(options['confirm-high-impact']),
  };
}

function summarizeCode(code) {
  if (!code || typeof code !== 'object') return code;
  return {
    id: code.id || null,
    name: code.name ?? null,
    description: code.description ?? null,
    division: code.division ? { id: code.division.id || null, name: code.division.name || null } : null,
    dateModified: code.dateModified || null,
  };
}

function summarizeQueue(queue) {
  if (!queue || typeof queue !== 'object') return queue;
  return {
    id: queue.id || null,
    name: queue.name ?? null,
    division: queue.division ? { id: queue.division.id || null, name: queue.division.name || null } : null,
  };
}

function summarizeListing(body, summarize) {
  const entities = body?.entities || [];
  return {
    total: body?.total ?? entities.length,
    pageSize: body?.pageSize ?? entities.length,
    pageNumber: body?.pageNumber ?? null,
    pageCount: body?.pageCount ?? null,
    entities: entities.map(summarize),
  };
}

function createContext(options, dependencies = {}) {
  const credentials = (dependencies.resolveCredentials || resolveMcpCredentials)({
    configPath: options['mcp-config'],
  });
  const region = (dependencies.resolveRegion || resolveTarget)(credentials, options.region);
  const Client = dependencies.Client || GenesysClient;
  return {
    credentials,
    region,
    client: dependencies.client || new Client({
      region,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    }),
  };
}

function planFor(request, region, flags, extra = {}) {
  const safety = classifySafety(request);
  return {
    operationId: request.operationId,
    method: request.method,
    path: request.apiPath,
    region: region.key,
    query: request.query,
    body: sanitizedValue(request.body),
    scopes: request.scopes,
    permissions: request.permissions,
    safety,
    requiredConfirmations: requiredConfirmations(safety),
    confirmed: confirmationsSatisfied(safety, flags),
    ...extra,
  };
}

async function executeRequest(spec, context, operationId, inputs, flags, extra = {}) {
  const request = validateAndBuild(spec, operationId, inputs);
  const plan = planFor(request, context.region, flags, extra);
  if (plan.safety.write && !plan.confirmed) {
    return { ok: true, dryRun: true, plan, missingConfirmations: missingConfirmations(plan.safety, flags) };
  }
  const response = await context.client.request(request.method, request.apiPath, {
    query: request.query,
    body: request.body,
  });
  return {
    ok: true,
    dryRun: false,
    plan,
    response: sanitizedValue(response.body, context.client.secrets),
    contextId: response.contextId || null,
  };
}

async function readOperation(spec, context, operationId, inputs = {}) {
  const request = validateAndBuild(spec, operationId, inputs);
  const response = await context.client.request(request.method, request.apiPath, { query: request.query });
  return response.body;
}

// Diffing a queue's assignments requires the complete set, not the first page.
async function fetchAllPages(spec, context, operationId, inputs = {}, maxPages = MAX_PAGES) {
  const entities = [];
  let pageNumber = 1;
  let truncated = false;
  let total = null;
  for (;;) {
    const body = await readOperation(spec, context, operationId, {
      ...inputs,
      query: { ...(inputs.query || {}), pageSize: 100, pageNumber },
    });
    total = body?.total ?? total;
    const page = body?.entities || [];
    entities.push(...page);
    const pageCount = Number(body?.pageCount) || 0;
    // Trust pageCount when the listing supplies it, and otherwise keep going while
    // pages come back full, so a response without pageCount cannot silently
    // truncate the set a diff is computed from.
    const morePages = pageCount ? pageNumber < pageCount : page.length >= 100;
    if (!morePages || page.length === 0) break;
    if (pageNumber >= maxPages) {
      truncated = true;
      break;
    }
    pageNumber += 1;
  }
  return { entities, total, truncated, pagesRead: pageNumber };
}

async function getCode(spec, context, codeId) {
  const body = await readOperation(spec, context, 'getRoutingWrapupcode', { pathParams: { codeId } });
  if (!body?.id) throw new Error(`Wrap-up code ${codeId} did not return a valid record.`);
  return body;
}

async function getQueue(spec, context, queueId) {
  const body = await readOperation(spec, context, 'getRoutingQueue', { pathParams: { queueId } });
  if (!body?.id) throw new Error(`Queue ${queueId} did not return a valid record.`);
  return body;
}

async function queueCodeIds(spec, context, queueId) {
  const { entities, truncated } = await fetchAllPages(spec, context, 'getRoutingQueueWrapupcodes', {
    pathParams: { queueId },
  });
  if (truncated) throw new Error(`Queue ${queueId} has more wrap-up codes than the page cap allows to diff safely.`);
  return { ids: new Set(entities.map((item) => item.id).filter(Boolean)), entities };
}

// Name lookups are a discovery aid, so an ambiguous or absent name must stop the
// command rather than silently pick a similarly named entity.
async function resolveByName(spec, context, kind, names) {
  const operationId = kind === 'code' ? 'getRoutingWrapupcodes' : 'getRoutingQueues';
  const resolved = [];
  const problems = [];
  for (const name of names) {
    const { entities } = await fetchAllPages(spec, context, operationId, { query: { name } });
    const exact = entities.filter((item) => String(item.name || '').toLowerCase() === name.toLowerCase());
    if (exact.length === 1) {
      resolved.push({ name, id: exact[0].id, matched: exact[0].name });
      continue;
    }
    problems.push({
      name,
      reason: exact.length === 0 ? 'no exact match' : 'ambiguous',
      candidates: entities.slice(0, 10).map((item) => ({ id: item.id, name: item.name })),
    });
  }
  return { resolved, problems };
}

async function resolveTargets(spec, context, options, kind) {
  const idOption = kind === 'code' ? 'code-ids' : 'queue-ids';
  const nameOption = kind === 'code' ? 'code-names' : 'queue-names';
  const hasIds = options[idOption] !== undefined;
  const hasNames = options[nameOption] !== undefined;
  if (hasIds && hasNames) throw new Error(`Provide either --${idOption} or --${nameOption}, not both.`);
  if (hasIds) return { ids: parseUuidList(options[idOption], `--${idOption}`), resolvedFromNames: null };
  if (!hasNames) throw new Error(`Missing required option --${idOption} or --${nameOption}.`);
  const names = parseList(options[nameOption], `--${nameOption}`);
  const { resolved, problems } = await resolveByName(spec, context, kind, names);
  if (problems.length) {
    const error = new Error(`Could not uniquely resolve ${kind} name(s): ${problems.map((item) => item.name).join(', ')}.`);
    error.problems = problems;
    throw error;
  }
  return { ids: resolved.map((item) => item.id), resolvedFromNames: resolved };
}

function fanoutSafety(queueIds, writeCount) {
  if (queueIds.length > FANOUT_MAX_QUEUES) {
    throw new Error(`Refusing to fan out across ${queueIds.length} queues; the limit is ${FANOUT_MAX_QUEUES}.`);
  }
  if (writeCount > FANOUT_MAX_WRITES) {
    throw new Error(`Refusing ${writeCount} queued writes; the limit is ${FANOUT_MAX_WRITES}.`);
  }
  return {
    write: writeCount > 0,
    destructive: false,
    highImpact: queueIds.length > FANOUT_HIGH_IMPACT_QUEUES,
  };
}

function fanoutPlan(region, operation, safety, flags, extra) {
  return {
    operation,
    region: region.key,
    safety,
    requiredConfirmations: requiredConfirmations(safety),
    confirmed: confirmationsSatisfied(safety, flags),
    ...extra,
  };
}

async function verifyQueueAssignments(spec, context, queueId, expectPresent, expectAbsent) {
  const { ids } = await queueCodeIds(spec, context, queueId);
  const missing = [...expectPresent].filter((id) => !ids.has(id));
  const lingering = [...expectAbsent].filter((id) => ids.has(id));
  if (missing.length || lingering.length) {
    throw new Error(`Verification failed for queue ${queueId}: missing ${missing.join(', ') || 'none'}; still present ${lingering.join(', ') || 'none'}.`);
  }
  return { queueId, assignedCount: ids.size };
}

// Every wrap-up code reference is discovered by forward lookup because the API
// offers no reverse index, so an unbounded scan is capped and reported as such.
async function codeUsage(spec, context, codeId, scanLimit) {
  const { entities: queues, truncated } = await fetchAllPages(spec, context, 'getRoutingQueues', {});
  const scanned = queues.slice(0, scanLimit);
  const usedBy = [];
  for (const queue of scanned) {
    const { ids } = await queueCodeIds(spec, context, queue.id);
    if (ids.has(codeId)) usedBy.push(summarizeQueue(queue));
  }
  let outbound = null;
  try {
    const mapping = await readOperation(spec, context, 'getOutboundWrapupcodemappings');
    const flags = mapping?.mapping?.[codeId];
    outbound = { mapped: Array.isArray(flags), flags: flags || null };
  } catch (error) {
    // The outbound scope is optional for this skill, so a missing grant must not
    // hide the queue findings that were gathered successfully.
    outbound = {
      mapped: null,
      unavailable: error instanceof ApiError ? `HTTP ${error.status}` : 'unreadable',
    };
  }
  return {
    codeId,
    queuesScanned: scanned.length,
    queuesTotal: queues.length,
    scanTruncated: truncated || queues.length > scanned.length,
    queueReferences: usedBy,
    outboundMapping: outbound,
    note: 'Architect flows, scripts, and historical conversation records can also reference a wrap-up code and are not discoverable through this API.',
  };
}

function pairedRead(operationId, pathParams, response) {
  const pairs = {
    postRoutingWrapupcodes: ['getRoutingWrapupcode', { codeId: response?.id }],
    putRoutingWrapupcode: ['getRoutingWrapupcode', { codeId: pathParams.codeId }],
    deleteRoutingWrapupcode: ['getRoutingWrapupcode', { codeId: pathParams.codeId }, true],
    postRoutingQueueWrapupcodes: ['getRoutingQueueWrapupcodes', { queueId: pathParams.queueId }],
    deleteRoutingQueueWrapupcode: ['getRoutingQueueWrapupcodes', { queueId: pathParams.queueId }],
  };
  return pairs[operationId] || null;
}

function preWriteRead(operationId, pathParams) {
  const pairs = {
    putRoutingWrapupcode: ['getRoutingWrapupcode', { codeId: pathParams.codeId }],
    deleteRoutingWrapupcode: ['getRoutingWrapupcode', { codeId: pathParams.codeId }],
    postRoutingQueueWrapupcodes: ['getRoutingQueueWrapupcodes', { queueId: pathParams.queueId }],
    deleteRoutingQueueWrapupcode: ['getRoutingQueueWrapupcodes', { queueId: pathParams.queueId }],
  };
  return pairs[operationId] || null;
}

async function verifyPair(spec, context, pair) {
  if (!pair) return { available: false };
  const [operationId, pathParams, expectAbsent] = pair;
  try {
    const body = await readOperation(spec, context, operationId, { pathParams });
    if (expectAbsent) throw new Error(`Verification failed: ${operationId} still returns the deleted resource.`);
    return { available: true, operationId, response: sanitizedValue(body) };
  } catch (error) {
    if (expectAbsent && error instanceof ApiError && error.status === 404) {
      return { available: true, operationId, absent: true };
    }
    throw error;
  }
}

function buildCreateBody(options) {
  if (options.body) {
    const body = readJson(options.body, 'Create-code body');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Create-code body must be an object.');
    return body;
  }
  const body = { name: String(requireOption(options, 'name')) };
  if (options.description !== undefined) body.description = String(options.description);
  if (options['division-id'] !== undefined) {
    body.division = { id: requireUuid(options['division-id'], 'division-id') };
  }
  return body;
}

// PUT carries no version and replaces the record outright, so an update that does
// not restate description and division silently drops them.
function buildUpdateBody(options, current) {
  const overrides = options.body ? readJson(options.body, 'Update-code body') : {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Update-code body must be an object.');
  }
  if (options.description !== undefined && options['clear-description']) {
    throw new Error('Use either --description or --clear-description, not both.');
  }
  if (options.replace) {
    if (!options.body) throw new Error('--replace requires --body.');
    return { body: overrides, merged: false };
  }
  const body = { name: current.name };
  if (current.description !== undefined && current.description !== null) body.description = current.description;
  // System-scoped codes report a wildcard division that is not a real division ID
  // and cannot be echoed back on a write.
  if (current.division?.id && current.division.id !== '*') body.division = { id: current.division.id };
  Object.assign(body, overrides);
  if (options.name !== undefined) body.name = String(options.name);
  if (options.description !== undefined) body.description = String(options.description);
  if (options['clear-description']) delete body.description;
  if (options['division-id'] !== undefined) {
    body.division = { id: requireUuid(options['division-id'], 'division-id') };
  }
  return { body, merged: true };
}

function updateDiff(current, body) {
  const before = summarizeCode(current);
  const after = {
    name: body.name ?? null,
    description: body.description ?? null,
    division: body.division ? { id: body.division.id || null } : null,
  };
  const changes = [];
  if (before.name !== after.name) changes.push('name');
  if ((before.description ?? null) !== (after.description ?? null)) changes.push('description');
  // Omitting a system code's wildcard division is deliberate, not a move, so it
  // must not raise the access-control warning.
  const systemScoped = before.division?.id === '*' && after.division === null;
  if (!systemScoped && (before.division?.id ?? null) !== (after.division?.id ?? null)) changes.push('division');
  return { before, after, changes, divisionMove: changes.includes('division') };
}

async function runAssignment(spec, context, options, flags, mode) {
  const queues = await resolveTargets(spec, context, options, 'queue');
  const codes = await resolveTargets(spec, context, options, 'code');

  // Confirm both sides exist before proposing any write, so a typo cannot leave
  // half the queue group changed.
  const codeRecords = [];
  for (const codeId of codes.ids) codeRecords.push(summarizeCode(await getCode(spec, context, codeId)));
  const queueRecords = [];
  for (const queueId of queues.ids) queueRecords.push(summarizeQueue(await getQueue(spec, context, queueId)));

  const desired = new Set(codes.ids);
  const perQueue = [];
  let writeCount = 0;
  for (const queueId of queues.ids) {
    const { ids: assigned } = await queueCodeIds(spec, context, queueId);
    let toAdd = [];
    let toRemove = [];
    if (mode === 'assign') {
      toAdd = codes.ids.filter((id) => !assigned.has(id));
    } else if (mode === 'unassign') {
      toRemove = codes.ids.filter((id) => assigned.has(id));
    } else {
      toAdd = codes.ids.filter((id) => !assigned.has(id));
      toRemove = [...assigned].filter((id) => !desired.has(id));
    }
    writeCount += (toAdd.length ? 1 : 0) + toRemove.length;
    perQueue.push({
      queueId,
      queueName: queueRecords.find((item) => item.id === queueId)?.name ?? null,
      currentlyAssigned: assigned.size,
      toAdd,
      toRemove,
      alreadyCorrect: toAdd.length === 0 && toRemove.length === 0,
    });
  }

  const safety = fanoutSafety(queues.ids, writeCount);
  if (mode !== 'assign' && perQueue.some((item) => item.toRemove.length)) safety.destructive = true;
  if (mode === 'sync') safety.highImpact = true;

  const plan = fanoutPlan(context.region, mode, safety, flags, {
    codes: codeRecords,
    queues: queueRecords,
    resolvedQueueNames: queues.resolvedFromNames,
    resolvedCodeNames: codes.resolvedFromNames,
    plannedWrites: writeCount,
    perQueue,
    permissions: { view: ['routing:queue:view', 'routing:wrapupCode:view'], edit: ['routing:queue:edit'] },
    warning: mode === 'sync'
      ? 'sync-queue-codes removes every wrap-up code that is not in --code-ids from each listed queue.'
      : null,
  });

  if (!writeCount) {
    return { ok: true, dryRun: false, plan, noop: true, note: 'Every listed queue already matches the requested state.' };
  }
  if (!plan.confirmed) {
    return { ok: true, dryRun: true, plan, missingConfirmations: missingConfirmations(safety, flags) };
  }

  // There is no transaction across queues. Stop at the first failure and report
  // exactly which queues were already changed rather than compounding the damage.
  const applied = [];
  let failedQueueId = null;
  try {
    for (const item of perQueue) {
      if (item.alreadyCorrect) continue;
      failedQueueId = item.queueId;
      if (item.toAdd.length) {
        await context.client.request('POST', `/api/v2/routing/queues/${encodeURIComponent(item.queueId)}/wrapupcodes`, {
          body: item.toAdd.map((id) => ({ id })),
        });
      }
      for (const codeId of item.toRemove) {
        await context.client.request(
          'DELETE',
          `/api/v2/routing/queues/${encodeURIComponent(item.queueId)}/wrapupcodes/${encodeURIComponent(codeId)}`,
        );
      }
      const verification = await verifyQueueAssignments(
        spec,
        context,
        item.queueId,
        item.toAdd,
        item.toRemove,
      );
      applied.push({ ...item, verification });
      failedQueueId = null;
    }
  } catch (error) {
    const notAttempted = perQueue
      .filter((item) => !item.alreadyCorrect
        && item.queueId !== failedQueueId
        && !applied.some((done) => done.queueId === item.queueId))
      .map((item) => item.queueId);
    const failure = error instanceof ApiError ? error.toJSON() : { name: error.name, message: error.message };
    const intended = perQueue.filter((item) => !item.alreadyCorrect).length;
    const partial = new Error(`Queue fan-out stopped after ${applied.length} of ${intended} queues.`);
    partial.partialResult = {
      plan,
      applied,
      // The failing queue was already written to, so it can be partly changed and
      // must be re-read rather than assumed untouched or assumed complete.
      failedQueueId,
      notAttempted,
      cause: sanitizedValue(failure),
      recovery: 'Re-run the same command to converge; it diffs each queue before writing.',
    };
    throw partial;
  }

  return { ok: true, dryRun: false, plan, applied, verified: applied.length };
}

async function runCommand(command, options, dependencies = {}) {
  const spec = dependencies.spec || loadSubset(options.spec);
  if (command === 'help') return { text: HELP };
  if (command === 'spec-info') {
    const index = buildOperationIndex(spec);
    return {
      ok: true,
      title: spec.info.title,
      version: spec.info.version,
      swagger: spec.swagger,
      operations: index.size,
      operationIds: [...index.keys()].sort(),
      definitions: Object.keys(spec.definitions || {}).length,
      license: spec.info.license || null,
    };
  }

  const context = createContext(options, dependencies);
  const flags = flagsFrom(options);

  if (command === 'list-codes') {
    const query = {};
    if (options.name) query.name = String(options.name);
    if (options['division-ids']) query.divisionId = parseUuidList(options['division-ids'], '--division-ids');
    if (options['page-size']) query.pageSize = Number(options['page-size']);
    if (options['page-number']) query.pageNumber = Number(options['page-number']);
    // Only the division view can surface deleted codes.
    const useDivisionView = options['include-state'] !== undefined;
    if (useDivisionView) query.includeState = String(options['include-state']);
    const operationId = useDivisionView ? 'getRoutingWrapupcodesDivisionviews' : 'getRoutingWrapupcodes';
    const result = await executeRequest(spec, context, operationId, { query }, flags);
    result.response = summarizeListing(result.response, summarizeCode);
    return result;
  }

  if (command === 'get-code') {
    const codeId = requireUuid(requireOption(options, 'code-id'), 'code-id');
    const result = await executeRequest(spec, context, 'getRoutingWrapupcode', { pathParams: { codeId } }, flags);
    result.response = summarizeCode(result.response);
    return result;
  }

  if (command === 'list-queues') {
    const query = {};
    if (options.name) query.name = String(options.name);
    if (options['division-ids']) query.divisionId = parseUuidList(options['division-ids'], '--division-ids');
    if (options['page-size']) query.pageSize = Number(options['page-size']);
    if (options['page-number']) query.pageNumber = Number(options['page-number']);
    const result = await executeRequest(spec, context, 'getRoutingQueues', { query }, flags);
    result.response = summarizeListing(result.response, summarizeQueue);
    return result;
  }

  if (command === 'list-queue-codes') {
    const queueId = requireUuid(requireOption(options, 'queue-id'), 'queue-id');
    const queue = summarizeQueue(await getQueue(spec, context, queueId));
    const { entities, truncated } = await fetchAllPages(spec, context, 'getRoutingQueueWrapupcodes', {
      pathParams: { queueId },
    });
    return {
      ok: true,
      dryRun: false,
      queue,
      truncated,
      count: entities.length,
      codes: entities.map(summarizeCode),
    };
  }

  if (command === 'resolve-codes' || command === 'resolve-queues') {
    const kind = command === 'resolve-codes' ? 'code' : 'queue';
    const names = parseList(requireOption(options, 'names'), '--names');
    const { resolved, problems } = await resolveByName(spec, context, kind, names);
    return { ok: problems.length === 0, dryRun: false, kind, resolved, problems };
  }

  if (command === 'code-usage') {
    const codeId = requireUuid(requireOption(options, 'code-id'), 'code-id');
    const scanLimit = Math.min(Math.max(Number(options['queue-scan-limit']) || DEFAULT_USAGE_SCAN_QUEUES, 1), 1000);
    const code = summarizeCode(await getCode(spec, context, codeId));
    return { ok: true, dryRun: false, code, usage: await codeUsage(spec, context, codeId, scanLimit) };
  }

  if (command === 'create-code') {
    const body = buildCreateBody(options);
    const result = await executeRequest(spec, context, 'postRoutingWrapupcodes', { body }, flags);
    if (!result.dryRun) {
      const codeId = result.response?.id;
      if (!codeId) throw new Error('Create succeeded but no wrap-up code ID was returned for verification.');
      result.response = summarizeCode(result.response);
      result.verification = summarizeCode(await getCode(spec, context, codeId));
    }
    return result;
  }

  if (command === 'update-code') {
    const codeId = requireUuid(requireOption(options, 'code-id'), 'code-id');
    const current = await getCode(spec, context, codeId);
    const { body, merged } = buildUpdateBody(options, current);
    const diff = updateDiff(current, body);
    if (!diff.changes.length) {
      return {
        ok: true,
        dryRun: false,
        noop: true,
        code: summarizeCode(current),
        note: 'The requested values already match the current wrap-up code.',
      };
    }
    const result = await executeRequest(spec, context, 'putRoutingWrapupcode', {
      pathParams: { codeId },
      body,
    }, flags, {
      merged,
      diff,
      warning: diff.divisionMove
        ? 'Moving a wrap-up code to another division changes which users and queues can access it.'
        : null,
      replacementWarning: merged
        ? null
        : 'A literal --replace body erases any wrap-up code property it does not restate.',
    });
    if (!result.dryRun) {
      result.response = summarizeCode(result.response);
      const verified = summarizeCode(await getCode(spec, context, codeId));
      if (verified.name !== (body.name ?? null)) {
        throw new Error(`Verification failed: expected name ${body.name}, received ${verified.name}.`);
      }
      if ((verified.description ?? null) !== (body.description ?? null)) {
        throw new Error('Verification failed: description does not match the requested value.');
      }
      result.verification = verified;
    }
    return result;
  }

  if (command === 'delete-code') {
    const codeId = requireUuid(requireOption(options, 'code-id'), 'code-id');
    const current = await getCode(spec, context, codeId);
    const usage = options['skip-usage-scan']
      ? { skipped: true }
      : await codeUsage(spec, context, codeId, DEFAULT_USAGE_SCAN_QUEUES);
    const result = await executeRequest(spec, context, 'deleteRoutingWrapupcode', {
      pathParams: { codeId },
    }, flags, {
      before: summarizeCode(current),
      usage,
      warning: 'Deleting a wrap-up code removes it from every queue and breaks any Architect flow, script, or saved report that references it. The delete is soft: the code stops resolving through getRoutingWrapupcode and disappears from the active listing, but it remains readable through the division view with includeState=Deleted, so historical reporting can still resolve the name. This API offers no way to restore it.',
    });
    if (!result.dryRun) {
      try {
        await getCode(spec, context, codeId);
        throw new Error('Delete verification failed: the wrap-up code is still readable.');
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) result.verification = { absent: true };
        else throw error;
      }
    }
    return result;
  }

  if (['assign', 'unassign', 'sync-queue-codes'].includes(command)) {
    const mode = command === 'sync-queue-codes' ? 'sync' : command;
    const assignmentResult = await runAssignment(spec, context, options, flags, mode);
    if (command === 'assign' && (options['session-dir'] || options.file || options.bindings)) {
      try {
        const { writeWrapupSessionHtml } = require('./lib/session-artifact-html');
        const queueIds = options['queue-ids'] || options['queue-names'] || '';
        assignmentResult.htmlHandoff = writeWrapupSessionHtml({
          ...options,
          action: 'assign',
          changeNote: `Wrap-up codes assigned to queue(s): ${queueIds || '(see plan)'}.`,
        });
      } catch {
        assignmentResult.htmlHandoff = { ok: false, skipped: true };
      }
    }
    return assignmentResult;
  }

  const { discoverTelephony } = require('./lib/telephony-discovery');
  const {
    planCreateCodesBatch,
    planBotWrapup,
    applyBotAfterContactFragment,
  } = require('./lib/telephony-automation');

  if (command === 'discover-telephony') {
    return discoverTelephony(context.client, options);
  }

  if (command === 'create-codes-batch') {
    const telephonyDeps = {
      resolveByName,
      buildCreateBody,
      executeRequest,
      getCode,
      spec,
      context,
      flags,
    };
    return planCreateCodesBatch(telephonyDeps, options);
  }

  if (command === 'plan-bot-wrapup') {
    return planBotWrapup({ resolveByName, getCode, spec, context }, options);
  }

  if (command === 'apply-bot-after-contact-fragment') {
    return applyBotAfterContactFragment(options);
  }

  if (command === 'write-session-html') {
    const sessionDir = options['session-dir'];
    if (!sessionDir) throw new Error('write-session-html requires --session-dir <path>.');
    const { writeWrapupSessionHtml } = require('./lib/session-artifact-html');
    const htmlResult = writeWrapupSessionHtml({ ...options, action: 'write-session-html' });
    if (!htmlResult.ok) throw new Error(htmlResult.error);
    return { ok: true, dryRun: false, action: 'write-session-html', ...htmlResult };
  }

  if (command === 'invoke') {
    const operationId = requireOption(options, 'operation-id');
    const pathParams = options['path-params'] ? readJson(options['path-params'], 'Path parameters') : {};
    const query = options.query ? readJson(options.query, 'Query parameters') : {};
    const body = options.body ? readJson(options.body, 'Request body') : undefined;
    const entry = buildOperationIndex(spec).get(operationId);
    if (!entry) throw new Error(`Operation is not allowlisted: ${operationId}`);
    // WrapUpCodeReference declares no required properties, so the OpenAPI model
    // alone accepts [{}] and would silently assign nothing.
    if (operationId === 'postRoutingQueueWrapupcodes') {
      if (!Array.isArray(body) || body.length === 0) {
        throw new Error('postRoutingQueueWrapupcodes requires a non-empty array of wrap-up code references.');
      }
      body.forEach((item, index) => requireUuid(item?.id, `body[${index}].id`));
    }
    const isWrite = ['post', 'put', 'patch', 'delete'].includes(entry.method);
    let before = null;
    if (isWrite) {
      const pair = preWriteRead(operationId, pathParams);
      if (pair) before = sanitizedValue(await readOperation(spec, context, pair[0], { pathParams: pair[1] }));
    }
    const safety = classifySafety(validateAndBuild(spec, operationId, { pathParams, query, body }));
    const result = await executeRequest(spec, context, operationId, { pathParams, query, body }, flags, { before });
    if (!result.dryRun && safety.write) {
      result.verification = await verifyPair(spec, context, pairedRead(operationId, pathParams, result.response));
    }
    return result;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    const result = await runCommand(command, options);
    if (result.text) process.stdout.write(result.text);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const output = error instanceof ApiError ? error.toJSON() : { name: error.name, message: error.message };
    if (error.problems) output.problems = error.problems;
    if (error.candidates) output.candidates = error.candidates;
    if (error.hint) output.hint = error.hint;
    if (error.partialResult) output.partialResult = error.partialResult;
    process.stderr.write(`${JSON.stringify({ ok: false, error: sanitizedValue(output) }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  HELP,
  buildCreateBody,
  buildUpdateBody,
  createContext,
  executeRequest,
  flagsFrom,
  parseArgs,
  parseUuidList,
  readJson,
  runCommand,
  summarizeCode,
  summarizeListing,
  summarizeQueue,
  updateDiff,
};
