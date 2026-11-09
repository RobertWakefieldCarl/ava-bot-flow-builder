# The bot flow document

The flow is built as an Architect YAML document and pushed through the Architect job endpoint
(`POST /api/v2/flows/jobs` → PUT the YAML to the presigned URL → poll the job). The job matches an
existing flow by **name and type**, creates it when there is none, saves the configuration and
publishes it. There is no dry run: a job either succeeds or returns `Failure` with validation
messages and leaves no new version behind.

`scripts/lib/flow-yaml.js` emits the document. Never hand-write the YAML — edit the plan and
re-emit, so the published flow and the plan never drift.

## Confirmed constructs

Every shape below was verified by publishing it to a live org, not inferred.

| Construct | Shape |
|---|---|
| Flow root | `botFlow:` with `name`, `description`, `division`, `startUpRef`, `defaultLanguage`, `supportedLanguages` |
| Start point | `startUpRef: "/botFlow/bots/bot[Default Bot_10]"` pointing at the single `bots[0].bot` |
| Processing prompt off | `settingsBotFlow.voiceProcessingPrompt: {noValue: true}` |
| Virtual Agent host | `settingsBotFlow.virtualAgentEnabled: true` |
| Call the AVA | `callAgenticVirtualAgent.agenticVirtualAgent.<AVA name>.ver_latestPublished`, with `exitReason: {var: Flow.X}` and optional `inputs:` / `outputs:` maps keyed by context name |
| Open outcome tracking | `initializeFlowOutcome.flowOutcome: {name: <outcome>}` |
| Close outcome tracking | `setFlowOutcome.flowOutcome: {name: <outcome>}` plus `flowOutcomeValue: SUCCESS` or `FAILURE` |
| Milestone | `addFlowMilestone.milestone: {name: <milestone>}` plus `flowOutcome: {name: <outcome>}` |
| Escalate | `transferToAcd` with `targetQueue.lit.name`, pre/failure communications, `priority`, `failureOutputs` |
| Branch | `decision` with `condition.exp` and `outputs."yes".actions` |
| End | `exitBotFlow` |
| After Contact summary | `settingsVirtualAgent.summarization: {lit: true}` |
| After Contact summary setting | `settingsVirtualAgent.conversationSummarySetting: {name: <setting>}` — selects the AI Studio setting; without it the toggle runs the org default |
| After Contact wrap-up | `settingsVirtualAgent.assignWrapupCodes: {lit: true}` and `enabledWrapupCodes.lit` as a list of `- lit: {name: <code>}` |

Every action carries a `name` and a `trackingId`; the emitter numbers them from 11 (the bot itself
is 10) so two emissions of the same plan produce the same document.

## Shapes that look right and are not

These cost a failed publish each. They are written down so nobody reintroduces them.

| Wrong | Right | How it fails |
|---|---|---|
| `flowOutcome: {lit: {name: X}}` | `flowOutcome: {name: X}` | "expected a string but got undefined" |
| `flowOutcome: "X"` on Set Flow Outcome | `flowOutcome: {name: X}` | Parses, then fails validation with "A flow outcome must be selected" |
| `flowOutcomeValue: {lit: Success}` | `flowOutcomeValue: SUCCESS` | "expected a string but got a object value" |
| `flowOutcomeValue: Success` | `flowOutcomeValue: SUCCESS` | "is not a valid value. Valid values are 'SUCCESS', 'FAILURE'" |
| `flowMilestone: {name: X}` | `milestone: {name: X}` | Parses, then fails validation with "A flow milestone must be selected" |
| Milestone with no outcome | Both `milestone` and `flowOutcome` | "A flow outcome must be selected" |
| `initialPlaybackDelay: {noValue: true}` | `{lit: {ms: 100}}` or more | "you cannot assign no value" |
| `minimumPlaybackTime` under 1 second | `{lit: {seconds: 1}}` | "must be greater than or equal to 1 second" |
| `summarySetting`, `summarizationSetting`, `summaryConfiguration` | `conversationSummarySetting: {name: X}` | **Does not fail at all.** Architect drops unrecognised keys, so the job succeeds, the flow publishes, and the summary runs on the org default |

