'use strict';

/**
 * Flow outcomes and flow milestones are org-level objects. The YAML references
 * them by name, so they must exist before the bot flow is imported.
 */

const { pageAll } = require('./gc');

async function findOutcomeByName(client, name) {
  const entities = await pageAll(client, '/api/v2/flows/outcomes', { name }, 100, 10);
  return entities.find((outcome) => outcome.name === name)
    || entities.find((outcome) => outcome.name?.toLowerCase() === name.toLowerCase())
    || null;
}

async function findMilestoneByName(client, name) {
  const entities = await pageAll(client, '/api/v2/flows/milestones', { name }, 100, 10);
  return entities.find((milestone) => milestone.name === name)
    || entities.find((milestone) => milestone.name?.toLowerCase() === name.toLowerCase())
    || null;
}

async function ensureOutcome(client, { name, description, division }, apply) {
  const existing = await findOutcomeByName(client, name);
  if (existing) return { name, id: existing.id, action: 'reused' };
  if (!apply) return { name, id: null, action: 'would-create' };
  const body = { name, description: description || `Flow outcome for ${name}.` };
  if (division) body.division = { id: division };
  const created = await client.request('POST', '/api/v2/flows/outcomes', { body });
  return { name, id: created.body?.id || null, action: 'created' };
}

async function ensureMilestone(client, { name, description, division }, apply) {
  const existing = await findMilestoneByName(client, name);
  if (existing) return { name, id: existing.id, action: 'reused' };
  if (!apply) return { name, id: null, action: 'would-create' };
  const body = { name, description: description || `Flow milestone for ${name}.` };
  if (division) body.division = { id: division };
  const created = await client.request('POST', '/api/v2/flows/milestones', { body });
  return { name, id: created.body?.id || null, action: 'created' };
}

/** Ensure the outcome and both milestones named by a plan. */
async function ensurePlanTracking(client, plan, apply) {
  const division = plan.botFlow?.divisionId || null;
  const results = { outcome: null, milestones: [] };
  if (plan.outcome?.name) {
    results.outcome = await ensureOutcome(client, { ...plan.outcome, division }, apply);
  }
  for (const key of ['before', 'after']) {
    const milestone = plan.milestones?.[key];
    if (!milestone?.name) continue;
    const result = await ensureMilestone(client, { ...milestone, division }, apply);
    results.milestones.push({ position: key, ...result });
  }
  return results;
}

module.exports = {
  ensureMilestone,
  ensureOutcome,
  ensurePlanTracking,
  findMilestoneByName,
  findOutcomeByName,
};
