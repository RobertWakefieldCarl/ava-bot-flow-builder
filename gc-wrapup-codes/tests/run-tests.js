#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skillDir = path.resolve(__dirname, '..');
const {
  OPERATION_IDS,
  buildSubset,
  refresh,
  sha256,
} = require('../scripts/refresh-openapi');
const {
  GenesysClient,
  ApiError,
  sanitizedText,
  sanitizedValue,
} = require('../scripts/lib/genesys-client');
const {
  classifySafety,
  confirmationsSatisfied,
  formatQueryArray,
  loadSubset,
  requiredConfirmations,
  validateAndBuild,
} = require('../scripts/lib/openapi-operations');
const { normalizeRegion, resolveTarget } = require('../scripts/lib/regions');
const { resolveMcpCredentials } = require('../scripts/lib/mcp-credentials');
const {
  buildUpdateBody,
  runCommand,
  summarizeCode,
  updateDiff,
} = require('../scripts/gc-wrapup-codes');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const CODE_A = '11111111-1111-4111-8111-111111111111';
const CODE_B = '22222222-2222-4222-8222-222222222222';
const CODE_C = '33333333-3333-4333-8333-333333333333';
const QUEUE_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const QUEUE_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DIVISION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function digest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(dir, name, value) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function fakeDependencies(client, spec = loadSubset()) {
  return {
    spec,
    client,
    resolveCredentials: () => ({
      clientId: 'fixture-client',
      clientSecret: 'fixture-secret',
      habitat: 'test-use1-ai',
    }),
    resolveRegion: () => ({
      key: 'test_use1_ai',
      host: 'inintca.com',
      apiBase: 'https://api.inintca.com',
      loginBase: 'https://login.inintca.com',
    }),
  };
}

function listing(entities) {
  return { entities, total: entities.length, pageSize: 100, pageNumber: 1, pageCount: 1 };
}

// A routing fixture that behaves like the real association model: codes exist
// org-wide and queues hold a mutable set of references to them.
function routingFixture({ codes, queues, assignments, failOn }) {
  const state = {
    codes: new Map(Object.entries(codes)),
    queues: new Map(Object.entries(queues)),
    assignments: new Map(Object.entries(assignments).map(([id, list]) => [id, new Set(list)])),
    calls: [],
  };
  const client = {
    secrets: [],
    addSecret() {},
    async request(method, apiPath, options = {}) {
      state.calls.push({ method, apiPath, body: options.body });
      if (failOn && failOn(method, apiPath, state)) {
        throw new ApiError('forbidden', { status: 403, code: 'missing.permissions' });
      }
      const queueCodes = apiPath.match(/^\/api\/v2\/routing\/queues\/([^/]+)\/wrapupcodes$/);
      const queueCode = apiPath.match(/^\/api\/v2\/routing\/queues\/([^/]+)\/wrapupcodes\/([^/]+)$/);
      const queue = apiPath.match(/^\/api\/v2\/routing\/queues\/([^/]+)$/);
      const code = apiPath.match(/^\/api\/v2\/routing\/wrapupcodes\/([^/]+)$/);

      if (queueCode && method === 'DELETE') {
        state.assignments.get(queueCode[1]).delete(queueCode[2]);
        return { status: 204, body: null };
      }
      if (queueCodes && method === 'POST') {
        for (const item of options.body) state.assignments.get(queueCodes[1]).add(item.id);
        return { status: 200, body: [...state.assignments.get(queueCodes[1])].map((id) => state.codes.get(id)) };
      }
      if (queueCodes && method === 'GET') {
        return {
          status: 200,
          body: listing([...state.assignments.get(queueCodes[1])].map((id) => state.codes.get(id))),
        };
      }
      if (apiPath.startsWith('/api/v2/routing/queues?') || apiPath === '/api/v2/routing/queues') {
        return { status: 200, body: listing([...state.queues.values()]) };
      }
      if (queue && method === 'GET') {
        const found = state.queues.get(queue[1]);
        if (!found) throw new ApiError('not found', { status: 404 });
        return { status: 200, body: found };
      }
      if (apiPath === '/api/v2/routing/wrapupcodes' && method === 'GET') {
        return { status: 200, body: listing([...state.codes.values()]) };
      }
      if (apiPath === '/api/v2/routing/wrapupcodes' && method === 'POST') {
        const created = { id: CODE_C, ...options.body, division: options.body.division || { id: DIVISION } };
        state.codes.set(CODE_C, created);
        return { status: 200, body: created };
      }
      if (code && method === 'GET') {
        const found = state.codes.get(code[1]);
        if (!found) throw new ApiError('not found', { status: 404 });
        return { status: 200, body: found };
      }
      if (code && method === 'PUT') {
        const updated = { id: code[1], ...options.body };
        state.codes.set(code[1], updated);
        return { status: 200, body: updated };
      }
      if (code && method === 'DELETE') {
        state.codes.delete(code[1]);
        for (const set of state.assignments.values()) set.delete(code[1]);
        return { status: 204, body: null };
      }
      if (apiPath === '/api/v2/outbound/wrapupcodemappings') {
        return { status: 200, body: { mapping: {}, defaultSet: [] } };
      }
      throw new Error(`Unexpected fixture request: ${method} ${apiPath}`);
    },
  };
  return { client, state };
}

