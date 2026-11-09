#!/usr/bin/env node
'use strict';

/**
 * ava-bot-flow-builder — build, publish and wire an AVA-fronted Architect bot flow.
 *
 * Commands
 *   whoami                 Confirm the org the MCP credentials point at.
 *   discover               Read the org: bot flows, queues, wrap-up codes, summary
 *                          settings, flow outcomes/milestones, STA programs.
 *   plan                   Validate bot-flow-plan.json against the org and emit bot-flow.yaml.
 *   emit-yaml              Regenerate bot-flow.yaml from the plan only (no API calls).
 *   apply                  Create outcome/milestones, import + publish the flow,
 *                          map it into the STA program, verify, write the handoff.
 *   verify                 Re-export the published flow and report what Architect kept.
 *
 * Every org mutation is gated behind --confirm-apply.
 */

const fs = require('fs');
const path = require('path');

const {
  emit, fail, makeClient, orgIdentity, pageAll, parseArgs, readJson, writeJson,
} = require('./lib/gc');
const architect = require('./lib/architect');
const sta = require('./lib/sta');
const { ensurePlanTracking } = require('./lib/outcomes');
const { buildBotFlowYaml, PROFILE_DEGRADED, PROFILE_FULL } = require('./lib/flow-yaml');
const { writeHandoff } = require('./lib/handoff');

const PLAN_FILE = 'bot-flow-plan.json';
const YAML_FILE = 'bot-flow.yaml';
const DISCOVERY_FILE = 'bot-flow-discovery.json';
const RESULT_FILE = 'bot-flow-result.json';

