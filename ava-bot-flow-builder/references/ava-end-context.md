# What the AVA must hand back

The flow routes on two things the assistant returns: the **exit reason** and the **escalation
queue**. One is free, the other has to be designed into the AVA.

## Exit reason — always available

`callAgenticVirtualAgent` exposes an exit reason on every call, with four values:

| Value | Meaning | What the flow does |
|---|---|---|
| `TriggeredByUser` | The caller finished with the assistant | Outcome Success, exit the bot flow |
| `Escalation` | The assistant decided a human is needed | Outcome Success, transfer to the routed queue |
| `Guardrails` | A guardrail stopped the conversation | Outcome Failure, transfer to the default queue |
| `Error` | The assistant failed, or `request.too.large` | Outcome Failure, transfer to the default queue |

Map it to a flow variable in the plan (`ava.exitReasonVariable`, conventionally
`Flow.AvaExitReason`). Without it the flow cannot tell a contained call from an escalation, so
`plan` treats a missing value as an error.

The action also has its own Success, Failure and Timeout paths, which are separate from the exit
reason and are handled by the flow's error handling settings.

## Escalation queue — must be designed in

End context variables are **not** filled by the assistant's reasoning. A value reaches end context
only when it came in through start context or out of a mapped **tool or data action output**. An
instruction like "set `escalationQueue` to Billing when the caller needs billing" does nothing on
its own.

So one of these has to be true before the plan can route by queue:

1. **A tool returns it.** The AVA already calls a tool whose output names the destination — a
   routing lookup, a case-creation action that returns an owning team, an eligibility check that
   returns a department. Map that output field into end context and expose it.
2. **An escalation tool exists for exactly this.** Add a small data action or Genesys Cloud Function
   that takes the reason the assistant determined and returns a queue name from a fixed list. The
   assistant calls it before escalating. This is the usual POC answer and keeps the queue list on
   the server side where it can be reviewed.
3. **No queue variable at all.** Leave `escalation.routes` empty. Every escalation goes to
   `escalation.defaultQueue`. This is a perfectly good single-queue POC and avoids pretending the
   AVA is making a routing decision it cannot make.

Ask the author which of the three applies — never assume option 1 because an end context variable
happens to exist with a promising name.

## Also worth returning

Exit *reason* in the sense the business means it — "coverage confirmed", "verification failed",
"out of scope" — is not the Architect exit reason. If the AVA has a tool output carrying that, map
it into end context too and list it in `ava.outputs` with `role: "exitReason"`. It then lands in
the flow as a variable, reaches the custom summary as an attribute, and gives the wrap-up codes
something concrete to align to.

## Collecting the facts

The AVA's published definition is read through the harness MCP tools, not through these scripts:

- `get_ava` — confirm the assistant exists and get its id
- `get_latest_published_version` — the published version the flow will bind (`ver_latestPublished`)
- the version's start context and end context lists — the exact variable **names** to put in
  `ava.inputs[].name` and `ava.outputs[].name`

Names must match the AVA definition character for character; Architect binds them by name. If the
AVA has no published version, stop: `ver_latestPublished` has nothing to bind and the Architect job
will fail.