function standardFixture(overrides = {}) {
  return routingFixture({
    codes: {
      [CODE_A]: { id: CODE_A, name: 'Resolved', description: 'Original text', division: { id: DIVISION, name: 'Home' } },
      [CODE_B]: { id: CODE_B, name: 'Escalated', description: null, division: { id: DIVISION, name: 'Home' } },
    },
    queues: {
      [QUEUE_1]: { id: QUEUE_1, name: 'Support', division: { id: DIVISION, name: 'Home' } },
      [QUEUE_2]: { id: QUEUE_2, name: 'Billing', division: { id: DIVISION, name: 'Home' } },
    },
    assignments: { [QUEUE_1]: [CODE_A], [QUEUE_2]: [] },
    ...overrides,
  });
}

test('pinned OpenAPI hashes and metadata match', () => {
  const openapiDir = path.join(skillDir, 'references', 'openapi');
  const metadata = JSON.parse(fs.readFileSync(path.join(openapiDir, 'metadata.json'), 'utf8'));
  assert.equal(metadata.full.sha256, digest(path.join(openapiDir, metadata.full.file)));
  assert.equal(metadata.subset.sha256, digest(path.join(openapiDir, metadata.subset.file)));
  assert.equal(metadata.subset.operations, OPERATION_IDS.length);
  assert.equal(metadata.title, 'PureCloud Platform API');
  assert.equal(metadata.upstreamLicense.name, 'UNLICENSED');
});

test('full definition deterministically builds the allowlisted subset', () => {
  const fullPath = path.join(skillDir, 'references', 'openapi', 'purecloud-platform-api-v2.json');
  const fullBuffer = fs.readFileSync(fullPath);
  const subset = buildSubset(JSON.parse(fullBuffer.toString('utf8')));
  assert.equal(subset.swagger, '2.0');
  assert.equal(subset['x-gc-wrapup-codes'].operationIds.length, OPERATION_IDS.length);
  assert.equal(new Set(OPERATION_IDS).size, OPERATION_IDS.length);
  assert.match(sha256(fullBuffer), /^[0-9a-f]{64}$/);
});

test('subset contains exactly the allowlisted non-deprecated operations', () => {
  const spec = loadSubset();
  const operations = [];
  for (const item of Object.values(spec.paths)) {
    for (const operation of Object.values(item)) {
      if (operation?.operationId) operations.push(operation);
    }
  }
  assert.equal(operations.length, OPERATION_IDS.length);
  assert.deepEqual(new Set(operations.map((item) => item.operationId)), new Set(OPERATION_IDS));
  assert.equal(operations.some((item) => item.deprecated), false);
});

test('excluded high-blast-radius routing operations stay out of the subset', () => {
  const spec = loadSubset();
  const ids = new Set();
  for (const item of Object.values(spec.paths)) {
    for (const operation of Object.values(item)) if (operation?.operationId) ids.add(operation.operationId);
  }
  for (const forbidden of [
    'deleteRoutingQueue',
    'putRoutingQueue',
    'postRoutingQueues',
    'putOutboundWrapupcodemappings',
    'postRoutingQueueMembers',
  ]) {
    assert.equal(ids.has(forbidden), false, `${forbidden} must not be allowlisted`);
  }
});

