'use strict';

/**
 * AXL orchestrator: generate Detailed summary setting, validate, create, bind bot flow.
 *
 *   node ava-custom-summary-axl.js plan-axl --session-dir ... --lifecycle-dir ...
 *   node ava-custom-summary-axl.js apply-axl ... --confirm-apply
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKILL_DIR = path.resolve(__dirname, '..');
const GC_SUMMARY = path.join(SKILL_DIR, 'scripts', 'gc_summary_setting.js');
const GEN = path.join(SKILL_DIR, 'scripts', 'generate-summary-setting.js');

function parseArgs(argv) {
  const command = argv[0] || 'help';
  const options = {};
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name === 'confirm-apply' || name === 'regenerate') {
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
  return JSON.parse(out);
}

function runSummary(subcommand, extraArgs) {
  const args = [GC_SUMMARY, subcommand, ...extraArgs];
  const out = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(out);
}

function sessionPaths(options) {
  const sessionDir = path.resolve(requireOpt(options, 'session-dir'));
  const lifecycleDir = options['lifecycle-dir'] ? path.resolve(options['lifecycle-dir']) : null;
  const summaryFile = path.join(sessionDir, 'summary-setting.json');
  const bindings = path.join(sessionDir, 'telephony-bindings.json');
  const flowDir = path.join(sessionDir, '.flow-lifecycle');
  return { sessionDir, lifecycleDir, summaryFile, bindings, flowDir };
}

function requireOpt(options, name) {
  if (!options[name]) throw new Error(`Missing --${name}`);
  return options[name];
}

function ensureSummary(options, paths) {
  if (fs.existsSync(paths.summaryFile) && !options.regenerate) {
    return { ok: true, skipped: true, out: paths.summaryFile };
  }
  const genArgs = ['--session-dir', paths.sessionDir];
  if (paths.lifecycleDir) genArgs.push('--lifecycle-dir', paths.lifecycleDir);
  return runNode(GEN, genArgs);
}

function mergeSettingId(filePath, id) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.id = id;
  raw.summarySettingId = id;
  fs.writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

function discoverIfNeeded(options, paths) {
  if (fs.existsSync(paths.bindings)) return { ok: true, skipped: true, path: paths.bindings };
  const args = [
    'discover-telephony',
    '--out-dir', paths.flowDir,
    '--out', paths.bindings,
  ];
  if (options['inbound-flow-id']) args.push('--inbound-flow-id', options['inbound-flow-id']);
  if (options['inbound-flow-name']) args.push('--flow-name', options['inbound-flow-name']);
  if (options['sage-agent-id']) args.push('--sage-agent-id', options['sage-agent-id']);
  return runSummary('discover-telephony', args.slice(1));
}

async function planAxl(options) {
  const paths = sessionPaths(options);
  const steps = {};
  steps.generate = ensureSummary(options, paths);
  steps.validate = runSummary('validate', ['--file', paths.summaryFile]);
  steps.telephony = discoverIfNeeded(options, paths);
  steps.createPlan = runSummary('create', ['--file', paths.summaryFile]);

  const bindArgs = ['--bindings', paths.bindings, '--file', paths.summaryFile, '--out', paths.sessionDir];
  const wrapFile = path.join(paths.sessionDir, 'wrap-up-codes.json');
  if (fs.existsSync(wrapFile)) bindArgs.push('--wrapup-file', wrapFile);
  if (fs.existsSync(paths.bindings)) {
    steps.bindPlan = runSummary('plan-bind-bot-flow', bindArgs);
  } else {
    steps.bindPlan = { skipped: true, reason: 'telephony-bindings.json missing after discover' };
  }

  return { ok: true, dryRun: true, action: 'plan-axl', sessionDir: paths.sessionDir, steps };
}

async function applyAxl(options) {
  if (!options['confirm-apply']) return planAxl(options);

  const paths = sessionPaths(options);
  ensureSummary(options, paths);
  runSummary('validate', ['--file', paths.summaryFile]);
  discoverIfNeeded(options, paths);

  const created = runSummary('create', ['--file', paths.summaryFile, '--confirm-apply']);
  if (created.id) mergeSettingId(paths.summaryFile, created.id);

  const bindArgs = [
    '--bindings', paths.bindings,
    '--file', paths.summaryFile,
    '--id', created.id,
    '--confirm-apply',
  ];
  const wrapFile = path.join(paths.sessionDir, 'wrap-up-codes.json');
  if (fs.existsSync(wrapFile)) bindArgs.push('--wrapup-file', wrapFile);

  let bindResult = { skipped: true };
  if (fs.existsSync(paths.bindings)) {
    bindResult = runSummary('bind-bot-flow', bindArgs);
  }

  const html = runSummary('write-session-html', [
    '--session-dir', paths.sessionDir,
    '--file', paths.summaryFile,
    '--bindings', paths.bindings,
    '--change-note', 'AVA custom summary apply-axl: setting created and bot After Contact fragment planned/applied.',
  ]);

  return {
    ok: true,
    dryRun: false,
    action: 'apply-axl',
    settingId: created.id,
    sessionDir: paths.sessionDir,
    create: created,
    bind: bindResult,
    htmlHandoff: html.htmlHandoff || html,
  };
}

const HELP = `AVA Custom Summary — AXL orchestrator

  ava-custom-summary-axl.js plan-axl --session-dir <axl-sessions/AXL-x> --lifecycle-dir <.ava-lifecycle/slug>
      [--inbound-flow-id <uuid> | --inbound-flow-name <name>] [--regenerate]

  ava-custom-summary-axl.js apply-axl ... --confirm-apply

Generates Detailed summary-setting.json with tool-driven customEntities, validates,
creates the org setting, and binds After Contact on the Architect bot flow.
`;

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    if (command === 'help') {
      process.stdout.write(HELP);
      return;
    }
    let result;
    if (command === 'plan-axl') result = await planAxl(options);
    else if (command === 'apply-axl') result = await applyAxl(options);
    else throw new Error(`Unknown command: ${command}`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { planAxl, applyAxl };
