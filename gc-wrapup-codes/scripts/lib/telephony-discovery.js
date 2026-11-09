'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { callflowTestScript } = require('./telephony-paths');
const { parseAfterContactFromYaml } = require('./bot-flow-after-contact');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function slugify(name) {
  return String(name || 'flow')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function resolveFlowByName(client, name, flowType) {
  const query = { name, pageSize: 25 };
  if (flowType) query.type = String(flowType).toUpperCase();
  const res = await client.request('GET', '/api/v2/flows', { query });
  const entities = res.body?.entities || [];
  const exact = entities.filter((f) => f.name === name);
  if (exact.length === 1) return exact[0];
  const ci = entities.filter((f) => f.name?.toLowerCase() === name.toLowerCase());
  if (ci.length === 1) return ci[0];
  if (exact.length > 1 || ci.length > 1) {
    const err = new Error(`Flow name "${name}" matches more than one flow. Pass --inbound-flow-id explicitly.`);
    err.candidates = (exact.length ? exact : ci).map((f) => ({ id: f.id, name: f.name, type: f.type }));
    throw err;
  }
  return null;
}

function runCallflowFetch(flowId, outDir, mcpConfig) {
  const script = callflowTestScript();
  const args = [script, 'fetch', '--flow-id', flowId, '--out-dir', outDir, '--depth', '2'];
  if (mcpConfig) args.push('--mcp-config', mcpConfig);
  const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = { raw: stdout.slice(0, 500) };
  }
  if (parsed.ok === false) {
    const err = new Error(parsed.error?.message || 'gc-callflow-test fetch failed');
    err.details = parsed;
    throw err;
  }
  return parsed;
}

function isBotType(type) {
  return String(type || '').toUpperCase() === 'BOT';
}

function readLifecycle(outDir) {
  const treePath = path.join(outDir, 'flow-tree.json');
  const mainMetaPath = path.join(outDir, 'flow.json');
  const mainYamlPath = path.join(outDir, 'flow.yaml');
  const tree = fs.existsSync(treePath) ? JSON.parse(fs.readFileSync(treePath, 'utf8')) : { nodes: [], edges: [] };
  const inbound = fs.existsSync(mainMetaPath) ? JSON.parse(fs.readFileSync(mainMetaPath, 'utf8')) : null;
  const botFlows = [];

  const considerFlow = (slug, dir, meta, node) => {
    const yamlPath = path.join(dir, 'flow.yaml');
    const yamlText = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : '';
    const type = meta?.type || node?.type;
    if (!isBotType(type) && !yamlText.includes('botFlow:')) return;
    botFlows.push({
      flowId: meta?.id || node?.flow_id,
      name: meta?.name || node?.name,
      slug,
      lifecycleDir: dir,
      yamlPath: fs.existsSync(yamlPath) ? yamlPath : null,
      afterContact: yamlText ? parseAfterContactFromYaml(yamlText) : null,
      exportable: node?.exportable !== false,
    });
  };

  if (inbound && isBotType(inbound.type) && fs.existsSync(mainYamlPath)) {
    considerFlow('main', outDir, inbound, { slug: 'main', flow_id: inbound.id, name: inbound.name, type: inbound.type });
  }

  for (const node of tree.nodes || []) {
    if (node.slug === 'main') continue;
    const dir = path.join(outDir, 'flows', node.slug);
    const metaPath = path.join(dir, 'flow.json');
    if (!fs.existsSync(metaPath) && !fs.existsSync(path.join(dir, 'flow.yaml'))) continue;
    const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
    considerFlow(node.slug, dir, meta, node);
  }

  const edges = tree.edges || [];
  const callBotFromInbound = edges
    .filter((e) => e.ref_type === 'callBotFlow')
    .map((e) => ({
      botFlowName: e.child_name,
      botFlowId: e.child_flow_id || null,
      parentFlowId: e.parent_flow_id,
      trackingId: e.tracking_id || null,
    }));

  return { inbound, tree, botFlows, callBotFromInbound };
}

async function getQueueAssistant(client, queueId) {
  try {
    const res = await client.request('GET', `/api/v2/routing/queues/${encodeURIComponent(queueId)}/assistant`);
    return res.body || null;
  } catch {
    return null;
  }
}

/**
 * Discover inbound + bot flows for AVA telephony binding.
 */