function sessionDir(args) {
  const dir = args['session-dir'] || args.session;
  if (!dir) throw new Error('--session-dir <path> is required.');
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function loadPlan(dir) {
  const planPath = path.join(dir, PLAN_FILE);
  if (!fs.existsSync(planPath)) {
    throw new Error(`No ${PLAN_FILE} in ${dir}. Author it from references/plan-artifact.md first.`);
  }
  return { plan: readJson(planPath), planPath };
}

async function cmdWhoami(args) {
  const { client, region, serverKey } = makeClient(args);
  const org = await orgIdentity(client);
  emit({ ok: true, action: 'whoami', ...org, region: region.key, apiBase: region.apiBase, mcpServer: serverKey });
}

async function cmdDiscover(args) {
  const dir = sessionDir(args);
  const { client, region } = makeClient(args);
  const org = await orgIdentity(client);
  const avaName = args['ava-name'] || null;

  const botFlows = await pageAll(client, '/api/v2/flows', { type: architect.FLOW_TYPE_BOT }, 100, 20);
  const queues = await pageAll(client, '/api/v2/routing/queues', {}, 100, 20);
  const wrapUpCodes = await pageAll(client, '/api/v2/routing/wrapupcodes', {}, 100, 20);
  const outcomes = await pageAll(client, '/api/v2/flows/outcomes', {}, 100, 10);
  const milestones = await pageAll(client, '/api/v2/flows/milestones', {}, 100, 10);
  const programs = await sta.listPrograms(client);

  let summarySettings = [];
  try {
    summarySettings = await pageAll(client, '/api/v2/conversations/summaries/settings', {}, 50, 5);
  } catch (error) {
    summarySettings = [{ error: error.message }];
  }

  // Which existing bot flows already call this AVA? Only answerable by export,
  // so it is opt-in and bounded.
  const matches = [];
  if (avaName && args.deep) {
    for (const flow of botFlows.slice(0, Number(args['deep-limit'] || 15))) {
      try {
        const yaml = await architect.exportFlowYaml(client, flow.id);
        if (yaml.includes(avaName)) matches.push({ id: flow.id, name: flow.name });
      } catch {
        matches.push({ id: flow.id, name: flow.name, exportFailed: true });
      }
    }
  }

  const discovery = {
    _meta: { artifact: 'ava-bot-flow-discovery', generatedAt: new Date().toISOString() },
    org: { ...org, region: region.key },
    avaName,
    botFlows: botFlows.map((flow) => ({
      id: flow.id,
      name: flow.name,
      published: Boolean(flow.publishedVersion),
      division: flow.division?.name || null,
    })),
    botFlowsCallingAva: args.deep ? matches : 'not-scanned (pass --deep)',
    queues: queues.map((queue) => ({ id: queue.id, name: queue.name, division: queue.division?.name || null })),
    wrapUpCodes: wrapUpCodes.map((code) => ({ id: code.id, name: code.name, hasDescription: Boolean(code.description) })),
    flowOutcomes: outcomes.map((outcome) => ({ id: outcome.id, name: outcome.name })),
    flowMilestones: milestones.map((milestone) => ({ id: milestone.id, name: milestone.name })),
    summarySettings: summarySettings.map((setting) => ({ id: setting.id, name: setting.name, summaryType: setting.summaryType })),
    speechTextPrograms: programs.map((program) => ({ id: program.id, name: program.name, published: program.published })),
  };

  const file = writeJson(path.join(dir, DISCOVERY_FILE), discovery);
  emit({ ok: true, action: 'discover', file, counts: {
    botFlows: discovery.botFlows.length,
    queues: discovery.queues.length,
    wrapUpCodes: discovery.wrapUpCodes.length,
    summarySettings: discovery.summarySettings.length,
  } });
}

function planStructureProblems(plan) {
  const problems = [];
  if (!plan.botFlow?.name) problems.push('botFlow.name is required.');
  if (!plan.ava?.name) problems.push('ava.name is required (the published AVA the flow calls).');
  if (!plan.ava?.exitReasonVariable) problems.push('ava.exitReasonVariable is required — the flow routes on it.');
  if (!plan.escalation?.defaultQueue) problems.push('escalation.defaultQueue is required — every failure path lands there.');
  if (!plan.outcome?.name) problems.push('outcome.name is required.');
  if (!plan.milestones?.before?.name || !plan.milestones?.after?.name) {
    problems.push('milestones.before.name and milestones.after.name are both required.');
  }
  const codes = plan.afterContact?.wrapUpCodes || [];
  if (plan.afterContact?.assignWrapupCodes !== false && codes.length < 15) {
    problems.push(`afterContact.wrapUpCodes has ${codes.length} entries; the AVA catalogue standard is 15-25.`);
  }
  // Generated catalogues have shipped with the same code repeated, which gives the
  // assistant nothing to choose between. Duplicates are caught here, not in review.
  const duplicates = codes.filter((code, i) => codes.indexOf(code) !== i);
  if (duplicates.length) {
    problems.push(`afterContact.wrapUpCodes repeats ${[...new Set(duplicates)].map((c) => `"${c}"`).join(', ')}.`);
  }
  if (plan.afterContact?.summarization !== false && !plan.afterContact?.summarySetting?.name) {
    problems.push('afterContact.summarySetting.name is required — without it the flow runs on the org default '
      + 'summary setting, not the one built for this AVA.');
  }
  const roles = (plan.ava?.outputs || []).map((output) => output.role);
  if (!roles.includes('escalationQueue') && (plan.escalation?.routes || []).length) {
    problems.push('escalation.routes are defined but no ava.outputs entry has role "escalationQueue" to match on.');
  }
  return problems;
}

async function validatePlanAgainstOrg(client, plan) {
  const findings = { errors: [], warnings: [] };

  const queueNames = new Set([
    plan.escalation?.defaultQueue,
    ...(plan.escalation?.routes || []).map((route) => route.queue),
  ].filter(Boolean));
  for (const name of queueNames) {
    const { body } = await client.request('GET', '/api/v2/routing/queues', { query: { name, pageSize: 25 } });
    const match = (body?.entities || []).find((queue) => queue.name === name);
    if (!match) findings.errors.push(`Queue "${name}" does not exist in this org.`);
  }

  for (const code of plan.afterContact?.wrapUpCodes || []) {
    const { body } = await client.request('GET', '/api/v2/routing/wrapupcodes', { query: { name: code, pageSize: 25 } });
    const match = (body?.entities || []).find((entity) => entity.name === code);
    if (!match) findings.errors.push(`Wrap-up code "${code}" does not exist. Create it with ava-wrap-up-codes first.`);
    else if (!match.description) findings.warnings.push(`Wrap-up code "${code}" has no description; After Contact AI selection needs one.`);
  }

  const planned = plan.afterContact?.summarySetting;
  if (planned?.name || planned?.id) {
    try {
      // The flow binds by name, so the name is what has to exist and be unique.
      const settings = await pageAll(client, '/api/v2/conversations/summaries/settings', {}, 50, 5);
      const byName = settings.filter((setting) => setting.name === planned.name);
      if (planned.name && !byName.length) {
        findings.errors.push(`No summary setting named "${planned.name}" exists. Create it with ava-custom-summary first.`);
      } else if (byName.length > 1) {
        findings.errors.push(`${byName.length} summary settings are named "${planned.name}". The flow binds by name, so the name must be unique.`);
      }
      const live = byName[0] || settings.find((setting) => setting.id === planned.id);
      if (live && planned.id && live.id !== planned.id) {
        findings.warnings.push(`Summary setting "${planned.name}" is ${live.id} in this org, not the planned ${planned.id}.`);
      }
      if (live && live.settingType !== 'Prompt') {
        findings.warnings.push(`Summary setting "${live.name}" is settingType "${live.settingType || 'Basic'}". `
          + 'An AVA summary should carry a custom prompt (settingType "Prompt") so reason, outcome, follow-up, '
          + 'tool output and exit reason are all written the way this AVA works.');
      }
    } catch (error) {
      findings.errors.push(`Summary settings could not be read: ${error.message}`);
    }
  } else if (plan.afterContact?.summarization !== false) {
    findings.warnings.push('Conversation summary will be enabled with no setting id: Architect applies the org default. Create one with ava-custom-summary.');
  }

  const existing = await architect.resolveFlowByName(client, plan.botFlow.name).catch((error) => {
    findings.errors.push(error.message);
    return null;
  });
  findings.existingFlow = existing ? { id: existing.id, name: existing.name, published: Boolean(existing.publishedVersion) } : null;
  if (existing?.lockedUser) findings.errors.push(`Flow "${existing.name}" is locked in Architect by ${existing.lockedUser.name || existing.lockedUser.id}.`);

  return findings;
}

function writeYaml(dir, plan, profile) {
  const yaml = buildBotFlowYaml(plan, { profile });
  const yamlPath = path.join(dir, YAML_FILE);
  fs.writeFileSync(yamlPath, yaml, 'utf8');
  return { yaml, yamlPath };
}

async function cmdPlan(args) {
  const dir = sessionDir(args);
  const { plan } = loadPlan(dir);
  const structure = planStructureProblems(plan);
  const { client } = makeClient(args);
  const org = await orgIdentity(client);
  const live = await validatePlanAgainstOrg(client, plan);
  const profile = args.profile === PROFILE_DEGRADED ? PROFILE_DEGRADED : PROFILE_FULL;
  const { yamlPath } = writeYaml(dir, plan, profile);

  const ok = structure.length === 0 && live.errors.length === 0;
  emit({
    ok,
    action: 'plan',
    org,
    yamlPath,
    profile,
    existingFlow: live.existingFlow,
    mode: live.existingFlow ? 'update-existing-flow' : 'create-new-flow',
    structureProblems: structure,
    errors: live.errors,
    warnings: live.warnings,
    nextStep: ok
      ? 'Review bot-flow.yaml, then run apply --confirm-apply.'
      : 'Fix the reported problems and re-run plan.',
  });
}

async function cmdEmitYaml(args) {
  const dir = sessionDir(args);
  const { plan } = loadPlan(dir);
  const profile = args.profile === PROFILE_DEGRADED ? PROFILE_DEGRADED : PROFILE_FULL;
  const { yamlPath } = writeYaml(dir, plan, profile);
  emit({ ok: true, action: 'emit-yaml', yamlPath, profile });
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Constructs whose presence in the re-exported YAML proves Architect accepted them. */
function verifyConstructs(yamlText, plan) {
  const codes = plan.afterContact?.wrapUpCodes || [];
  return {
    callAgenticVirtualAgent: yamlText.includes('callAgenticVirtualAgent:'),
    avaByName: Boolean(plan.ava?.name) && yamlText.includes(plan.ava.name),
    exitReasonMapped: Boolean(plan.ava?.exitReasonVariable) && yamlText.includes(plan.ava.exitReasonVariable),
    endContextOutputs: (plan.ava?.outputs || []).every((output) => !output.variable || yamlText.includes(output.variable)),
    processingPromptOff: /voiceProcessingPrompt:\s*\n\s*noValue: true/.test(yamlText),
    initializeFlowOutcome: yamlText.includes('initializeFlowOutcome:'),
    setFlowOutcome: yamlText.includes('setFlowOutcome:'),
    addFlowMilestone: yamlText.includes('addFlowMilestone:'),
    transferToAcd: yamlText.includes('transferToAcd:'),
    summarizationOn: /summarization:\s*\n\s*lit: true/.test(yamlText),
    summarySettingBound: !plan.afterContact?.summarySetting?.name
      || new RegExp(`conversationSummarySetting:\\s*\\n\\s*name: ${escapeRe(plan.afterContact.summarySetting.name)}`)
        .test(yamlText),
    wrapUpCodesOn: /assignWrapupCodes:\s*\n\s*lit: true/.test(yamlText),
    allWrapUpCodesPresent: codes.every((code) => yamlText.includes(code)),
  };
}

async function cmdApply(args) {
  const dir = sessionDir(args);
  const { plan } = loadPlan(dir);
  const structure = planStructureProblems(plan);
  if (structure.length) throw Object.assign(new Error('Plan is not valid.'), { details: structure });

  const { client } = makeClient(args);
  const org = await orgIdentity(client);
  const live = await validatePlanAgainstOrg(client, plan);
  if (live.errors.length) throw Object.assign(new Error('Plan does not match the org.'), { details: live.errors });

  const apply = Boolean(args['confirm-apply']);
  const warnings = [...live.warnings];
  const tracking = await ensurePlanTracking(client, plan, apply);

  let profile = args.profile === PROFILE_DEGRADED ? PROFILE_DEGRADED : PROFILE_FULL;
  let { yaml, yamlPath } = writeYaml(dir, plan, profile);

  if (!apply) {
    const result = {
      ok: true,
      action: 'apply',
      applied: false,
      org,
      yamlPath,
      profile,
      tracking,
      existingFlow: live.existingFlow,
      warnings,
      nextStep: 'Re-run with --confirm-apply to create the outcome/milestones, publish the flow and map the STA program.',
    };
    writeJson(path.join(dir, RESULT_FILE), result);
    emit(result);
    return;
  }

  let flowJob = await architect.importFlowYaml(client, yaml);
  // Architect rejected something: retry once without the probe-dependent
  // constructs so the flow still ships, and report what was dropped.
  if (flowJob.status !== 'Success' && profile === PROFILE_FULL && args['degrade-on-reject']) {
    warnings.push(`Architect rejected the full document (${flowJob.messages.join(' | ')}). Retried without flow outcome, milestone and end-context mappings.`);
    profile = PROFILE_DEGRADED;
    ({ yaml, yamlPath } = writeYaml(dir, plan, profile));
    flowJob = await architect.importFlowYaml(client, yaml);
  }
  if (flowJob.status !== 'Success') {
    throw Object.assign(new Error(`Architect job finished as ${flowJob.status}.`), { details: flowJob.messages });
  }

  const flowId = flowJob.flowId || live.existingFlow?.id
    || (await architect.resolveFlowByName(client, plan.botFlow.name))?.id || null;
  const flowMeta = flowId ? await architect.latestPublishedVersion(client, flowId) : null;
  if (flowMeta && !flowMeta.publishedVersion) {
    warnings.push('The Architect job succeeded but the flow has no published version. Publish it in Architect.');
  }

  let program = null;
  if (flowId && plan.speechTextAnalytics?.enabled !== false) {
    program = await sta.addFlowToProgram(client, {
      programName: plan.speechTextAnalytics?.programName || sta.GENERAL_PROGRAM_NAME,
      flowId,
      apply: true,
      publish: plan.speechTextAnalytics?.publish !== false,
    });
  }

  let verification = null;
  if (flowId) {
    const published = await architect.exportFlowYaml(client, flowId);
    fs.writeFileSync(path.join(dir, 'bot-flow.published.yaml'), published, 'utf8');
    verification = { checkedAt: new Date().toISOString(), constructs: verifyConstructs(published, plan) };
    for (const [key, value] of Object.entries(verification.constructs)) {
      if (!value) warnings.push(`Published YAML does not contain "${key}" — set it in Architect and re-verify.`);
    }
  }

  const handoffPath = writeHandoff(dir, { plan, org, applied: true, tracking, flowJob, flowMeta, program, verification, warnings });
  const result = {
    ok: true,
    action: 'apply',
    applied: true,
    org,
    profile,
    yamlPath,
    flow: flowMeta,
    architectJob: flowJob,
    tracking,
    speechTextAnalytics: program,
    verification,
    warnings,
    handoffPath,
  };
  writeJson(path.join(dir, RESULT_FILE), result);
  emit(result);
}

async function cmdVerify(args) {
  const dir = sessionDir(args);
  const { plan } = loadPlan(dir);
  const { client } = makeClient(args);
  const flowId = args['bot-flow-id']
    || (await architect.resolveFlowByName(client, plan.botFlow.name))?.id;
  if (!flowId) throw new Error(`No BOT flow named "${plan.botFlow.name}" exists in this org.`);
  const published = await architect.exportFlowYaml(client, flowId);
  fs.writeFileSync(path.join(dir, 'bot-flow.published.yaml'), published, 'utf8');
  const constructs = verifyConstructs(published, plan);
  const missing = Object.entries(constructs).filter(([, value]) => !value).map(([key]) => key);
  const flowMeta = await architect.latestPublishedVersion(client, flowId);
  emit({
    ok: missing.length === 0,
    action: 'verify',
    flow: flowMeta,
    constructs,
    missing,
    nextStep: missing.length ? 'Configure the missing items in Architect, then re-run verify.' : 'Published flow matches the plan.',
  });
}

const COMMANDS = {
  whoami: cmdWhoami,
  discover: cmdDiscover,
  plan: cmdPlan,
  'emit-yaml': cmdEmitYaml,
  apply: cmdApply,
  verify: cmdVerify,
};

(async () => {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  if (!command || !COMMANDS[command]) {
    emit({ ok: false, error: { message: `Unknown command "${command || ''}".`, commands: Object.keys(COMMANDS) } });
    process.exitCode = 1;
    return;
  }
  await COMMANDS[command](args);
})().catch(fail);
