# The plan artifact

`bot-flow-plan.json` in the session folder is the single source of truth. Every command reads it;
nothing else is hand-edited. `plan` validates it against the live org, `emit-yaml` turns it into
the flow document, `apply` builds from it, `verify` checks the published flow still matches it.

```json
{
  "_meta": {
    "artifact": "ava-bot-flow-plan",
    "status": "draft",
    "ava": { "id": "<sage agent id>", "publishedVersion": "3.0" },
    "sources": ["design-artifact.json", "wrap-up-codes.json", "summary-setting.json"]
  },

  "botFlow": {
    "name": "Acme - Benefits Assistant Bot Flow",
    "description": "Fronts the Benefits Assistant AVA for the Acme POC.",
    "division": "Home",
    "defaultLanguage": "en-us",
    "audioProfile": "silent",
    "speechToTextEngine": { "name": "Microsoft Azure", "defaultEngine": true }
  },

  "ava": {
    "name": "Acme - Benefits Assistant",
    "actionName": "Call Agentic Virtual Agent",
    "exitReasonVariable": "Flow.AvaExitReason",
    "inputs": [
      { "name": "callerAni", "exp": "Call.Ani" }
    ],
    "outputs": [
      { "name": "escalationQueue", "variable": "Flow.AvaEscalationQueue", "role": "escalationQueue" },
      { "name": "resolutionReason", "variable": "Flow.AvaResolutionReason", "role": "exitReason" }
    ]
  },

  "outcome": {
    "name": "Acme - Benefits Assistant Containment",
    "description": "Success when the assistant resolved the call or routed it deliberately."
  },
  "milestones": {
    "before": { "name": "Acme - Assistant Started" },
    "after":  { "name": "Acme - Assistant Completed" }
  },

  "escalation": {
    "defaultQueue": "Acme Support",
    "routes": [
      { "match": "billing", "queue": "Acme Billing" },
      { "match": "sales",   "queue": "Acme Sales" }
    ],
    "outcomeValueOnEscalation": "Success",
    "priority": 0,
    "preTransferCommunication": "Let me put you through to someone who can help.",
    "errorTransferCommunication": "I'm sorry, something went wrong on my end. Let me put you through to someone.",
    "failureTransferCommunication": "I'm sorry, I couldn't connect you right now. Please call back in a few minutes."
  },

  "afterContact": {
    "summarization": true,
    "summarySetting": { "id": "<uuid>", "name": "Acme - Benefits Assistant Summary" },
    "assignWrapupCodes": true,
    "wrapUpCodes": ["Acme - Eligibility confirmed", "..."]
  },

  "speechTextAnalytics": { "enabled": true, "programName": "General", "publish": true },

  "errorHandling": {
    "enableAgentEscalation": true,
    "errorEventHandover": "Sorry, an error occurred. One moment while I put you through to someone who can help."
  }
}
```

## Field notes

| Field | Rule |
|---|---|
| `botFlow.name` | Exact. An existing BOT flow with this name is updated and republished; otherwise a new one is created. Ask the author, or offer the names `discover` found. |
| `botFlow.audioProfile` | `"silent"` is the default: no starting audio, no processing prompt. `"default"` restores Architect's playback timings if the silent profile is rejected. |
| `ava.name` | Must match the published AVA exactly; Architect binds by name. |
| `ava.inputs[].name` / `outputs[].name` | The AVA's own start/end context names. Use `exp` for an Architect expression, `variable` for a flow variable, `lit` for a literal. |
| `outputs[].role` | `escalationQueue` drives the routing decisions; `exitReason` is carried for reporting. Anything else is mapped but unused by the flow. |
| `outcome` / `milestones` | Created in the org by `apply` if they do not exist, then referenced by name. One outcome, two milestones. |
| `escalation.routes[].match` | Compared against the escalation-queue variable with an exact string comparison. Agree the exact values with whoever owns the AVA tool that produces them. |
| `escalation.defaultQueue` | Required. Every unmatched escalation, guardrail stop and error lands here. |
| `afterContact.wrapUpCodes` | Code **names**, which must already exist in the org. `plan` fails on any that do not and warns on any without a description. 15-25 is the standard. |
| `afterContact.summarySetting.name` | Required when summarization is on. The flow binds the setting **by name**, so the name must exist in the org and be unique. The `id` is carried for the handoff only. |
| `speechTextAnalytics.programName` | `General` unless the org uses a dedicated program. |

## How the summary setting binds

The toggle and the setting are two different things. `summarization: lit: true` only turns After
Contact summarisation on; without the setting the flow runs on the org default, which is not the
one built for this AVA. The setting is selected by name:

```yaml
  settingsVirtualAgent:
    summarization:
      lit: true
    conversationSummarySetting:
      name: "AXL - Benefits Assistant Summary"
```

`conversationSummarySetting` is the only key that works. Architect **silently drops** keys it does
not recognise rather than failing the import, so `summarySetting`, `summarizationSetting`,
`summaryConfiguration` and friends all import clean, publish clean, and leave the flow unbound.
That is why `verify` re-exports the published flow and checks `summarySettingBound` against the
planned name — a successful publish proves nothing here.
