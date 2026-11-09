'use strict';

/**
 * Speech and Text Analytics: add the bot flow to the General program so the
 * interaction is transcribed and topic-scored.
 *
 * Program mappings are replace-semantics (PUT with the full queueIds/flowIds
 * lists), so the current mapping is always read first and merged.
 */

const { pageAll, sleep } = require('./gc');

const GENERAL_PROGRAM_NAME = 'General';

async function listPrograms(client) {
  return pageAll(client, '/api/v2/speechandtextanalytics/programs', {}, 100, 10);
}

async function resolveProgram(client, name = GENERAL_PROGRAM_NAME) {
  const programs = await listPrograms(client);
  const exact = programs.find((program) => program.name === name);
  const loose = programs.find((program) => program.name?.toLowerCase() === name.toLowerCase());
  const program = exact || loose || null;
  if (!program) {
    const error = new Error(`No Speech and Text Analytics program named "${name}" exists in this org.`);
    error.hint = `Programs found: ${programs.map((p) => p.name).join(', ') || '(none)'}.`;
    throw error;
  }
  return program;
}

async function getMappings(client, programId) {
  const { body } = await client.request('GET', `/api/v2/speechandtextanalytics/programs/${programId}/mappings`);
  return {
    queueIds: (body?.queues || []).map((queue) => queue.id).filter(Boolean),
    flowIds: (body?.flows || []).map((flow) => flow.id).filter(Boolean),
    raw: body,
  };
}

/**
 * Plan or apply the addition of one flow to a program's mappings.
 * Returns the before/after lists so a dry run reads the same as an apply.
 */
async function addFlowToProgram(client, { programName = GENERAL_PROGRAM_NAME, flowId, apply = false, publish = true }) {
  if (!flowId) throw new Error('addFlowToProgram requires a flowId.');
  const program = await resolveProgram(client, programName);
  const current = await getMappings(client, program.id);
  const alreadyMapped = current.flowIds.includes(flowId);
  const flowIds = alreadyMapped ? current.flowIds : [...current.flowIds, flowId];

  const result = {
    programId: program.id,
    programName: program.name,
    alreadyMapped,
    before: { queueIds: current.queueIds, flowIds: current.flowIds },
    after: { queueIds: current.queueIds, flowIds },
    applied: false,
    publishJob: null,
  };
  if (alreadyMapped || !apply) return result;

  await client.request('PUT', `/api/v2/speechandtextanalytics/programs/${program.id}/mappings`, {
    body: { queueIds: current.queueIds, flowIds },
  });
  result.applied = true;

  if (publish) result.publishJob = await publishPrograms(client, [program.id]);
  return result;
}

/** Publish programs so mapping and topic changes take effect. */
async function publishPrograms(client, programIds) {
  const { body: job } = await client.request('POST', '/api/v2/speechandtextanalytics/programs/publishjobs', {
    body: { programIds },
  });
  let state = job;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (state?.state === 'Completed' || state?.state === 'Failed') break;
    await sleep(2000);
    const poll = await client.request('GET', `/api/v2/speechandtextanalytics/programs/publishjobs/${job.id}`);
    state = poll.body;
  }
  return { jobId: job?.id || null, state: state?.state || 'Unknown' };
}

module.exports = {
  GENERAL_PROGRAM_NAME,
  addFlowToProgram,
  getMappings,
  listPrograms,
  publishPrograms,
  resolveProgram,
};
