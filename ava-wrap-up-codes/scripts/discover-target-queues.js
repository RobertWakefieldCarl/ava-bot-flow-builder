'use strict';

/**
 * Discover routing queues for wrap-up assignment (default: support + sales).
 *
 * Usage:
 *   node discover-target-queues.js [--session-dir <path>] [--include-pattern "support,sales"]
 *   node discover-target-queues.js --queue-names "Support,Sales"
 */

const fs = require('fs');
const path = require('path');
const { runCommand } = require('../../gc-wrapup-codes/scripts/gc-wrapup-codes.js');

function parseArgs(argv) {
  const out = {
    sessionDir: null,
    includePattern: 'support,sales',
    excludePattern: 'test,sandbox,demo',
    queueNames: null,
    queueIds: null,
    mcpConfig: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--session-dir' && argv[i + 1]) out.sessionDir = path.resolve(argv[++i]);
    else if (a === '--include-pattern' && argv[i + 1]) out.includePattern = argv[++i];
    else if (a === '--exclude-pattern' && argv[i + 1]) out.excludePattern = argv[++i];
    else if (a === '--queue-names' && argv[i + 1]) out.queueNames = argv[++i];
    else if (a === '--queue-ids' && argv[i + 1]) out.queueIds = argv[++i];
    else if (a === '--mcp-config' && argv[i + 1]) out.mcpConfig = argv[++i];
  }
  return out;
}

function patterns(csv) {
  return String(csv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}

async function listAllQueues(options) {
  const opts = { 'page-size': '100', 'page-number': '1' };
  if (options['mcp-config']) opts['mcp-config'] = options['mcp-config'];
  const all = [];
  for (let page = 1; page <= 25; page += 1) {
    opts['page-number'] = String(page);
    const res = await runCommand('list-queues', opts);
    const entities = res.response?.entities || res.entities || res.body?.entities || [];
    if (!entities.length) break;
    all.push(...entities);
    if (entities.length < 100) break;
  }
  return all;
}

function matchQueue(name, includeRe, excludeRe) {
  if (excludeRe.some((r) => r.test(name))) return false;
  return includeRe.some((r) => r.test(name));
}

async function main() {
  const args = parseArgs(process.argv);
  const baseOpts = args.mcpConfig ? { 'mcp-config': args.mcpConfig } : {};

  let selected = [];

  if (args.queueIds) {
    selected = args.queueIds.split(',').map((id) => ({ id: id.trim(), name: '(by id)' }));
  } else if (args.queueNames) {
    const res = await runCommand('resolve-queues', {
      ...baseOpts,
      names: args.queueNames,
    });
    selected = (res.resolved || []).map((q) => ({ id: q.id, name: q.matched || q.name }));
  } else {
    const includeRe = patterns(args.includePattern);
    const excludeRe = patterns(args.excludePattern);
    const queues = await listAllQueues(baseOpts);
    selected = queues
      .filter((q) => q.name && matchQueue(q.name, includeRe, excludeRe))
      .map((q) => ({ id: q.id, name: q.name }));
  }

  const payload = {
    ok: true,
    discoveredAt: new Date().toISOString(),
    includePattern: args.includePattern,
    queueCount: selected.length,
    queues: selected,
  };

  if (args.sessionDir) {
    fs.mkdirSync(args.sessionDir, { recursive: true });
    const outFile = path.join(args.sessionDir, 'wrap-up-target-queues.json');
    fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    payload.saved = outFile;
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