The last row is the dangerous one. A clean publish is not evidence that a key was applied; only a
re-export is. Anything the emitter writes that is not in the confirmed table above needs a
round-trip test before it is believed — that is what `probe-schema.js` is for.

One warning is expected on every publish and is not a problem: *"The builder configuration has one
or more warnings for Voice Processing Prompt"* is Architect noting that the processing prompt is
switched off, which is exactly the intent.

## Reading Architect's verdict

Validation messages are only returned when they are asked for:

```
GET /api/v2/flows/jobs/{jobId}?expand=messages
```

Without `expand=messages` a failed job reports `status: "Failure"` and nothing else, which is
indistinguishable from a transport problem. `scripts/lib/architect.js` always expands them, and
`apply` surfaces them verbatim.

Two message styles matter. A **parse** error names the YAML property and path and means the
document shape is wrong. A **validation** error (`ArchValidationIssue`) means the document parsed
but the flow is not publishable — most often a reference that did not resolve, such as an end
context name the AVA does not define: *"unable to find 'X' on the action 'callAgenticVirtualAgent'"*.
That one is a plan error, not a schema error: fix the name in `ava.outputs`.

## The degraded profile

`apply --degrade-on-reject` retries once with the `degraded` profile, which drops the outcome,
the milestones and the AVA context maps, then records every dropped item as a manual Architect
step in the handoff. A degraded flow still calls the AVA, escalates and carries After Contact. Use
`scripts/probe-schema.js` to find out which construct an org rejects before falling back blindly.

## Action order

```
Initialize Flow Outcome        <- outcome tracking opens
Add Flow Milestone (before)    <- "reached the assistant"
Call Agentic Virtual Agent     <- the starting action the caller hears first
Add Flow Milestone (after)     <- "assistant finished"
Decision: AVA escalation queue == <value>     (one per route)
    Set Flow Outcome Success -> Transfer to ACD <queue> -> Exit Bot Flow
Decision: exit reason == TriggeredByUser and escalation queue is empty
    Set Flow Outcome Success -> Exit Bot Flow
Decision: exit reason == Error or Guardrails
    Set Flow Outcome Failure -> Transfer to ACD <default queue> -> Exit Bot Flow
Set Flow Outcome Success -> Transfer to ACD <default queue> -> Exit Bot Flow
```

Escalation is tested **before** containment, and the contained branch also requires an empty
queue. Both guards exist for the same observed failure: an assistant that calls its transfer tool,
tells the caller it is connecting them, and is then thanked, exits as `TriggeredByUser` with the
escalation queue already set. Testing containment first hangs up on a caller who was promised a
person. Order the branches the other way and that caller is transferred.

The tail is deliberate too: an escalation whose queue value does not match any route still reaches
a human on the default queue rather than falling off the end of the flow.

## No starting audio

Two separate things make the caller hear the assistant and nothing else:

1. **No audio action before the AVA call.** The emitter never writes a Communicate or Play Audio
   action; the first caller-facing action is `callAgenticVirtualAgent`.
2. **No processing prompt.** `settingsBotFlow.voiceProcessingPrompt` is `noValue: true`, so the
   "connecting" vibe that Architect adds by default is gone.

A greeting that the business still wants belongs in the **inbound call flow** that calls this bot
flow, not here. This skill never edits the inbound call flow.

## Dynamic escalation queues

`transferToAcd.targetQueue` is emitted as a literal queue name, one `decision` branch per queue the
AVA can name. This uses only confirmed constructs and keeps the queue list reviewable in the plan.

Bot flows do also support a Find Queue action, which would let the AVA hand back an arbitrary queue
name. That is deliberately not emitted: an unverified queue name at runtime produces a failed
transfer, and a POC wants the explicit, reviewable list. If an org genuinely needs open-ended queue
routing, add Find Queue in Architect after the flow is built and re-run `verify`.

## Updating an existing flow

Give the plan the **exact existing flow name**. The job then updates and republishes that flow
rather than creating a second one. `plan` reports `mode: update-existing-flow` when it finds a
match, and refuses when the name matches more than one flow or the flow is locked by a user in
Architect.