test('OpenAPI refresh is gated and uses atomic replacement', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wrapup-openapi-'));
  try {
    const input = path.join(skillDir, 'references', 'openapi', 'purecloud-platform-api-v2.json');
    await assert.rejects(() => refresh({ input, 'output-dir': dir }), /confirm-refresh/);
    const first = await refresh({ input, 'output-dir': dir, 'confirm-refresh': true });
    const second = await refresh({ input, 'output-dir': dir, 'confirm-refresh': true });
    assert.equal(first.subset.sha256, second.subset.sha256);
    assert.equal(first.subset.operations, OPERATION_IDS.length);
    assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp') || name.endsWith('.bak')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skill metadata and progressive references are valid', () => {
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: gc-wrapup-codes\r?\n/);
  assert.ok(skill.split(/\r?\n/).length < 500);
  for (const relative of [
    'README.md',
    'NOTICE.md',
    'references/API_REFERENCE.md',
    'references/SAFETY.md',
    'scripts/gc-wrapup-codes.js',
    'scripts/refresh-openapi.js',
    'scripts/rebuild-subset.js',
    'examples/create-wrapup-code.json',
  ]) {
    assert.equal(fs.existsSync(path.join(skillDir, relative)), true, `${relative} must exist`);
  }
});

test('region normalization supports production and AVA test habitats', () => {
  assert.equal(normalizeRegion('prod-usw2').apiBase, 'https://api.usw2.pure.cloud');
  assert.equal(normalizeRegion('test-use1-ai').apiBase, 'https://api.inintca.com');
  assert.throws(() => normalizeRegion('https://api.mypurecloud.com/path'), /only an approved/);
  assert.throws(() => resolveTarget({ habitat: 'prod-usw2' }, 'prod-use1'), /does not match/);
});

