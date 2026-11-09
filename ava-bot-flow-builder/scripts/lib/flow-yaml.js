'use strict';

/**
 * Emit an Architect bot-flow YAML document from a bot-flow plan.
 *
 * Every construct emitted here is either confirmed against a real Architect
 * YAML export (see references/bot-flow-yaml.md, "Confirmed" table) or marked
 * probe-dependent. Probe-dependent constructs are only emitted when the plan's
 * schema profile allows them, so a rejected construct can be dropped and the
 * flow rebuilt without it.
 */

const PROFILE_FULL = 'full';
const PROFILE_DEGRADED = 'degraded';

const EXIT_REASONS = Object.freeze(['TriggeredByUser', 'Escalation', 'Guardrails', 'Error']);

function str(value) {
  return JSON.stringify(String(value ?? ''));
}

function communication(text) {
  return str(`MakeCommunication(${JSON.stringify(String(text ?? ''))})`);
}

class Doc {
  constructor() {
    this.lines = [];
  }

  add(indent, text) {
    this.lines.push(`${'  '.repeat(indent)}${text}`);
    return this;
  }

  toString() {
    return `${this.lines.join('\n')}\n`;
  }
}

class TrackingIds {
  constructor(start = 10) {
    this.next = start;
  }

  take() {
    const id = this.next;
    this.next += 1;
    return id;
  }
}

function exitReasonExpression(variable, reason) {
  return `If(IsSet(${variable}), ${variable}, "Error") == "${reason}"`;
}

// Outcome and milestone references are plain `{name: ...}` objects, not
// lit/var/exp value wrappers. A bare string parses but never resolves, and the
// flow then fails validation with "A flow outcome must be selected".
// flowOutcomeValue is the uppercase enum SUCCESS / FAILURE.
function emitSetFlowOutcome(doc, indent, ids, { name, outcomeName, value }) {
  doc.add(indent, '- setFlowOutcome:');
  doc.add(indent + 2, `name: ${str(name)}`);
  doc.add(indent + 2, `trackingId: ${ids.take()}`);
  doc.add(indent + 2, 'flowOutcome:');
  doc.add(indent + 3, `name: ${str(outcomeName)}`);
  doc.add(indent + 2, `flowOutcomeValue: ${String(value).toUpperCase()}`);
}

function emitInitializeFlowOutcome(doc, indent, ids, { name, outcomeName }) {
  doc.add(indent, '- initializeFlowOutcome:');
  doc.add(indent + 2, `name: ${str(name)}`);
  doc.add(indent + 2, `trackingId: ${ids.take()}`);
  doc.add(indent + 2, 'flowOutcome:');
  doc.add(indent + 3, `name: ${str(outcomeName)}`);
}

// A milestone is reported against an outcome, so both must be selected. The
// milestone reference key is `milestone`, not `flowMilestone`: the latter
// parses and then fails validation with "A flow milestone must be selected".
function emitAddFlowMilestone(doc, indent, ids, { name, milestoneName, outcomeName }) {
  doc.add(indent, '- addFlowMilestone:');
  doc.add(indent + 2, `name: ${str(name)}`);
  doc.add(indent + 2, `trackingId: ${ids.take()}`);
  doc.add(indent + 2, 'milestone:');
  doc.add(indent + 3, `name: ${str(milestoneName)}`);
  doc.add(indent + 2, 'flowOutcome:');
  doc.add(indent + 3, `name: ${str(outcomeName)}`);
}

function emitTransferToAcd(doc, indent, ids, { name, queueName, escalation }) {
  doc.add(indent, '- transferToAcd:');
  doc.add(indent + 2, `name: ${str(name)}`);
  doc.add(indent + 2, `trackingId: ${ids.take()}`);
  doc.add(indent + 2, 'targetQueue:');
  doc.add(indent + 3, 'lit:');
  doc.add(indent + 4, `name: ${str(queueName)}`);
  doc.add(indent + 2, 'preTransferCommunication:');
  doc.add(indent + 3, `exp: ${communication(escalation.preTransferCommunication || '')}`);
  doc.add(indent + 2, 'failureTransferCommunication:');
  doc.add(indent + 3, `exp: ${communication(escalation.failureTransferCommunication || '')}`);
  doc.add(indent + 2, 'priority:');
  doc.add(indent + 3, `lit: ${Number(escalation.priority || 0)}`);
  doc.add(indent + 2, 'preferredAgents:');
  doc.add(indent + 3, 'noValue: true');
  doc.add(indent + 2, 'languageSkill:');
  doc.add(indent + 3, 'noValue: true');
  doc.add(indent + 2, 'failureOutputs:');
  doc.add(indent + 3, 'errorType:');
  doc.add(indent + 4, 'noValue: true');
  doc.add(indent + 3, 'errorMessage:');
  doc.add(indent + 4, 'noValue: true');
}

