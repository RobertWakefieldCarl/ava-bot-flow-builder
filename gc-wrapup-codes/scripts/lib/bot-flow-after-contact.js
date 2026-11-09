'use strict';

/**
 * Parse and plan Architect bot-flow After Contact settings from exported YAML.
 * Schema varies by platform version; this uses tolerant regex + optional object walk.
 */

function parseAfterContactFromYaml(yamlText) {
  const yaml = String(yamlText || '');
  const result = {
    rawKeysFound: [],
    conversationSummary: { enabled: null, summarySettingId: null, summarySettingName: null },
    wrapUpCodes: { enabled: null, enabledCodeNames: [], enabledCodeIds: [] },
    automationConfidence: 'low',
  };

  const keyHits = ['afterContact', 'after_contact', 'conversationSummary', 'summarizeConversation',
    'wrapUpCodes', 'wrapUpCode', 'summarySetting'];
  for (const k of keyHits) {
    if (yaml.includes(k)) result.rawKeysFound.push(k);
  }

  const enabledSummary = yaml.match(/conversationSummary:[\s\S]*?enabled:\s*(true|false)/i)
    || yaml.match(/summarizeConversation:\s*(true|false)/i);
  if (enabledSummary) result.conversationSummary.enabled = enabledSummary[1] === 'true';

  const settingId = yaml.match(/summarySetting(?:Id)?:\s*([0-9a-f-]{36})/i)
    || yaml.match(/summarySetting:[\s\S]*?id:\s*([0-9a-f-]{36})/i);
  if (settingId) result.conversationSummary.summarySettingId = settingId[1];

  const settingName = yaml.match(/summarySetting:[\s\S]*?name:\s*['"]?([^'"\n]+)/i);
  if (settingName) result.conversationSummary.summarySettingName = settingName[1].trim();

  const wrapEnabled = yaml.match(/wrapUpCodes:[\s\S]*?enabled:\s*(true|false)/i);
  if (wrapEnabled) result.wrapUpCodes.enabled = wrapEnabled[1] === 'true';

  for (const m of yaml.matchAll(/wrapUpCode(?:Id)?:\s*([0-9a-f-]{36})/gi)) {
    result.wrapUpCodes.enabledCodeIds.push(m[1]);
  }
  for (const m of yaml.matchAll(/wrapUpCode(?:Name)?:\s*['"]?([^'"\n]+)/gi)) {
    result.wrapUpCodes.enabledCodeNames.push(m[1].trim());
  }

  result.automationConfidence = result.rawKeysFound.length ? 'medium' : 'low';
  if (result.rawKeysFound.some((k) => k.toLowerCase().includes('aftercontact'))) {
    result.automationConfidence = 'high';
  }
  return result;
}

function planWrapUpEnablement(plannedCodes, afterContactState, orgCodesByName) {
  const plannedNames = (plannedCodes || []).map((c) => c.name).filter(Boolean);
  const enabled = new Set([
    ...(afterContactState.wrapUpCodes.enabledCodeNames || []),
    ...(afterContactState.wrapUpCodes.enabledCodeIds || []).map((id) => {
      const hit = Object.values(orgCodesByName || {}).find((c) => c.id === id);
      return hit ? hit.name : id;
    }),
  ]);

  const missingInOrg = [];
  const toEnable = [];
  for (const name of plannedNames) {
    const org = orgCodesByName[name];
    if (!org) {
      missingInOrg.push(name);
      continue;
    }
    if (!org.description || !String(org.description).trim()) {
      missingInOrg.push(`${name} (no description — required for After Contact AI)`);
      continue;
    }
    if (!enabled.has(name)) toEnable.push({ name, id: org.id });
  }

  return {
    plannedCount: plannedNames.length,
    alreadyEnabledCount: plannedNames.filter((n) => enabled.has(n)).length,
    toEnable,
    missingInOrg,
    wrapUpMasterToggle: afterContactState.wrapUpCodes.enabled,
    manualRequired: afterContactState.automationConfidence !== 'high' || toEnable.length > 0,
  };
}

function planSummaryBinding(setting, afterContactState) {
  const targetId = setting?.id || setting?.summarySettingId;
  const targetName = setting?.name;
  const currentId = afterContactState.conversationSummary.summarySettingId;
  const match = targetId && currentId && targetId === currentId;
  return {
    targetSummarySettingId: targetId || null,
    targetSummarySettingName: targetName || null,
    currentSummarySettingId: currentId || null,
    conversationSummaryEnabled: afterContactState.conversationSummary.enabled,
    alreadyBound: Boolean(match),
    needsEnableToggle: afterContactState.conversationSummary.enabled !== true,
    manualRequired: afterContactState.automationConfidence !== 'high',
  };
}

/**
 * Propose YAML fragment for After Contact (import compatibility not guaranteed — use publish preflight).
 */
function buildAfterContactPatchFragment({ summarySettingId, enableConversationSummary, enableWrapUpCodes }) {
  const lines = [
    '# Fragment: merge under botFlow root in exported Architect YAML, then publish via gc-callflow-test.',
    'afterContact:',
    `  conversationSummary:`,
    `    enabled: ${enableConversationSummary !== false}`,
  ];
  if (summarySettingId) {
    lines.push('    summarySetting:', `      id: ${summarySettingId}`);
  }
  lines.push(`  wrapUpCodes:`, `    enabled: ${enableWrapUpCodes !== false}`);
  lines.push('    # Enable individual codes in Architect UI or extend YAML when schema is confirmed for your org.');
  return `${lines.join('\n')}\n`;
}

function buildManualChecklist({ botFlowName, botFlowId, settingName, settingId, wrapUpPlan, summaryPlan }) {
  const steps = [
    `Open Architect → Bot flow "${botFlowName}" (${botFlowId}).`,
    'Settings → After Contact → Conversation Summary: enable toggle.',
  ];
  if (settingName || settingId) {
    steps.push(`Select summary configuration: "${settingName || settingId}".`);
  }
  steps.push('After Contact → Wrap-up Codes: enable master toggle.');
  if (wrapUpPlan.toEnable.length) {
    steps.push(`Enable these ${wrapUpPlan.toEnable.length} codes (Status column): ${wrapUpPlan.toEnable.map((c) => c.name).join(', ')}.`);
  }
  if (wrapUpPlan.missingInOrg.length) {
    steps.push(`Create or fix in org first: ${wrapUpPlan.missingInOrg.join('; ')}.`);
  }
  if (summaryPlan.needsEnableToggle) steps.push('Ensure Conversation Summary toggle is ON.');
  return steps;
}

module.exports = {
  parseAfterContactFromYaml,
  planWrapUpEnablement,
  planSummaryBinding,
  buildAfterContactPatchFragment,
  buildManualChecklist,
};