test('MCP credentials resolve from a synthetic harness fixture only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wrapup-mcp-'));
  try {
    const filePath = writeJson(dir, 'mcp.json', {
      mcpServers: {
        'ava-harness': {
          command: 'uv',
          args: ['run', 'ava-mcp'],
          env: {
            GENESYS_CLIENT_ID: 'synthetic-id',
            GENESYS_CLIENT_SECRET: 'synthetic-secret',
            AVA_HABITAT: 'prod-usw2',
          },
        },
      },
    });
    const credentials = resolveMcpCredentials({ configPath: filePath });
    assert.equal(credentials.clientId, 'synthetic-id');
    assert.equal(credentials.habitat, 'prod-usw2');
    const placeholder = writeJson(dir, 'placeholder.json', {
      mcpServers: {
        'ava-harness': {
          env: { GENESYS_CLIENT_ID: 'YOUR_ID', GENESYS_CLIENT_SECRET: 'YOUR_SECRET', AVA_HABITAT: 'prod' },
        },
      },
    });
    assert.throws(() => resolveMcpCredentials({ configPath: placeholder }), /placeholder/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('operation builder rejects unknown operations and parameters', () => {
  const spec = loadSubset();
  assert.throws(() => validateAndBuild(spec, 'deleteEverything', {}), /not allowlisted/);
  assert.throws(
    () => validateAndBuild(spec, 'getRoutingWrapupcode', { pathParams: { codeId: CODE_A, extra: 'y' } }),
    /Unknown path parameter/,
  );
  assert.throws(
    () => validateAndBuild(spec, 'getRoutingWrapupcodes', { query: { bogus: 1 } }),
    /Unknown query parameter/,
  );
  assert.equal(validateAndBuild(spec, 'getRoutingWrapupcodes', { query: { pageSize: 999 } }).query.pageSize, 100);
});

test('multi collection format is preserved while csv is joined', () => {
  const spec = loadSubset();
  const request = validateAndBuild(spec, 'getRoutingWrapupcodes', {
    query: { divisionId: [DIVISION, CODE_A] },
  });
  assert.deepEqual(request.query.divisionId, [DIVISION, CODE_A]);
  assert.equal(formatQueryArray('q.ids', ['a', 'b'], { collectionFormat: 'csv' }), 'a,b');
  assert.deepEqual(formatQueryArray('q.ids', ['a', 'b'], { collectionFormat: 'multi' }), ['a', 'b']);
});

test('client repeats multi-format query values instead of comma joining', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ entities: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = new GenesysClient({
    region: normalizeRegion('prod-usw2'),
    clientId: 'id',
    clientSecret: 'secret',
    fetchImpl,
  });
  await client.request('GET', '/api/v2/routing/wrapupcodes', { query: { divisionId: ['one', 'two'] } });
  const target = seen.find((url) => url.includes('wrapupcodes'));
  assert.match(target, /divisionId=one&divisionId=two/);
  assert.doesNotMatch(target, /divisionId=one%2Ctwo/);
});

test('wrap-up code request schemas are enforced', () => {
  const spec = loadSubset();
  assert.throws(() => validateAndBuild(spec, 'postRoutingWrapupcodes', {}), /requires a request body/);
  assert.throws(
    () => validateAndBuild(spec, 'postRoutingWrapupcodes', { body: { description: 'no name' } }),
    /body\.name is required/,
  );
  assert.throws(
    () => validateAndBuild(spec, 'postRoutingWrapupcodes', { body: { name: 42 } }),
    /body\.name must be a string/,
  );
  assert.throws(
    () => validateAndBuild(spec, 'getRoutingWrapupcodesDivisionviews', { query: { includeState: 'Everything' } }),
    /must be one of/,
  );
});

test('bundled examples satisfy their OpenAPI request schemas', () => {
  const spec = loadSubset();
  const create = JSON.parse(fs.readFileSync(path.join(skillDir, 'examples', 'create-wrapup-code.json'), 'utf8'));
  validateAndBuild(spec, 'postRoutingWrapupcodes', { body: create });
  const assignment = JSON.parse(fs.readFileSync(path.join(skillDir, 'examples', 'queue-wrapup-assignment.json'), 'utf8'));
  validateAndBuild(spec, 'postRoutingQueueWrapupcodes', { pathParams: { queueId: QUEUE_1 }, body: assignment });
  // The update example is a partial override, so it is only valid once merged.
  const update = JSON.parse(fs.readFileSync(path.join(skillDir, 'examples', 'update-wrapup-code.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wrapup-example-'));
  try {
    const bodyPath = writeJson(dir, 'update.json', update);
    const { body } = buildUpdateBody({ body: bodyPath }, {
      id: CODE_A, name: 'Resolved', description: 'Old', division: { id: DIVISION },
    });
    validateAndBuild(spec, 'putRoutingWrapupcode', { pathParams: { codeId: CODE_A }, body });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('confirmation policy separates create, update, and delete', () => {
  const spec = loadSubset();
  const create = classifySafety(validateAndBuild(spec, 'postRoutingWrapupcodes', { body: { name: 'New' } }));
  assert.deepEqual(requiredConfirmations(create), ['--confirm-apply']);
  // No version field means PUT is an unconditional full replacement.
  const update = classifySafety(validateAndBuild(spec, 'putRoutingWrapupcode', {
    pathParams: { codeId: CODE_A },
    body: { name: 'New' },
  }));
  assert.deepEqual(requiredConfirmations(update), ['--confirm-apply', '--confirm-high-impact']);
  const remove = classifySafety(validateAndBuild(spec, 'deleteRoutingWrapupcode', { pathParams: { codeId: CODE_A } }));
  assert.deepEqual(requiredConfirmations(remove), ['--confirm-apply', '--confirm-delete', '--confirm-high-impact']);
  assert.equal(confirmationsSatisfied(remove, { confirmApply: true, confirmDelete: true }), false);
  const unassign = classifySafety(validateAndBuild(spec, 'deleteRoutingQueueWrapupcode', {
    pathParams: { queueId: QUEUE_1, codeId: CODE_A },
  }));
  assert.deepEqual(requiredConfirmations(unassign), ['--confirm-apply', '--confirm-delete']);
});

test('update merges onto the current record so omitted fields survive replacement', () => {
  const current = {
    id: CODE_A,
    name: 'Resolved',
    description: 'Original text',
    division: { id: DIVISION, name: 'Home' },
  };
  const { body, merged } = buildUpdateBody({ name: 'Resolved v2' }, current);
  assert.equal(merged, true);
  assert.equal(body.name, 'Resolved v2');
  assert.equal(body.description, 'Original text');
  assert.deepEqual(body.division, { id: DIVISION });
  const cleared = buildUpdateBody({ 'clear-description': true }, current).body;
  assert.equal('description' in cleared, false);
  assert.equal(cleared.name, 'Resolved');
  assert.throws(() => buildUpdateBody({ description: 'x', 'clear-description': true }, current), /not both/);
  assert.throws(() => buildUpdateBody({ replace: true }, current), /--replace requires --body/);
});

test('a wildcard system division is not echoed back nor reported as a move', () => {
  const system = { id: CODE_A, name: 'Transferred to flow', description: '', division: { id: '*', name: null } };
  const { body } = buildUpdateBody({ description: 'Set by admin' }, system);
  assert.equal('division' in body, false);
  assert.equal(body.name, 'Transferred to flow');
  assert.equal(body.description, 'Set by admin');
  const diff = updateDiff(system, body);
  assert.deepEqual(diff.changes, ['description']);
  assert.equal(diff.divisionMove, false);
});

test('update diff reports a division move separately from a rename', () => {
  const current = { id: CODE_A, name: 'A', description: 'd', division: { id: DIVISION } };
  const rename = updateDiff(current, { name: 'B', description: 'd', division: { id: DIVISION } });
  assert.deepEqual(rename.changes, ['name']);
  assert.equal(rename.divisionMove, false);
  const move = updateDiff(current, { name: 'A', description: 'd', division: { id: CODE_B } });
  assert.deepEqual(move.changes, ['division']);
  assert.equal(move.divisionMove, true);
});

test('update-code dry-run reads current state and performs no write', async () => {
  const { client, state } = standardFixture();
  const result = await runCommand('update-code', {
    'code-id': CODE_A,
    description: 'Updated text',
  }, fakeDependencies(client));
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.body.description, 'Updated text');
  assert.equal(result.plan.body.name, 'Resolved');
  assert.deepEqual(result.missingConfirmations, ['--confirm-apply', '--confirm-high-impact']);
  assert.equal(state.calls.every((call) => call.method === 'GET'), true);
});

test('update-code applies, verifies, and preserves the untouched description', async () => {
  const { client, state } = standardFixture();
  const result = await runCommand('update-code', {
    'code-id': CODE_A,
    name: 'Resolved v2',
    'confirm-apply': true,
    'confirm-high-impact': true,
  }, fakeDependencies(client));
  assert.equal(result.dryRun, false);
  assert.equal(result.verification.name, 'Resolved v2');
  assert.equal(result.verification.description, 'Original text');
  assert.deepEqual(state.calls.map((call) => call.method), ['GET', 'PUT', 'GET']);
});

test('update-code is a no-op when nothing would change', async () => {
  const { client, state } = standardFixture();
  const result = await runCommand('update-code', {
    'code-id': CODE_A,
    name: 'Resolved',
  }, fakeDependencies(client));
  assert.equal(result.noop, true);
  assert.equal(state.calls.some((call) => call.method === 'PUT'), false);
});

test('create-code builds a request from flags and verifies the result', async () => {
  const { client } = standardFixture();
  const result = await runCommand('create-code', {
    name: 'Callback Scheduled',
    description: 'Agent scheduled a callback',
    'division-id': DIVISION,
    'confirm-apply': true,
  }, fakeDependencies(client));
  assert.equal(result.dryRun, false);
  assert.equal(result.plan.body.name, 'Callback Scheduled');
  assert.equal(result.verification.id, CODE_C);
  assert.equal(result.verification.description, 'Agent scheduled a callback');
});

test('delete-code reports queue usage in the dry-run plan', async () => {
  const { client, state } = standardFixture();
  const result = await runCommand('delete-code', { 'code-id': CODE_A }, fakeDependencies(client));
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.missingConfirmations, ['--confirm-apply', '--confirm-delete', '--confirm-high-impact']);
  assert.deepEqual(result.plan.usage.queueReferences.map((item) => item.name), ['Support']);
  assert.match(result.plan.warning, /Architect flow/);
  assert.equal(state.calls.some((call) => call.method === 'DELETE'), false);
});

test('delete-code verifies the code is gone after applying', async () => {
  const { client } = standardFixture();
  const result = await runCommand('delete-code', {
    'code-id': CODE_B,
    'skip-usage-scan': true,
    'confirm-apply': true,
    'confirm-delete': true,
    'confirm-high-impact': true,
  }, fakeDependencies(client));
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.verification, { absent: true });
  assert.deepEqual(result.plan.usage, { skipped: true });
});

test('assign diffs each queue and skips codes already present', async () => {
  const { client } = standardFixture();
  const result = await runCommand('assign', {
    'queue-ids': `${QUEUE_1},${QUEUE_2}`,
    'code-ids': CODE_A,
  }, fakeDependencies(client));
  assert.equal(result.dryRun, true);
  const support = result.plan.perQueue.find((item) => item.queueId === QUEUE_1);
  const billing = result.plan.perQueue.find((item) => item.queueId === QUEUE_2);
  assert.deepEqual(support.toAdd, []);
  assert.equal(support.alreadyCorrect, true);
  assert.deepEqual(billing.toAdd, [CODE_A]);
  assert.equal(result.plan.plannedWrites, 1);
  assert.deepEqual(result.missingConfirmations, ['--confirm-apply']);
});

test('assign applies to a queue group and verifies each queue', async () => {
  const { client, state } = standardFixture();
  const result = await runCommand('assign', {
    'queue-ids': `${QUEUE_1},${QUEUE_2}`,
    'code-ids': `${CODE_A},${CODE_B}`,
    'confirm-apply': true,
  }, fakeDependencies(client));
  assert.equal(result.dryRun, false);
  assert.equal(result.verified, 2);
  assert.deepEqual([...state.assignments.get(QUEUE_1)].sort(), [CODE_A, CODE_B].sort());
  assert.deepEqual([...state.assignments.get(QUEUE_2)].sort(), [CODE_A, CODE_B].sort());
});

test('assign is a no-op when every queue already matches', async () => {
  const { client, state } = standardFixture();
  const result = await runCommand('assign', {
    'queue-ids': QUEUE_1,
    'code-ids': CODE_A,
    'confirm-apply': true,
  }, fakeDependencies(client));
  assert.equal(result.noop, true);
  assert.equal(state.calls.some((call) => call.method === 'POST'), false);
});

test('unassign is destructive and leaves the code definition intact', async () => {
  const { client, state } = standardFixture();
  const gated = await runCommand('unassign', {
    'queue-ids': QUEUE_1,
    'code-ids': CODE_A,
    'confirm-apply': true,
  }, fakeDependencies(client));
  assert.equal(gated.dryRun, true);
  assert.deepEqual(gated.missingConfirmations, ['--confirm-delete']);

  const result = await runCommand('unassign', {
    'queue-ids': QUEUE_1,
    'code-ids': CODE_A,
    'confirm-apply': true,
    'confirm-delete': true,
  }, fakeDependencies(client));
  assert.equal(result.dryRun, false);
  assert.deepEqual([...state.assignments.get(QUEUE_1)], []);
  assert.equal(state.codes.has(CODE_A), true);
});

test('sync-queue-codes removes codes outside the requested set', async () => {
  const { client, state } = standardFixture();
  const plan = await runCommand('sync-queue-codes', {
    'queue-ids': QUEUE_1,
    'code-ids': CODE_B,
  }, fakeDependencies(client));
  assert.equal(plan.dryRun, true);
  assert.equal(plan.plan.safety.highImpact, true);
  assert.equal(plan.plan.safety.destructive, true);
  assert.match(plan.plan.warning, /removes every wrap-up code/);
  const target = plan.plan.perQueue[0];
  assert.deepEqual(target.toAdd, [CODE_B]);
  assert.deepEqual(target.toRemove, [CODE_A]);

  const applied = await runCommand('sync-queue-codes', {
    'queue-ids': QUEUE_1,
    'code-ids': CODE_B,
    'confirm-apply': true,
    'confirm-delete': true,
    'confirm-high-impact': true,
  }, fakeDependencies(client));
  assert.equal(applied.dryRun, false);
  assert.deepEqual([...state.assignments.get(QUEUE_1)], [CODE_B]);
});

test('a wide fan-out requires high-impact confirmation and is capped', async () => {
  const queues = {};
  const assignments = {};
  for (let index = 0; index < 8; index += 1) {
    const id = `cccccccc-cccc-4ccc-8ccc-00000000000${index}`;
    queues[id] = { id, name: `Queue ${index}`, division: { id: DIVISION } };
    assignments[id] = [];
  }
  const { client } = routingFixture({
    codes: { [CODE_A]: { id: CODE_A, name: 'Resolved', division: { id: DIVISION } } },
    queues,
    assignments,
  });
  const result = await runCommand('assign', {
    'queue-ids': Object.keys(queues).join(','),
    'code-ids': CODE_A,
    'confirm-apply': true,
  }, fakeDependencies(client));
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.safety.highImpact, true);
  assert.deepEqual(result.missingConfirmations, ['--confirm-high-impact']);
});

test('a partial fan-out failure reports applied, failed, and untouched queues', async () => {
  const { client, state } = standardFixture({
    assignments: { [QUEUE_1]: [], [QUEUE_2]: [] },
    failOn: (method, apiPath) => method === 'POST' && apiPath.includes(QUEUE_2),
  });
  await assert.rejects(
    () => runCommand('assign', {
      'queue-ids': `${QUEUE_1},${QUEUE_2}`,
      'code-ids': CODE_B,
      'confirm-apply': true,
    }, fakeDependencies(client)),
    (error) => {
      assert.match(error.message, /stopped after 1 of 2 queues/);
      assert.deepEqual(error.partialResult.applied.map((item) => item.queueId), [QUEUE_1]);
      assert.equal(error.partialResult.failedQueueId, QUEUE_2);
      assert.deepEqual(error.partialResult.notAttempted, []);
      assert.equal(error.partialResult.cause.status, 403);
      return true;
    },
  );
  assert.deepEqual([...state.assignments.get(QUEUE_1)], [CODE_B]);
});

test('a nonexistent target is rejected before any write is planned', async () => {
  const { client, state } = standardFixture();
  await assert.rejects(
    () => runCommand('assign', {
      'queue-ids': QUEUE_1,
      'code-ids': '99999999-9999-4999-8999-999999999999',
      'confirm-apply': true,
    }, fakeDependencies(client)),
    (error) => error instanceof ApiError && error.status === 404,
  );
  assert.equal(state.calls.some((call) => call.method === 'POST'), false);
});

test('assignment arguments reject non-UUIDs, duplicates, and mixed selectors', async () => {
  const { client } = standardFixture();
  const deps = fakeDependencies(client);
  await assert.rejects(
    () => runCommand('assign', { 'queue-ids': QUEUE_1, 'code-ids': 'Resolved' }, deps),
    /must be a UUID/,
  );
  await assert.rejects(
    () => runCommand('assign', { 'queue-ids': `${QUEUE_1},${QUEUE_1}`, 'code-ids': CODE_A }, deps),
    /duplicate values/,
  );
  await assert.rejects(
    () => runCommand('assign', { 'queue-ids': QUEUE_1, 'code-ids': CODE_A, 'code-names': 'Resolved' }, deps),
    /not both/,
  );
  await assert.rejects(
    () => runCommand('assign', { 'code-ids': CODE_A }, deps),
    /--queue-ids or --queue-names/,
  );
});

test('an ambiguous or unknown name refuses to resolve into a mutation', async () => {
  const { client } = routingFixture({
    codes: {
      [CODE_A]: { id: CODE_A, name: 'Resolved', division: { id: DIVISION } },
      [CODE_B]: { id: CODE_B, name: 'Resolved', division: { id: DIVISION } },
    },
    queues: { [QUEUE_1]: { id: QUEUE_1, name: 'Support', division: { id: DIVISION } } },
    assignments: { [QUEUE_1]: [] },
  });
  await assert.rejects(
    () => runCommand('assign', {
      'queue-names': 'Support',
      'code-names': 'Resolved',
      'confirm-apply': true,
    }, fakeDependencies(client)),
    (error) => {
      assert.match(error.message, /Could not uniquely resolve code name/);
      assert.equal(error.problems[0].reason, 'ambiguous');
      return true;
    },
  );
  await assert.rejects(
    () => runCommand('resolve-queues', { names: 'Nonexistent' }, fakeDependencies(client))
      .then((result) => {
        assert.equal(result.ok, false);
        assert.equal(result.problems[0].reason, 'no exact match');
        throw new Error('sentinel');
      }),
    /sentinel/,
  );
});

test('queue names resolve to IDs for an assignment', async () => {
  const { client, state } = standardFixture();
  const result = await runCommand('assign', {
    'queue-names': 'Billing',
    'code-names': 'Escalated',
    'confirm-apply': true,
  }, fakeDependencies(client));
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.plan.resolvedQueueNames, [{ name: 'Billing', id: QUEUE_2, matched: 'Billing' }]);
  assert.deepEqual([...state.assignments.get(QUEUE_2)], [CODE_B]);
});

