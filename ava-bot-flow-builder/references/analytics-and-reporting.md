# Outcomes, milestones and Speech and Text Analytics

Three different reporting systems, all switched on by this skill, all answering different
questions about the same call.

## Flow outcomes — did the assistant work?

A flow outcome is an org-level object (`POST /api/v2/flows/outcomes`) that a flow marks as Success
or Failure. One outcome per bot flow is the right granularity for a POC: "did the Benefits
Assistant handle this call".

- **Initialize Flow Outcome** before the AVA opens tracking and starts the clock.
- **Set Flow Outcome** after the AVA closes it with Success or Failure.
- Without the initialize action, start and end are both stamped at the moment Set runs, so the
  duration metric is meaningless. That is why the emitter always writes both.
- If Initialize runs but Set is never reached — the caller hangs up mid-conversation — the end time
  stays null, which is itself the signal that the call was abandoned inside the assistant.

What Success means is a business decision, so it is in the plan, not the code.
`escalation.outcomeValueOnEscalation` defaults to `Success`: a deliberate, correctly routed
escalation is the assistant working as designed. Set it to `Failure` only when the POC's goal is
pure containment and any human contact counts against it. Guardrail stops and assistant errors are
always Failure.

Reporting lands in Flow Outcome views and the flow performance dashboards.

## Flow milestones — how far did they get?

A milestone (`POST /api/v2/flows/milestones`) marks a point reached on the way to an outcome. Two
of them bracket the AVA:

| Milestone | Meaning |
|---|---|
| before the AVA | The caller reached the assistant at all — routing and telephony worked |
| after the AVA | The assistant ran to completion rather than erroring out mid-session |

The gap between the two counts is the number of calls that entered the assistant and never came
back out, which is the single most useful number in an early POC. Platform limits are 5,000
milestones per org, 20 milestones per outcome and 100 per flow — nowhere near binding here.

A milestone is always reported **against an outcome**, so the Add Flow Milestone action names both.
That is why the emitter refuses to write milestones for a plan with no outcome.

Both objects are created by `apply` when they do not already exist, and reused by name when they
do. Milestones can be deleted through the API; **flow outcomes cannot** — there is no delete
endpoint. A mistyped outcome name is permanent unless it can be removed in Architect, so agree the
name before applying.

## Speech and Text Analytics — what was actually said?

Mapping the bot flow into a program is what makes the conversation transcribed and topic-scored,
which is also what makes transcripts available for later analysis of what callers asked the
assistant.

```
GET  /api/v2/speechandtextanalytics/programs                  find "General"
GET  /api/v2/speechandtextanalytics/programs/{id}/mappings    read current queueIds + flowIds
PUT  /api/v2/speechandtextanalytics/programs/{id}/mappings    write the merged lists
POST /api/v2/speechandtextanalytics/programs/publishjobs      publish so it takes effect
```

The PUT **replaces** both lists. `scripts/lib/sta.js` always reads the current mappings and appends,
never writes a bare `{flowIds: [one]}` — doing that would silently unmap every queue and flow the
program already covered. If the flow is already mapped it is a no-op and reports as such.

A mapping change does nothing until the program is published, so `apply` runs the publish job and
reports its state. The General program is shared: adding a flow to it affects the whole org's
analytics configuration, so say so before applying in a shared org.
