'use strict';

const fs = require('fs');
const path = require('path');
const {
  planWrapUpEnablement,
  planSummaryBinding,
  buildAfterContactPatchFragment,
  buildManualChecklist,
  parseAfterContactFromYaml,
} = require('./bot-flow-after-contact');

function loadPlannedCodesFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  const list = raw.codes || raw.wrapUpCodes || raw;
  if (!Array.isArray(list)) throw new Error(`${filePath} must contain a "codes" array.`);
  return list.map((item) => ({
    name: item.name,
    description: item.description || '',
    mapsTo: item.mapsTo || null,
  })).filter((c) => c.name);
}

function loadBindings(filePath) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  return raw.bindings || raw;
}

function orgCodesByName(resolvedCodes, entities) {
  const map = {};
  for (const item of resolvedCodes || []) {
    map[item.matched || item.name] = { id: item.id, name: item.matched || item.name };
  }
  for (const code of entities || []) {
    if (code?.name) map[code.name] = { id: code.id, name: code.name, description: code.description };
  }
  return map;
}

async function planCreateCodesBatch(deps, options) {
  const { resolveByName, buildCreateBody, executeRequest, getCode, spec, context, flags } = deps;
  const file = options.file || options['codes-file'];
  if (!file) throw new Error('create-codes-batch requires --file <wrap-up-codes.json>.');
  const planned = loadPlannedCodesFile(file);
  const names = planned.map((c) => c.name);
  const { resolved, problems } = await resolveByName(spec, context, 'code', names);
  const ambiguous = problems.filter((p) => p.reason === 'ambiguous');
  if (ambiguous.length) {
    const err = new Error(`Ambiguous wrap-up code names: ${ambiguous.map((p) => p.name).join(', ')}`);
    err.problems = ambiguous;
    throw err;
  }
  const existing = new Set(resolved.map((r) => r.name.toLowerCase()));
  const toCreate = planned.filter((c) => !existing.has(c.name.toLowerCase()));
  const missingDescription = toCreate.filter((c) => !String(c.description || '').trim());

  const plan = {
    file,
    plannedCount: planned.length,
    alreadyInOrg: resolved.length,
    unresolvedNames: problems.map((p) => p.name),
    toCreate: toCreate.map((c) => ({ name: c.name, description: c.description })),
    blocked: missingDescription.map((c) => ({ name: c.name, reason: 'description required for After Contact AI' })),
  };

  const writeHtml = () => {
    try {
      const { writeWrapupSessionHtml } = require('./session-artifact-html');
      return writeWrapupSessionHtml({
        ...options,
        file,
        action: options['confirm-apply'] ? 'create-codes-batch (applied)' : 'create-codes-batch (plan)',
        changeNote: options['confirm-apply']
          ? `Created ${plan.toCreate.length} org wrap-up code(s). Bot flow / queue binding may still be pending.`
          : 'Dry run — no org codes created yet.',
      });
    } catch {
      return null;
    }
  };

  if (!options['confirm-apply']) {
    return {
      ok: true,
      dryRun: true,
      action: 'create-codes-batch',
      plan,
      htmlHandoff: writeHtml(),
      nextStep: 'Re-run with --confirm-apply to create missing org codes.',
    };
  }

  if (missingDescription.length) {
    throw new Error(`Cannot create codes without descriptions: ${missingDescription.map((c) => c.name).join(', ')}`);
  }

  const created = [];
  for (const code of toCreate) {
    const body = buildCreateBody({ name: code.name, description: code.description });
    const result = await executeRequest(spec, context, 'postRoutingWrapupcodes', { body }, flags);
    if (!result.dryRun) {
      const codeId = result.response?.id;
      created.push({ name: code.name, id: codeId, verified: codeId ? await getCode(spec, context, codeId) : null });
    } else {
      created.push({ name: code.name, dryRun: true });
    }
  }
  return {
    ok: true,
    dryRun: false,
    action: 'create-codes-batch',
    plan,
    created,
    htmlHandoff: writeHtml(),
  };
}