test('invoke rejects a queue assignment body without real code references', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wrapup-invoke-'));
  try {
    const { client } = standardFixture();
    const pathFile = writeJson(dir, 'path.json', { queueId: QUEUE_1 });
    const emptyRefs = writeJson(dir, 'body.json', [{}]);
    await assert.rejects(
      () => runCommand('invoke', {
        'operation-id': 'postRoutingQueueWrapupcodes',
        'path-params': pathFile,
        body: emptyRefs,
        'confirm-apply': true,
      }, fakeDependencies(client)),
      /body\[0\]\.id must be a UUID/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('list-queue-codes reports the full assignment set for one queue', async () => {
  const { client } = standardFixture();
  const result = await runCommand('list-queue-codes', { 'queue-id': QUEUE_1 }, fakeDependencies(client));
  assert.equal(result.queue.name, 'Support');
  assert.equal(result.count, 1);
  assert.deepEqual(result.codes.map((item) => item.name), ['Resolved']);
  assert.equal(result.truncated, false);
});

test('code summaries keep identifying fields and drop server noise', () => {
  const summary = summarizeCode({
    id: CODE_A,
    name: 'Resolved',
    description: 'text',
    division: { id: DIVISION, name: 'Home' },
    dateModified: '2026-01-01T00:00:00Z',
    selfUri: '/api/v2/routing/wrapupcodes/x',
    createdBy: 'someone',
  });
  assert.equal(summary.name, 'Resolved');
  assert.equal('selfUri' in summary, false);
  assert.equal('createdBy' in summary, false);
});

test('secret redaction is recursive and bounded', () => {
  const value = sanitizedValue({
    client_secret: 'shhh',
    nested: { authorization: 'Bearer abc', message: 'literal-secret' },
  }, ['literal-secret']);
  assert.equal(value.client_secret, '[REDACTED]');
  assert.equal(value.nested.authorization, '[REDACTED]');
  assert.equal(value.nested.message, '[REDACTED]');
  assert.doesNotMatch(sanitizedText('Authorization: Bearer abc'), /Bearer abc/);
});

test('HTTP client honors Retry-After for bounded read retries', async () => {
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (calls === 2) {
      return new Response(JSON.stringify({ message: 'slow down' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '2' },
      });
    }
    return new Response(JSON.stringify({ id: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = new GenesysClient({
    region: normalizeRegion('prod-usw2'),
    clientId: 'id',
    clientSecret: 'secret',
    fetchImpl,
    sleep: async (ms) => sleeps.push(ms),
  });
  const result = await client.request('GET', '/api/v2/routing/wrapupcodes');
  assert.equal(result.body.id, 'ok');
  assert.deepEqual(sleeps, [2000]);
});

test('HTTP client does not retry an ambiguous write failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ message: 'server failure' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = new GenesysClient({
    region: normalizeRegion('prod-usw2'),
    clientId: 'id',
    clientSecret: 'secret',
    fetchImpl,
  });
  await assert.rejects(
    () => client.request('POST', '/api/v2/routing/queues/x/wrapupcodes', { body: [{ id: CODE_A }] }),
    (error) => error instanceof ApiError && error.status === 500,
  );
  assert.equal(calls, 2);
});

test('the client refuses a non-Platform-API path', async () => {
  const client = new GenesysClient({
    region: normalizeRegion('prod-usw2'),
    clientId: 'id',
    clientSecret: 'secret',
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
  await assert.rejects(() => client.request('GET', '/internal/routing'), /Refusing non-Platform-API path/);
});

async function main() {
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(`FAIL ${name}\n${error.stack || error.message}\n`);
    }
  }
  process.stdout.write(`\n${tests.length - failures}/${tests.length} tests passed\n`);
  if (failures) process.exitCode = 1;
}

main();
