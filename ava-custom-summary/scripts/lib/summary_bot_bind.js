'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeSummaryHandoff } = require('./session_html_bridge');

function wrapupScriptPath() {
  const p = path.resolve(__dirname, '..', '..', '..', 'gc-wrapup-codes', 'scripts', 'gc-wrapup-codes.js');
  if (!fs.existsSync(p)) {
    throw new Error(`gc-wrapup-codes skill not found at ${p}. Install gc-wrapup-codes alongside ava-custom-summary.`);
  }
  return p;
}

function runWrapupCommand(args, mcpConfigPath) {
  const script = wrapupScriptPath();
  const fullArgs = [script, ...args];
  if (mcpConfigPath) fullArgs.push('--mcp-config', mcpConfigPath);
  const stdout = execFileSync(process.execPath, fullArgs, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function loadBindings(filePath) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  return raw.bindings || raw;
}

function loadSettingMeta(filePath) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  return { meta: raw._meta || null, name: raw.name, id: raw.id || raw.summarySettingId || null };
}

async function discoverTelephony(args) {
  const argv = ['discover-telephony'];
  if (args['inbound-flow-id']) argv.push('--inbound-flow-id', args['inbound-flow-id']);
  if (args['flow-name']) argv.push('--flow-name', args['flow-name']);
  if (args['bot-flow-id']) argv.push('--bot-flow-id', args['bot-flow-id']);
  if (args['bot-flow-name']) argv.push('--bot-flow-name', args['bot-flow-name']);
  if (args['escalation-queue-id']) argv.push('--escalation-queue-id', args['escalation-queue-id']);
  if (args['sage-agent-id']) argv.push('--sage-agent-id', args['sage-agent-id']);
  if (args['out-dir']) argv.push('--out-dir', args['out-dir']);
  if (args.out) argv.push('--out', args.out);
  if (args.region) argv.push('--region', args.region);
  return runWrapupCommand(argv, args.configPath);
}

async function resolveTargets(client, args) {
  const customer = args.name || args.customer;
  const sageAgentId = args['sage-agent-id'] || null;
  const flows = customer
    ? await client.get(`/api/v2/flows?name=${encodeURIComponent(customer)}&pageSize=25`)
    : { entities: [] };
  const assistantsPage = customer
    ? await client.get(`/api/v2/assistants?pageSize=200`)
    : { entities: [] };
  const assistants = (assistantsPage.entities || []).filter((a) =>
    customer && String(a.name || '').toLowerCase().includes(String(customer).toLowerCase()));

  return {
    action: 'resolve-targets',
    sageAgentId,
    inboundFlowCandidates: (flows.entities || []).map((f) => ({
      id: f.id, name: f.name, type: f.type,
    })),
    assistantCandidates: assistants.map((a) => ({ id: a.id, name: a.name })),
    note: 'Confirm inbound flow and bot flow with the facilitator before bind. Copilot bind uses assistant id (Track 2).',
    nextStep: customer
      ? `discover-telephony --flow-name "<exact inbound name>" or --inbound-flow-id <uuid>`
      : 'Pass --name <customer fragment> to narrow flows and assistants.',
  };
}

async function planBindBotFlow(client, args) {
  if (!args.bindings) throw new Error('plan-bind-bot-flow requires --bindings <telephony-bindings.json>.');
  const bindings = loadBindings(args.bindings);
  let settingId = args.id || args['setting-id'];
  let settingName = null;
  if (args.file) {
    const fromFile = loadSettingMeta(args.file);
    settingName = fromFile.name;
    settingId = settingId || fromFile.id;
  }
  if (settingId && !settingName) {
    const live = await client.get(`/api/v2/conversations/summaries/settings/${settingId}`);
    settingName = live.name;
  }
  if (!settingId) throw new Error('plan-bind-bot-flow requires --id <setting-uuid> or a summary-setting.json with id after create.');

  let wrapupPlan;
  const wrapupFile = args['wrapup-file'] || args['codes-file'];
  if (wrapupFile) {
    try {
      wrapupPlan = runWrapupCommand(
        ['plan-bot-wrapup', '--file', wrapupFile, '--bindings', args.bindings],
        args.configPath,
      );
    } catch (error) {
      wrapupPlan = { ok: false, error: error.message };
    }
  }

  const manual = [
    `Bot flow: ${bindings.botFlowName || '(unknown)'} (${bindings.botFlowId || 'unknown id'})`,
    'Architect → Bot flow → Settings → After Contact → Conversation Summary: ON.',
    `Select AI Studio setting: "${settingName}" (${settingId}).`,
    'After Contact → Wrap-up Codes: enable master toggle and enable planned codes (see gc-wrapup-codes plan-bot-wrapup checklist).',
  ];

  const outDir = args.out || path.dirname(path.resolve(args.bindings));
  fs.mkdirSync(outDir, { recursive: true });
  const checklistPath = path.join(outDir, 'bind-bot-flow-manual.md');
  fs.writeFileSync(checklistPath, `${manual.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`, 'utf8');

  const fragmentArgs = [
    'apply-bot-after-contact-fragment',
    '--bindings', args.bindings,
    '--summary-setting-id', settingId,
  ];
  const fragmentPlan = runWrapupCommand(fragmentArgs, args.configPath);

  const htmlHandoff = writeSummaryHandoff(args, {
    file: args.file,
    id: settingId,
    action: 'plan-bind-bot-flow',
    changeNote: bindings.botFlowName
      ? `Planned After Contact summary bind on bot flow "${bindings.botFlowName}".`
      : 'Summary bind plan — confirm bot flow with facilitator.',
  });

  return {
    action: 'plan-bind-bot-flow',
    settingId,
    settingName,
    bindings: {
      botFlowId: bindings.botFlowId,
      botFlowName: bindings.botFlowName,
      inboundFlowId: bindings.inboundFlowId,
    },
    manualSteps: manual,
    checklistPath,
    afterContactFragmentPlan: fragmentPlan,
    wrapupPlan: wrapupPlan && wrapupPlan.action ? wrapupPlan : undefined,
    htmlHandoff,
    nextStep: 'Facilitator confirms flow ids, then complete checklist or merge after-contact.patch.yaml and publish via gc-callflow-test.',
  };
}

async function bindBotFlow(client, args) {
  const plan = await planBindBotFlow(client, args);
  if (!args['confirm-apply']) {
    return {
      ...plan,
      applied: false,
      htmlHandoff: plan.htmlHandoff,
      nextStep: 'Re-run bind-bot-flow with --confirm-apply to write after-contact.patch.yaml fragment.',
    };
  }
  const fragment = runWrapupCommand([
    'apply-bot-after-contact-fragment',
    '--bindings', args.bindings,
    '--summary-setting-id', plan.settingId,
    '--confirm-apply',
  ], args.configPath);
  const htmlHandoff = writeSummaryHandoff(args, {
    file: args.file,
    id: plan.settingId,
    action: 'bind-bot-flow',
    changeNote: plan.bindings?.botFlowName
      ? `After Contact summary fragment written for bot flow "${plan.bindings.botFlowName}".`
      : 'Summary bot-flow bind step completed (checklist + fragment).',
  });
  return { ...plan, applied: true, fragment, htmlHandoff };
}

module.exports = {
  discoverTelephony,
  resolveTargets,
  planBindBotFlow,
  bindBotFlow,
};