function emitExitBotFlow(doc, indent, ids, name) {
  doc.add(indent, '- exitBotFlow:');
  doc.add(indent + 2, `name: ${str(name)}`);
  doc.add(indent + 2, `trackingId: ${ids.take()}`);
}

function emitCallAva(doc, indent, ids, plan, profile) {
  const ava = plan.ava;
  doc.add(indent, '- callAgenticVirtualAgent:');
  doc.add(indent + 2, `name: ${str(ava.actionName || 'Call Agentic Virtual Agent')}`);
  doc.add(indent + 2, `trackingId: ${ids.take()}`);
  doc.add(indent + 2, 'agenticVirtualAgent:');
  doc.add(indent + 3, `${str(ava.name)}:`);
  doc.add(indent + 4, 'ver_latestPublished:');

  const inputs = (ava.inputs || []).filter((input) => input.name);
  if (inputs.length && profile === PROFILE_FULL) {
    doc.add(indent + 5, 'inputs:');
    for (const input of inputs) {
      doc.add(indent + 6, `${str(input.name)}:`);
      if (input.exp) doc.add(indent + 7, `exp: ${str(input.exp)}`);
      else if (input.variable) doc.add(indent + 7, `var: ${input.variable}`);
      else doc.add(indent + 7, `lit: ${str(input.lit ?? '')}`);
    }
  }

  const outputs = (ava.outputs || []).filter((output) => output.name && output.variable);
  if (outputs.length && profile === PROFILE_FULL) {
    doc.add(indent + 5, 'outputs:');
    for (const output of outputs) {
      doc.add(indent + 6, `${str(output.name)}:`);
      doc.add(indent + 7, `var: ${output.variable}`);
    }
  }

  doc.add(indent + 5, 'exitReason:');
  if (ava.exitReasonVariable) doc.add(indent + 6, `var: ${ava.exitReasonVariable}`);
  else doc.add(indent + 6, 'noValue: true');
}

/** A decision wrapping a "yes" branch of actions. */
function emitDecision(doc, indent, ids, { name, condition }, branch) {
  doc.add(indent, '- decision:');
  doc.add(indent + 2, `name: ${str(name)}`);
  doc.add(indent + 2, `trackingId: ${ids.take()}`);
  doc.add(indent + 2, 'condition:');
  doc.add(indent + 3, `exp: ${str(condition)}`);
  doc.add(indent + 2, 'outputs:');
  doc.add(indent + 3, '"yes":');
  doc.add(indent + 4, 'actions:');
  branch(indent + 5);
}

function escalationQueueVariable(plan) {
  const mapped = (plan.ava?.outputs || []).find((output) => output.role === 'escalationQueue');
  return mapped?.variable || null;
}

