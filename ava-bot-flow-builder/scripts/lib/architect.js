'use strict';

/**
 * Architect flow operations: resolve, export YAML, import/publish YAML, delete.
 *
 * Import uses the Architect job endpoint (POST /api/v2/flows/jobs). The job
 * matches an existing flow by name *and* type, creates it when absent, saves
 * the configuration and publishes it. There is no dry-run mode: a job either
 * succeeds or returns Failure with validation messages and no new version.
 */

const { sleep } = require('./gc');

const FLOW_TYPE_BOT = 'BOT';

async function resolveFlowByName(client, name, flowType = FLOW_TYPE_BOT) {
  const { body } = await client.request('GET', '/api/v2/flows', {
    query: { name, type: flowType, pageSize: 50 },
  });
  const entities = body?.entities || [];
  const exact = entities.filter((flow) => flow.name === name);
  const pool = exact.length ? exact : entities.filter((flow) => flow.name?.toLowerCase() === name.toLowerCase());
  if (pool.length > 1) {
    const error = new Error(`Flow name "${name}" matches ${pool.length} ${flowType} flows. Pass --bot-flow-id.`);
    error.candidates = pool.map((flow) => ({ id: flow.id, name: flow.name }));
    throw error;
  }
  return pool[0] || null;
}

async function getFlow(client, flowId) {
  const { body } = await client.request('GET', `/api/v2/flows/${flowId}`);
  return body;
}

async function exportFlowYaml(client, flowId) {
  const { body: job } = await client.request('POST', '/api/v2/flows/export/jobs', {
    body: { flows: [{ flow: { id: flowId }, fileName: 'flow-export', exportType: 'Yaml' }] },
  });
  let state = job;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(2000);
    const poll = await client.request('GET', `/api/v2/flows/export/jobs/${job.id}`);
    state = poll.body;
    if (state.status === 'Success' || state.status === 'Failure') break;
  }
  if (state.status !== 'Success' || !state.downloadUrl) {
    const error = new Error(`Flow YAML export finished as ${state.status || 'unknown'}.`);
    error.details = state;
    throw error;
  }
  const download = await fetch(state.downloadUrl);
  if (!download.ok) throw new Error(`Downloading the exported YAML failed with HTTP ${download.status}.`);
  return download.text();
}

/**
 * Upload YAML through an Architect job. Returns the job outcome including every
 * validation message Architect produced, which is the only reliable signal that
 * a construct in the document was accepted.
 */
async function importFlowYaml(client, yamlText, { timeoutMs = 15 * 60 * 1000, pollMs = 5000 } = {}) {
  const { body: job } = await client.request('POST', '/api/v2/flows/jobs', { body: {} });
  if (!job?.id || !job?.presignedUrl) {
    throw new Error('Architect job registration did not return an upload URL.');
  }
  const upload = await fetch(job.presignedUrl, {
    method: 'PUT',
    headers: job.headers || {},
    body: yamlText,
  });
  if (!upload.ok) throw new Error(`Uploading the flow YAML failed with HTTP ${upload.status}.`);

  const startedAt = Date.now();
  for (;;) {
    // Validation messages are only returned when they are expanded.
    const { body: state } = await client.request('GET', `/api/v2/flows/jobs/${job.id}`, {
      query: { expand: 'messages' },
    });
    if (state?.status === 'Success' || state?.status === 'Failure') {
      return {
        jobId: job.id,
        status: state.status,
        flowId: state.flow?.id || null,
        flowName: state.flow?.name || null,
        messages: (state.messages || [])
          .map((message) => (message.type ? `${message.type}: ${message.text}` : message.text) || null)
          .filter(Boolean),
      };
    }
    if (Date.now() - startedAt > timeoutMs) {
      return { jobId: job.id, status: 'Timeout', flowId: null, messages: ['Architect job did not finish within the timeout.'] };
    }
    await sleep(pollMs);
  }
}

async function deleteFlow(client, flowId) {
  await client.request('DELETE', `/api/v2/flows/${flowId}`);
  return { deleted: true, flowId };
}

async function latestPublishedVersion(client, flowId) {
  const flow = await getFlow(client, flowId);
  return {
    flowId,
    name: flow.name,
    type: flow.type,
    publishedVersion: flow.publishedVersion?.id || null,
    savedVersion: flow.savedVersion?.id || null,
    lockedBy: flow.lockedUser?.name || flow.lockedUser?.id || null,
    division: flow.division?.name || null,
  };
}

module.exports = {
  FLOW_TYPE_BOT,
  deleteFlow,
  exportFlowYaml,
  getFlow,
  importFlowYaml,
  latestPublishedVersion,
  resolveFlowByName,
};