async function planBotWrapup(deps, options) {
  const { resolveByName, getCode, spec, context } = deps;
  const codesFile = options.file || options['codes-file'];
  if (!codesFile) throw new Error('plan-bot-wrapup requires --file <wrap-up-codes.json>.');

  const planned = loadPlannedCodesFile(codesFile);
  const names = planned.map((c) => c.name);
  const { resolved, problems } = await resolveByName(spec, context, 'code', names);

  let yamlText = '';
  let botFlowName = options['bot-flow-name'] || null;
  let botFlowId = options['bot-flow-id'] || null;
  let lifecycleDir = null;

  if (options.bindings) {
    const bindings = loadBindings(options.bindings);
    botFlowId = botFlowId || bindings.botFlowId;
    botFlowName = botFlowName || bindings.botFlowName;
    lifecycleDir = bindings.botLifecycleDir || bindings.lifecycleRoot;
    if (bindings.botYamlPath && fs.existsSync(bindings.botYamlPath)) {
      yamlText = fs.readFileSync(bindings.botYamlPath, 'utf8');
    } else if (lifecycleDir && bindings.botFlowId) {
      const candidate = (bindings.botFlowCandidates || []).find((c) => c.flowId === bindings.botFlowId);
      if (candidate?.slug) {
        const yamlPath = path.join(lifecycleDir, 'flows', candidate.slug, 'flow.yaml');
        if (fs.existsSync(yamlPath)) yamlText = fs.readFileSync(yamlPath, 'utf8');
      }
    }
  }
  if (options['bot-yaml'] && fs.existsSync(options['bot-yaml'])) {
    yamlText = fs.readFileSync(path.resolve(options['bot-yaml']), 'utf8');
  }

  const afterContact = yamlText ? parseAfterContactFromYaml(yamlText) : {
    rawKeysFound: [],
    conversationSummary: { enabled: null },
    wrapUpCodes: { enabled: null, enabledCodeNames: [], enabledCodeIds: [] },
    automationConfidence: 'low',
  };

  const byName = orgCodesByName(resolved, []);
  for (const r of resolved) {
    const full = await getCode(spec, context, r.id);
    byName[r.matched || r.name] = {
      id: r.id,
      name: full.name || r.matched,
      description: full.description,
    };
  }

  const wrapPlan = planWrapUpEnablement(planned, afterContact, byName);
  const manualSteps = buildManualChecklist({
    botFlowName: botFlowName || '(unknown)',
    botFlowId: botFlowId || '(unknown)',
    wrapUpPlan: wrapPlan,
    summaryPlan: { needsEnableToggle: false },
  });

  const outDir = options.out || options['plan-out'];
  let writtenPaths = null;
  if (outDir) {
    const dir = path.resolve(outDir);
    fs.mkdirSync(dir, { recursive: true });
    const planPath = path.join(dir, 'bot-wrapup-plan.json');
    const checklistPath = path.join(dir, 'bot-wrapup-manual-checklist.md');
    const payload = {
      _meta: { artifact: 'bot-wrapup-plan' },
      botFlowId,
      botFlowName,
      afterContact,
      wrapPlan,
      resolveProblems: problems,
      manualSteps,
    };
    fs.writeFileSync(planPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.writeFileSync(checklistPath, `${manualSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`, 'utf8');
    writtenPaths = { planPath, checklistPath };
  }

  let htmlHandoff = null;
  try {
    const { writeWrapupSessionHtml } = require('./session-artifact-html');
    htmlHandoff = writeWrapupSessionHtml({
      ...options,
      file: codesFile,
      action: 'plan-bot-wrapup',
      changeNote: botFlowName
        ? `Planned After Contact wrap-up enablement for bot flow "${botFlowName}".`
        : 'Wrap-up plan generated; confirm bot flow in telephony-bindings.json.',
    });
  } catch {
    htmlHandoff = null;
  }

  return {
    ok: problems.length === 0,
    dryRun: true,
    action: 'plan-bot-wrapup',
    botFlowId,
    botFlowName,
    afterContact,
    wrapPlan,
    resolveProblems: problems,
    manualSteps,
    writtenPaths,
    htmlHandoff,
    nextStep: wrapPlan.manualRequired
      ? 'Complete manual steps in Architect or export bot flow.yaml and run apply-bot-after-contact-fragment with --confirm-apply after review.'
      : 'After Contact wrap-up appears fully enabled in exported YAML.',
  };
}

function applyBotAfterContactFragment(options) {
  const bindings = options.bindings ? loadBindings(options.bindings) : {};
  const botDir = options['bot-lifecycle-dir'] || bindings.botLifecycleDir;
  if (!botDir) throw new Error('apply-bot-after-contact-fragment requires --bindings or --bot-lifecycle-dir.');

  const summarySettingId = options['summary-setting-id'] || null;
  const fragment = buildAfterContactPatchFragment({
    summarySettingId,
    enableConversationSummary: options['enable-summary'] !== 'false',
    enableWrapUpCodes: options['enable-wrapup'] !== 'false',
  });

  const outPath = path.join(path.resolve(botDir), 'after-contact.patch.yaml');
  if (!options['confirm-apply']) {
    return {
      ok: true,
      dryRun: true,
      action: 'apply-bot-after-contact-fragment',
      wouldWrite: outPath,
      fragmentPreview: fragment.split('\n').slice(0, 12),
      nextStep: 'Review fragment, merge into flow.yaml per org schema, then gc-callflow-test publish-fixed --confirm-apply.',
    };
  }

  fs.writeFileSync(outPath, fragment, 'utf8');
  return {
    ok: true,
    dryRun: false,
    action: 'apply-bot-after-contact-fragment',
    written: outPath,
    warning: 'Fragment is not auto-merged into flow.yaml. Validate against a real BOT export before publish.',
  };
}

module.exports = {
  loadPlannedCodesFile,
  loadBindings,
  planCreateCodesBatch,
  planBotWrapup,
  applyBotAfterContactFragment,
};