function emitBotActions(doc, indent, plan, profile) {
  const ids = new TrackingIds(11);
  const outcomeName = plan.outcome?.name;
  const useOutcome = Boolean(outcomeName) && profile === PROFILE_FULL;
  // A milestone is always reported against an outcome, so it cannot be emitted
  // without one.
  const useMilestones = useOutcome;
  const exitVar = plan.ava?.exitReasonVariable || 'Flow.AvaExitReason';
  const escalation = plan.escalation || {};
  const queueVar = escalationQueueVariable(plan);

  if (useOutcome) {
    emitInitializeFlowOutcome(doc, indent, ids, {
      name: `Initialize Flow Outcome - ${outcomeName}`,
      outcomeName,
    });
  }
  if (useMilestones && plan.milestones?.before?.name) {
    emitAddFlowMilestone(doc, indent, ids, {
      name: `Add Flow Milestone - ${plan.milestones.before.name}`,
      milestoneName: plan.milestones.before.name,
      outcomeName,
    });
  }

  emitCallAva(doc, indent, ids, plan, profile);

  if (useMilestones && plan.milestones?.after?.name) {
    emitAddFlowMilestone(doc, indent, ids, {
      name: `Add Flow Milestone - ${plan.milestones.after.name}`,
      milestoneName: plan.milestones.after.name,
      outcomeName,
    });
  }

  // Escalation is tested before containment, and the contained branch additionally
  // requires an empty queue. An assistant that calls its transfer tool and is then
  // thanked by the caller exits as TriggeredByUser with the escalation queue already
  // set; testing containment first disconnects that caller instead of transferring.
  const routes = (escalation.routes || []).filter((route) => route.queue && route.match);
  const containedCondition = queueVar && routes.length
    ? `${exitReasonExpression(exitVar, 'TriggeredByUser')} and If(IsSet(${queueVar}), ${queueVar}, "") == ""`
    : exitReasonExpression(exitVar, 'TriggeredByUser');

  if (queueVar && routes.length) {
    for (const route of routes) {
      emitDecision(doc, indent, ids, {
        name: `Escalate to ${route.queue}`,
        condition: `If(IsSet(${queueVar}), ${queueVar}, "") == ${JSON.stringify(route.match)}`,
      }, (branchIndent) => {
        if (useOutcome) {
          emitSetFlowOutcome(doc, branchIndent, ids, {
            name: `Set Flow Outcome - Escalated to ${route.queue}`,
            outcomeName,
            value: escalation.outcomeValueOnEscalation === 'Failure' ? 'Failure' : 'Success',
          });
        }
        emitTransferToAcd(doc, branchIndent, ids, {
          name: `Transfer to ACD - ${route.queue}`,
          queueName: route.queue,
          escalation,
        });
        emitExitBotFlow(doc, branchIndent, ids, `Exit Bot Flow - after ${route.queue} transfer`);
      });
    }
  }

  // Caller finished with the assistant and no queue was supplied: contained.
  emitDecision(doc, indent, ids, {
    name: 'Caller ended with the assistant',
    condition: containedCondition,
  }, (branchIndent) => {
    if (useOutcome) {
      emitSetFlowOutcome(doc, branchIndent, ids, {
        name: 'Set Flow Outcome - Contained',
        outcomeName,
        value: 'Success',
      });
    }
    emitExitBotFlow(doc, branchIndent, ids, 'Exit Bot Flow - caller done');
  });

  // Assistant failure or guardrail stop: always a human, always a failed outcome.
  emitDecision(doc, indent, ids, {
    name: 'Assistant error or guardrail stop',
    condition: `${exitReasonExpression(exitVar, 'Error')} or ${exitReasonExpression(exitVar, 'Guardrails')}`,
  }, (branchIndent) => {
    if (useOutcome) {
      emitSetFlowOutcome(doc, branchIndent, ids, {
        name: 'Set Flow Outcome - Assistant failed',
        outcomeName,
        value: 'Failure',
      });
    }
    emitTransferToAcd(doc, branchIndent, ids, {
      name: 'Transfer to ACD - after assistant error',
      queueName: escalation.defaultQueue,
      escalation: { ...escalation, preTransferCommunication: escalation.errorTransferCommunication || escalation.preTransferCommunication },
    });
    emitExitBotFlow(doc, branchIndent, ids, 'Exit Bot Flow - after error transfer');
  });

  // Default tail: escalation without a recognised queue, or any unmapped exit.
  if (useOutcome) {
    emitSetFlowOutcome(doc, indent, ids, {
      name: 'Set Flow Outcome - Escalated to default queue',
      outcomeName,
      value: escalation.outcomeValueOnEscalation === 'Failure' ? 'Failure' : 'Success',
    });
  }
  emitTransferToAcd(doc, indent, ids, {
    name: `Transfer to ACD - ${escalation.defaultQueue}`,
    queueName: escalation.defaultQueue,
    escalation,
  });
  emitExitBotFlow(doc, indent, ids, 'Exit Bot Flow');
}

function emitErrorHandling(doc, plan) {
  const handling = plan.errorHandling || {};
  doc.add(1, 'settingsErrorHandling:');
  doc.add(2, 'errorHandling:');
  doc.add(3, 'exit:');
  doc.add(4, 'none: true');
  doc.add(2, 'enableAgentEscalation:');
  doc.add(3, `lit: ${handling.enableAgentEscalation === false ? 'false' : 'true'}`);
  doc.add(2, 'errorEventHandover:');
  doc.add(3, `exp: ${communication(handling.errorEventHandover
    || 'Sorry, an error occurred. One moment, please, while I put you through to someone who can help.')}`);
  doc.add(2, 'agentEscalationConfirmation:');
  doc.add(3, `exp: ${communication(handling.agentEscalationConfirmation
    || 'You want to speak to an advisor. Is that correct?')}`);
  doc.add(2, 'agentEscalationHandover:');
  doc.add(3, `exp: ${communication(handling.agentEscalationHandover
    || 'One moment, please, and I will put you through to someone.')}`);
  doc.add(2, 'recognitionFailureEventHandover:');
  doc.add(3, `exp: ${communication(handling.recognitionFailureEventHandover
    || "Sorry, I'm having trouble understanding you. One moment, please, while I put you through to someone who can help.")}`);
  doc.add(2, 'recognitionFailureEventHandling:');
  doc.add(3, 'exit:');
  doc.add(4, 'none: true');
  doc.add(2, 'agentEscalationHandling:');
  doc.add(3, 'exit:');
  doc.add(4, 'none: true');
}