async function discoverTelephony(client, options) {
  const mcpConfig = options['mcp-config'] || options.mcpConfig;
  let inboundFlowId = options['inbound-flow-id'] || options.inboundFlowId;
  const flowName = options['flow-name'] || options.flowName;
  const flowType = options['flow-type'] || options.flowType || 'INBOUNDCALL';

  if (!inboundFlowId && flowName) {
    const resolved = await resolveFlowByName(client, flowName, flowType);
    if (!resolved) {
      const err = new Error(`No flow found with name "${flowName}" and type ${flowType}.`);
      err.hint = 'Pass --inbound-flow-id <uuid> from Architect.';
      throw err;
    }
    inboundFlowId = resolved.id;
  }
  if (!inboundFlowId || !UUID.test(inboundFlowId)) {
    throw new Error('discover-telephony requires --inbound-flow-id <uuid> or --flow-name <exact name>.');
  }

  const metaRes = await client.request('GET', `/api/v2/flows/${encodeURIComponent(inboundFlowId)}`);
  const inbound = metaRes.body;
  const outDir = path.resolve(
    options['out-dir'] || options.outDir
    || path.join(process.cwd(), '.flow-lifecycle', `discovered-${slugify(inbound.name)}`),
  );
  fs.mkdirSync(outDir, { recursive: true });

  const fetchResult = runCallflowFetch(inboundFlowId, outDir, mcpConfig);
  const lifecycle = readLifecycle(outDir);

  let botFlow = null;
  if (options['bot-flow-id'] && UUID.test(options['bot-flow-id'])) {
    botFlow = lifecycle.botFlows.find((b) => b.flowId === options['bot-flow-id']) || null;
  } else if (options['bot-flow-name']) {
    botFlow = lifecycle.botFlows.find((b) => b.name === options['bot-flow-name']) || null;
  } else if (lifecycle.botFlows.length === 1) {
    botFlow = lifecycle.botFlows[0];
  }

  const escalationQueueId = options['escalation-queue-id'] || null;
  let queueAssistant = null;
  if (escalationQueueId && UUID.test(escalationQueueId)) {
    queueAssistant = await getQueueAssistant(client, escalationQueueId);
  }

  const bindings = {
    inboundFlowId: inbound.id,
    inboundFlowName: inbound.name,
    inboundFlowType: inbound.type,
    botFlowId: botFlow?.flowId || null,
    botFlowName: botFlow?.name || null,
    botLifecycleDir: botFlow?.lifecycleDir || null,
    botYamlPath: botFlow?.yamlPath || null,
    lifecycleRoot: outDir,
    escalationQueueId,
    assistantOnEscalationQueue: queueAssistant?.assistant?.id
      ? { assistantId: queueAssistant.assistant.id, assistantName: queueAssistant.assistant.name }
      : null,
    callBotReferences: lifecycle.callBotFromInbound,
    botFlowCandidates: lifecycle.botFlows.map((b) => ({
      flowId: b.flowId, name: b.name, slug: b.slug, afterContactKeys: b.afterContact?.rawKeysFound || [],
    })),
    sageAgentId: options['sage-agent-id'] || options.sageAgentId || null,
    discoveredAt: new Date().toISOString(),
    sources: ['GET /flows', 'gc-callflow-test fetch'],
  };

  if (lifecycle.botFlows.length > 1 && !botFlow) {
    bindings.needsUserChoice = {
      reason: 'multiple_bot_flows',
      message: 'More than one bot flow was discovered. Pass --bot-flow-id or --bot-flow-name.',
      candidates: bindings.botFlowCandidates,
    };
  } else if (lifecycle.botFlows.length === 0) {
    bindings.needsUserChoice = {
      reason: 'no_bot_flow',
      message: 'No BOT flow found in fetch tree. Pass --bot-flow-id for the Virtual Agent bot flow.',
    };
  }

  const outFile = options.out || options['bindings-out']
    || path.join(outDir, 'telephony-bindings.json');
  fs.writeFileSync(outFile, `${JSON.stringify({ _meta: { artifact: 'telephony-bindings' }, ...bindings }, null, 2)}\n`, 'utf8');

  let htmlHandoff = null;
  try {
    const { writeWrapupSessionHtml } = require('./session-artifact-html');
    htmlHandoff = writeWrapupSessionHtml({
      ...options,
      bindings: outFile,
      action: 'discover-telephony',
      changeNote: 'Discovery only — no queue or bot flow settings changed yet.',
    });
  } catch {
    htmlHandoff = { ok: false, skipped: true };
  }

  return {
    ok: true,
    action: 'discover-telephony',
    fetch: fetchResult,
    bindings,
    bindingsPath: outFile,
    afterContactOnSelectedBot: botFlow?.afterContact || null,
    htmlHandoff,
  };
}

module.exports = {
  discoverTelephony,
  resolveFlowByName,
  readLifecycle,
  parseAfterContactFromYaml,
};
