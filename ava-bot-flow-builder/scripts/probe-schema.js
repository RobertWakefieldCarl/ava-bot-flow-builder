#!/usr/bin/env node
'use strict';

/**
 * Schema probe — learn which optional Architect YAML constructs this org accepts.
 *
 * Every construct the emitter writes was verified against a live org, so this
 * is a regression check rather than a discovery step: run it when a build fails
 * unexpectedly, or on an org whose Architect version is in doubt.
 *
 *   baseline          AVA call, Transfer to ACD, Exit Bot Flow, After Contact
 *   trackingActions   initializeFlowOutcome / addFlowMilestone / setFlowOutcome
 *   avaContext        outputs: block under ver_latestPublished (needs a real
 *                     end context name via --output-name, else it is skipped)
 *   silentStart       minimum playback timings with the processing prompt off
 *
 * Each is imported on its own as a disposable bot flow, then the flow is
 * deleted. Results are cached to schema-probe.json. Nothing the caller owns is
 * modified.
 */

const path = require('path');
const { emit, fail, makeClient, orgIdentity, parseArgs, writeJson } = require('./lib/gc');
const architect = require('./lib/architect');
const { ensureMilestone, ensureOutcome } = require('./lib/outcomes');
const { buildBotFlowYaml } = require('./lib/flow-yaml');

function probePlan({ flowName, avaName, queueName, outcomeName, milestoneName, outputName, variant }) {
  const plan = {
    botFlow: {
      name: flowName,
      description: 'Disposable schema probe created by ava-bot-flow-builder. Safe to delete.',
      division: 'Home',
      audioProfile: variant === 'silentStart' ? 'silent' : 'default',
    },
    ava: {
      name: avaName,
      exitReasonVariable: 'Flow.ProbeExitReason',
      outputs: variant === 'avaContext'
        ? [{ name: outputName, variable: 'Flow.ProbeQueue', role: 'escalationQueue' }]
        : [],
    },
    outcome: variant === 'trackingActions' ? { name: outcomeName } : null,
    milestones: variant === 'trackingActions'
      ? { before: { name: milestoneName }, after: { name: milestoneName } }
      : {},
    escalation: { defaultQueue: queueName, routes: [] },
    afterContact: { summarization: false, assignWrapupCodes: false, wrapUpCodes: [] },
  };
  // Only the probed construct differs from the confirmed baseline.
  return buildBotFlowYaml(plan, { profile: variant === 'baseline' ? 'degraded' : 'full' });
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const avaName = args['ava-name'];
  const queueName = args['queue-name'];
  if (!avaName || !queueName) {
    throw new Error('probe-schema requires --ava-name "<published AVA>" and --queue-name "<existing queue>".');
  }
  if (!args['confirm-apply']) {
    emit({
      ok: true,
      action: 'probe-schema',
      applied: false,
      note: 'Probing creates and then deletes disposable bot flows (and one flow outcome plus one milestone named zz-ava-schema-probe-*).',
      nextStep: 'Re-run with --confirm-apply.',
    });
    return;
  }

  const { client } = makeClient(args);
  const org = await orgIdentity(client);
  const stamp = Date.now().toString(36);
  const outcomeName = `zz-ava-schema-probe-outcome-${stamp}`;
  const milestoneName = `zz-ava-schema-probe-milestone-${stamp}`;

  const outcome = await ensureOutcome(client, { name: outcomeName, description: 'Disposable schema probe.' }, true);
  const milestone = await ensureMilestone(client, { name: milestoneName, description: 'Disposable schema probe.' }, true);

  const outputName = args['output-name'] || null;
  const variants = ['baseline', 'trackingActions', 'avaContext', 'silentStart'];
  const results = {};
  for (const variant of variants) {
    // An end context name that the AVA does not define fails for the wrong
    // reason, so without a real one this variant proves nothing.
    if (variant === 'avaContext' && !outputName) {
      results[variant] = { skipped: true, reason: 'Pass --output-name "<AVA end context name>" to probe the outputs block.' };
      continue;
    }
    const flowName = `zz-ava-schema-probe-${variant}-${stamp}`;
    const yaml = probePlan({ flowName, avaName, queueName, outcomeName, milestoneName, outputName, variant });
    let job;
    try {
      job = await architect.importFlowYaml(client, yaml);
    } catch (error) {
      results[variant] = { accepted: false, error: error.message };
      continue;
    }
    results[variant] = { accepted: job.status === 'Success', status: job.status, messages: job.messages };
    if (job.flowId) {
      try {
        await architect.deleteFlow(client, job.flowId);
        results[variant].cleanedUp = true;
      } catch (error) {
        results[variant].cleanedUp = false;
        results[variant].cleanupError = `Delete the probe flow "${flowName}" (${job.flowId}) manually: ${error.message}`;
      }
    }
  }

  const contextOk = results.avaContext?.skipped || results.avaContext?.accepted;
  const profile = results.trackingActions?.accepted && contextOk ? 'full' : 'degraded';
  const report = {
    _meta: { artifact: 'ava-bot-flow-schema-probe', generatedAt: new Date().toISOString() },
    org,
    probeOutcome: outcome,
    probeMilestone: milestone,
    results,
    recommendedProfile: profile,
    // The Platform API has DELETE for milestones but not for flow outcomes,
    // so the probe outcome can only be removed in Architect, if at all.
    cleanupNote: `Delete the probe milestone "${milestoneName}" (DELETE /api/v2/flows/milestones/{id}). The probe outcome "${outcomeName}" has no delete endpoint and stays in the org unless it is removed in Architect.`,
  };
  const file = writeJson(path.resolve(args['session-dir'] || process.cwd(), 'schema-probe.json'), report);
  emit({ ok: true, action: 'probe-schema', applied: true, file, recommendedProfile: profile, results });
})().catch(fail);
