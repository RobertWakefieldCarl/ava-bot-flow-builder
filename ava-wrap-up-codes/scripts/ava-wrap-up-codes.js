'use strict';

/**
 * AXL wrap-up orchestrator — delegates to gc-wrapup-codes engine + local generators.
 *
 *   node ava-wrap-up-codes.js whoami
 *   node ava-wrap-up-codes.js plan-axl --session-dir ... --lifecycle-dir ...
 *   node ava-wrap-up-codes.js apply-axl ... --confirm-apply [--confirm-high-impact]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { runCommand, createContext } = require('../../gc-wrapup-codes/scripts/gc-wrapup-codes.js');

const ENGINE = path.resolve(__dirname, '..', '..', 'gc-wrapup-codes', 'scripts', 'gc-wrapup-codes.js');
const GEN_CATALOG = path.join(__dirname, 'generate-wrap-up-catalog.js');
const DISCOVER_QUEUES = path.join(__dirname, 'discover-target-queues.js');

function parseArgs(argv) {
  const command = argv[0] || 'help';
  const options = {};
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (['confirm-apply', 'confirm-high-impact', 'confirm-delete'].includes(name)) {
      options[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[name] = value;
    i += 1;
  }
  return { command, options };
}

function runNode(script, args) {
  const out = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  try {
    return JSON.parse(out);
  } catch {
    return { raw: out };
  }
}

function engineArgs(options, extra) {
  const a = [];
  if (options['mcp-config']) {
    a.push('--mcp-config', options['mcp-config']);
  }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === true) a.push(`--${k}`);
    else if (v != null && v !== false) a.push(`--${k}`, String(v));
  }
  return a;
}

function runEngine(subcommand, options, extra) {
  const args = [ENGINE, subcommand, ...engineArgs(options, extra)];
  const out = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(out);
}

function ensureCatalog(options) {
  const sessionDir = path.resolve(options['session-dir']);
  const wrapFile = path.join(sessionDir, 'wrap-up-codes.json');
  if (fs.existsSync(wrapFile) && !options.regenerate) {
    return { ok: true, skipped: true, out: wrapFile };
  }
  const genArgs = ['--session-dir', sessionDir];
  if (options['lifecycle-dir']) genArgs.push('--lifecycle-dir', path.resolve(options['lifecycle-dir']));
  return runNode(GEN_CATALOG, genArgs);
}

function discoverQueues(options) {
  const args = ['--session-dir', path.resolve(options['session-dir'])];
  if (options['queue-names']) args.push('--queue-names', options['queue-names']);
  if (options['queue-ids']) args.push('--queue-ids', options['queue-ids']);
  if (options['include-pattern']) args.push('--include-pattern', options['include-pattern']);
  return runNode(DISCOVER_QUEUES, args);
}

function bindingsPath(options) {
  const sessionDir = path.resolve(options['session-dir']);
  const primary = path.join(sessionDir, 'telephony-bindings.json');
  if (fs.existsSync(primary)) return primary;
  const alt = path.join(sessionDir, '.flow-lifecycle', 'telephony-bindings.json');
  if (fs.existsSync(alt)) return alt;
  return primary;
}

async function planAxl(options) {
  const sessionDir = requireOption(options, 'session-dir');
  const steps = {};

  steps.catalog = ensureCatalog(options);
  steps.queues = discoverQueues(options);

  const flowOpts = { 'out-dir': path.join(sessionDir, '.flow-lifecycle'), 'session-dir': sessionDir };
  if (options['inbound-flow-id']) flowOpts['inbound-flow-id'] = options['inbound-flow-id'];
  if (options['inbound-flow-name']) flowOpts['flow-name'] = options['inbound-flow-name'];
  if (options['bot-flow-id']) flowOpts['bot-flow-id'] = options['bot-flow-id'];
  if (options['sage-agent-id']) flowOpts['sage-agent-id'] = options['sage-agent-id'];

  steps.telephony = runEngine('discover-telephony', options, flowOpts);

  const wrapFile = path.join(sessionDir, 'wrap-up-codes.json');
  steps.createBatch = runEngine('create-codes-batch', options, { file: wrapFile, 'session-dir': sessionDir });

  const queueNames = (steps.queues.queues || []).map((q) => q.name).join(',');
  const codeNames = (JSON.parse(fs.readFileSync(wrapFile, 'utf8')).codes || []).map((c) => c.name).join(',');
  if (queueNames && codeNames) {
    steps.assignPlan = runEngine('assign', options, {
      'queue-names': queueNames,
      'code-names': codeNames,
      'session-dir': sessionDir,
    });
  } else {
    steps.assignPlan = { ok: false, skipped: true, reason: 'No queues or codes to assign' };
  }

  const bindings = bindingsPath(options);
  steps.botPlan = runEngine('plan-bot-wrapup', options, {
    file: wrapFile,
    bindings,
    out: sessionDir,
    'session-dir': sessionDir,
  });

  return { ok: true, dryRun: true, action: 'plan-axl', sessionDir, steps };
}

async function applyAxl(options) {
  if (!options['confirm-apply']) {
    return planAxl(options);
  }
  const plan = await planAxl(options);
  const sessionDir = path.resolve(options['session-dir']);
  const wrapFile = path.join(sessionDir, 'wrap-up-codes.json');
  const bindings = bindingsPath(options);

  const applied = {};
  applied.createBatch = runEngine('create-codes-batch', options, {
    file: wrapFile,
    'session-dir': sessionDir,
    'confirm-apply': true,
  });

  const queueNames = (plan.steps.queues.queues || []).map((q) => q.name).join(',');
  const codeNames = (JSON.parse(fs.readFileSync(wrapFile, 'utf8')).codes || []).map((c) => c.name).join(',');
  const assignExtra = {
    'queue-names': queueNames,
    'code-names': codeNames,
    'session-dir': sessionDir,
    'confirm-apply': true,
  };
  if (options['confirm-high-impact']) assignExtra['confirm-high-impact'] = true;
  applied.assign = runEngine('assign', options, assignExtra);

  const fragExtra = {
    bindings,
    'session-dir': sessionDir,
    'confirm-apply': true,
  };
  if (options['summary-setting-id']) fragExtra['summary-setting-id'] = options['summary-setting-id'];
  applied.afterContact = runEngine('apply-bot-after-contact-fragment', options, fragExtra);

  applied.html = runEngine('write-session-html', options, {
    'session-dir': sessionDir,
    file: wrapFile,
    bindings,
    'change-note': 'AVA wrap-up apply-axl: codes created, queues assigned, After Contact fragment written.',
  });

  return { ok: true, dryRun: false, action: 'apply-axl', sessionDir, plan: plan.steps, applied };
}

function requireOption(options, name) {
  const v = options[name];
  if (!v) throw new Error(`Missing --${name}`);
  return path.resolve(v);
}

async function whoami(options) {
  const ctx = await createContext(options);
  const res = await ctx.client.request('GET', '/api/v2/organizations/me');
  return {
    ok: true,
    org: { id: res.body?.id, name: res.body?.name },
    region: ctx.region,
  };
}

const HELP = `AVA Wrap-Up Codes (AXL orchestrator)

  ava-wrap-up-codes.js help
  ava-wrap-up-codes.js whoami [--mcp-config <path>]

  ava-wrap-up-codes.js plan-axl --session-dir <axl-sessions/AXL-x> --lifecycle-dir <.ava-lifecycle/slug>
      [--inbound-flow-id <uuid> | --inbound-flow-name <name>]
      [--queue-names "A,B"] [--include-pattern "support,sales"]
      [--regenerate] [--mcp-config <path>]

  ava-wrap-up-codes.js apply-axl ... --confirm-apply [--confirm-high-impact]
      [--summary-setting-id <uuid>]

Engine: ${ENGINE}
`;

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    let result;
    if (command === 'help') {
      process.stdout.write(HELP);
      return;
    }
    if (command === 'whoami') result = await whoami(options);
    else if (command === 'plan-axl') result = await planAxl(options);
    else if (command === 'apply-axl') result = await applyAxl(options);
    else throw new Error(`Unknown command: ${command}. Run help.`);

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { planAxl, applyAxl, whoami };