function emitAfterContact(doc, plan) {
  const afterContact = plan.afterContact || {};
  const summarization = afterContact.summarization !== false;
  doc.add(1, 'settingsVirtualAgent:');
  doc.add(2, 'summarization:');
  doc.add(3, `lit: ${summarization ? 'true' : 'false'}`);
  // The AI Studio summary setting is selected by name under `conversationSummarySetting`.
  // Architect drops unrecognised keys silently rather than failing the import, so the
  // five plausible-looking alternatives (summarySetting, summarizationSetting,
  // summaryConfiguration, ...) import clean and leave the flow on the default setting.
  // Only this key survives a round-trip; verify re-exports and checks for it.
  const settingName = afterContact.summarySetting?.name;
  if (summarization && settingName) {
    doc.add(2, 'conversationSummarySetting:');
    doc.add(3, `name: ${str(settingName)}`);
  }
  doc.add(2, 'assignWrapupCodes:');
  const codes = (afterContact.wrapUpCodes || []).filter(Boolean);
  doc.add(3, `lit: ${afterContact.assignWrapupCodes === false || !codes.length ? 'false' : 'true'}`);
  if (codes.length && afterContact.assignWrapupCodes !== false) {
    doc.add(2, 'enabledWrapupCodes:');
    doc.add(3, 'lit:');
    for (const code of codes) {
      doc.add(4, '- lit:');
      doc.add(6, `name: ${str(code)}`);
    }
  }
}

/** Build the complete bot-flow YAML document. */
function buildBotFlowYaml(plan, options = {}) {
  const profile = options.profile === PROFILE_DEGRADED ? PROFILE_DEGRADED : PROFILE_FULL;
  const flow = plan.botFlow || {};
  const language = flow.defaultLanguage || 'en-us';
  const silentStart = (flow.audioProfile || 'silent') === 'silent';
  const doc = new Doc();

  doc.add(0, 'botFlow:');
  doc.add(1, `name: ${str(flow.name)}`);
  doc.add(1, `description: ${str(flow.description || '')}`);
  doc.add(1, `division: ${str(flow.division || 'Home')}`);
  doc.add(1, 'startUpRef: "/botFlow/bots/bot[Default Bot_10]"');
  doc.add(1, `defaultLanguage: ${language}`);
  doc.add(1, 'supportedLanguages:');
  doc.add(2, `${language}:`);
  doc.add(3, 'defaultLanguageSkill:');
  doc.add(4, 'noValue: true');
  doc.add(3, 'speechToText:');
  doc.add(4, 'engine:');
  doc.add(5, `name: ${str(flow.speechToTextEngine?.name || 'Microsoft Azure')}`);
  doc.add(5, `defaultEngine: ${flow.speechToTextEngine?.defaultEngine === false ? 'false' : 'true'}`);

  emitErrorHandling(doc, plan);

  doc.add(1, 'settingsPrompts:');
  doc.add(2, 'ensureAudioInPrompts: false');
  doc.add(2, 'promptMediaToValidate:');
  doc.add(3, '- mediaType: audio');
  doc.add(3, '- mediaType: tts');

  // No starting audio and no processing prompt: the caller hears the assistant
  // first and nothing in between.
  doc.add(1, 'settingsBotFlow:');
  doc.add(2, 'voiceProcessingPrompt:');
  doc.add(3, 'noValue: true');
  // Both are duration values: noValue is rejected, and the floors are 100 ms
  // for the delay and 1 second for the minimum playback time. A silent start
  // uses those floors — with the processing prompt off there is nothing for
  // them to play anyway.
  doc.add(2, 'initialPlaybackDelay:');
  doc.add(3, 'lit:');
  doc.add(4, `ms: ${silentStart ? 100 : 250}`);
  doc.add(2, 'minimumPlaybackTime:');
  doc.add(3, 'lit:');
  doc.add(4, 'seconds: 1');
  doc.add(2, 'virtualAgentEnabled: true');

  doc.add(1, 'settingsKnowledge:');
  doc.add(2, 'none: true');

  emitAfterContact(doc, plan);

  doc.add(1, 'bots:');
  doc.add(2, '- bot:');
  doc.add(4, 'name: "Default Bot"');
  doc.add(4, 'refId: Default Bot_10');
  doc.add(4, 'trackingId: 10');
  doc.add(4, 'actions:');
  emitBotActions(doc, 5, plan, profile);

  doc.add(1, 'settingsNaturalLanguageUnderstanding:');
  doc.add(2, 'nluDomainVersion:');
  doc.add(3, `language: ${language}`);
  doc.add(3, 'languageVersions: {}');
  doc.add(3, 'result: ok');

  return doc.toString();
}

module.exports = {
  EXIT_REASONS,
  PROFILE_DEGRADED,
  PROFILE_FULL,
  buildBotFlowYaml,
  escalationQueueVariable,
};
