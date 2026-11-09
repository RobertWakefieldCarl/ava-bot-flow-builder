'use strict';

/**
 * Shared Genesys Cloud plumbing for ava-bot-flow-builder.
 * Credentials, region normalisation and the HTTP client are reused from the
 * gc-wrapup-codes engine so both skills authenticate identically.
 */

const fs = require('fs');
const path = require('path');

function engineLib(file) {
  const resolved = path.resolve(__dirname, '..', '..', '..', 'gc-wrapup-codes', 'scripts', 'lib', file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`gc-wrapup-codes engine not found at ${resolved}. Install gc-wrapup-codes alongside ava-bot-flow-builder.`);
  }
  return require(resolved);
}

const { resolveMcpCredentials } = engineLib('mcp-credentials.js');
const { resolveTarget } = engineLib('regions.js');
const { GenesysClient, ApiError } = engineLib('genesys-client.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function makeClient(args = {}) {
  const credentials = resolveMcpCredentials({ configPath: args['mcp-config'] });
  const region = resolveTarget(credentials, args.region);
  const client = new GenesysClient({
    region,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    sleep,
  });
  return { client, region, serverKey: credentials.serverKey };
}

async function orgIdentity(client) {
  const { body } = await client.request('GET', '/api/v2/organizations/me');
  return { orgId: body.id, orgName: body.name, thirdPartyOrgName: body.thirdPartyOrgName || null };
}

/** Walk every page of a Platform API collection endpoint. */
async function pageAll(client, apiPath, query = {}, pageSize = 100, cap = 50) {
  const entities = [];
  for (let page = 1; page <= cap; page += 1) {
    const { body } = await client.request('GET', apiPath, { query: { ...query, pageSize, pageNumber: page } });
    const batch = body?.entities || [];
    entities.push(...batch);
    const pageCount = body?.pageCount ?? (batch.length < pageSize ? page : page + 1);
    if (batch.length < pageSize || page >= pageCount) break;
  }
  return entities;
}

function slugify(value) {
  return String(value || 'flow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'flow';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function writeJson(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return resolved;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(error) {
  const body = {
    ok: false,
    error: {
      message: error?.message || String(error),
      status: error?.status || null,
      details: error?.details || null,
      hint: error?.hint || null,
    },
  };
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  process.exitCode = 1;
}

module.exports = {
  ApiError,
  UUID,
  emit,
  engineLib,
  fail,
  makeClient,
  orgIdentity,
  pageAll,
  parseArgs,
  readJson,
  sleep,
  slugify,
  writeJson,
};
