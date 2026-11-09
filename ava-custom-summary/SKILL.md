---
name: ava-custom-summary
description: >
  Builds a Detailed Genesys Cloud custom AI summary for an AXL AVA: auto-generates the
  five-part model (summary, reason, outcome, next best action, tool-based attribute extract)
  from spec-artifact and design-artifact, validates, creates the setting, and binds After
  Contact on the Architect bot flow. Use for custom summary, AI summary, supervisor wrap-up,
  or disposition fields after an AVA call.
disable-model-invocation: true
compatibility: >-
  Requires Node.js 22 or newer and an ava-harness entry in Cursor MCP configuration with Genesys
  Cloud OAuth Client Credentials and AVA_HABITAT.
metadata:
  version: 2.0.0
---

# AVA custom summary

Configure what supervisors see after an AVA interaction: a **summary** (the full wrap-up), plus
structured **reason for call**, **outcome of call**, **next best action**, and an **attribute
extract** tied to **every decision-relevant tool field** in the AVA design.

Resolve `<SkillDir>` as the directory containing this file. Run commands from the user's active
workspace.

## AXL default (automatic)

For AXL workshops, prefer the **orchestrator** — it generates a **Detailed** setting with full
attribute extract, then plans or applies bot-flow binding:

```powershell
node "<SkillDir>/scripts/ava-custom-summary-axl.js" plan-axl `
  --session-dir "axl-sessions/AXL-<customer>" `
  --lifecycle-dir ".ava-lifecycle/<slug>" `
  [--inbound-flow-name "<Inbound Architect flow>"]

node "<SkillDir>/scripts/ava-custom-summary-axl.js" apply-axl `
  ...same flags... --confirm-apply
```

Regenerate JSON only from spec + design:

```powershell
node "<SkillDir>/scripts/generate-summary-setting.js" `
  --session-dir "axl-sessions/AXL-<customer>" `
  --lifecycle-dir ".ava-lifecycle/<slug>" [--regenerate via orchestrator]
```

Details: [references/auto-generation-axl.md](references/auto-generation-axl.md).

Manual edits remain valid — re-run `validate` and `apply-axl` after changing `summary-setting.json`.

## Required reading

| When | Read |
|---|---|
| AXL automation | [references/auto-generation-axl.md](references/auto-generation-axl.md) |
| Five-part mapping | [references/spec-to-summary-mapping.md](references/spec-to-summary-mapping.md) |
| Tool entities | [references/tool-attribute-extract.md](references/tool-attribute-extract.md) |
| API writes | [references/platform-api.md](references/platform-api.md) |

## Five-part output model

| # | Facilitator term | Platform mechanism | What it contains |
|---|---|---|---|
| 1 | **Summary** | `summaryType` + `format` | Full wrap-up document (default **Detailed** for AXL). |
| 2 | **Reason for call** | `ReasonForCall` | Intents from spec §1. |
| 3 | **Outcome of call** | `Resolution` | Success and refusal paths from spec §2 / §4. |
| 4 | **Next best action** | `ActionItems` | Handoffs and callbacks from spec §4. |
| 5 | **Attribute extract** | `customEntities[]` | All mapped tool inputs/outputs (≤10); trace in `_meta.attributeExtract`. |

Default **`format`**: `GroupedBulletPoints`. Default **`summaryType`** for auto-generated AXL files:
**`Detailed`**.

Generated files are **custom-prompt** settings: `settingType: "Prompt"` with a `prompt` built from
the spec's use cases, the assistant's tool outputs and the four ways an AVA conversation can end
(contained, escalated, guardrail stop, error). The prompt is what makes the summary specific to
this assistant — `Basic` only picks a length and a layout. Pass `--setting-type basic` to opt out,
and read the generated prompt before accepting it: with `Prompt`, that text is the configuration.

## What this produces

1. `summary-setting.json` in the **session folder** (with `_meta.insightGuidance` for facilitators).
2. Genesys Cloud setting after `apply-axl --confirm-apply` or `create --confirm-apply`.
3. Bot flow: `bind-bot-flow-manual.md`, `after-contact.patch.yaml` fragment, **`custom-summary-handoff.html`**.

Track 1 (AXL phone): **Architect bot flow After Contact**. Track 2 (Copilot queue): `bind --assistant`.

## Operating rules

1. **Traceable fields** — from `spec-artifact.md`, `design-artifact.json`, or facilitator input.
2. **One session folder** — no silent reuse of another customer's JSON.
3. **All three predefined insights** always.
4. **Attribute extract is tool-driven** — generator walks all DataAction outputs/inputs and KB tools.
5. **No insight synonyms** as custom entities.
6. **Org confirm** before writes: `gc_summary_setting.js whoami`.
7. **Plan before apply** — dry-run unless `--confirm-apply`.
8. **Never print credentials.**

## Workflow (AXL)

```
- [ ] 0. Preflight — session, spec, lifecycle slug, org (whoami)
- [ ] 1. plan-axl — auto-generate summary-setting.json + validate + telephony + bind plan
- [ ] 2. Facilitator review — entity table, insightGuidance, warnings
- [ ] 3. apply-axl --confirm-apply — create setting + bind-bot-flow + HTML
- [ ] 4. Publish bot YAML via gc-callflow-test after reviewing after-contact.patch.yaml
- [ ] 5. Five-part readout to facilitator
```

### Step 0 — Preflight

1. `node "<SkillDir>/scripts/gc_summary_setting.js" whoami`
2. `axl-sessions/AXL-<customer>/spec-artifact.md` required.
3. `.ava-lifecycle/<slug>/design-artifact.json` required for auto-generation.
4. Optional: `list --name "<customer>"` to avoid duplicate setting names.

### Step 1 — Plan (automatic)

Run **`plan-axl`** (see above). Review:

- `customEntities` count and labels (≤10)
- `_meta.attributeExtract` trace per entity
- `_meta.insightGuidance` for reason / outcome / next best action emphasis
- Validator warnings from `steps.validate`

### Step 2 — Apply

```powershell
node "<SkillDir>/scripts/ava-custom-summary-axl.js" apply-axl `
  --session-dir "axl-sessions/AXL-<customer>" `
  --lifecycle-dir ".ava-lifecycle/<slug>" `
  --confirm-apply
```

Persists `id` on `summary-setting.json` after create. **`bind-bot-flow`** writes the After Contact
fragment (pairs with [ava-wrap-up-codes](../ava-wrap-up-codes/SKILL.md) when wrap-up codes exist).

### Step 3 — Preview (optional)

```powershell
node "<SkillDir>/scripts/gc_summary_setting.js" preview `
  --file "<session>/summary-setting.json" --transcript "<session>/sample-transcript.txt"
```

### Manual / non-AXL workflow

Use individual commands when not running the orchestrator:

| Step | Command |
|------|---------|
| Validate | `gc_summary_setting.js validate --file ...` |
| Create | `create --file ... [--confirm-apply]` |
| Discover | `discover-telephony --inbound-flow-id ... --out <session>/telephony-bindings.json` |
| Bind plan | `plan-bind-bot-flow --bindings ... --file summary-setting.json` |
| Bind apply | `bind-bot-flow ... --confirm-apply` |
| Copilot | `bind --assistant <uuid> --id <settingId>` |

Example artifact shape (truncated):

```json
{
  "_meta": {
    "summaryModel": "summary|reason|outcome|nextBestAction|attributeExtract",
    "useCases": [{ "name": "Balance inquiry", "source": "spec-artifact.md §1" }],
    "attributeExtract": [{ "entityLabel": "Checking balance", "tool": "...", "source": "output.field" }],
    "insightGuidance": { "reasonForCall": "...", "resolution": "...", "actionItems": "..." }
  },
  "name": "AXL - Customer - AVA Name",
  "summaryType": "Detailed",
  "format": "GroupedBulletPoints",
  "predefinedInsights": ["ReasonForCall", "Resolution", "ActionItems"],
  "customEntities": [{ "label": "...", "description": "..." }]
}
```

### Session HTML handoff

`apply-axl`, `create`, `bind-bot-flow`, and `write-session-html` produce
**`custom-summary-handoff.html`** at the session root.

```powershell
node "<SkillDir>/scripts/gc_summary_setting.js" write-session-html `
  --session-dir "<session>" --file "<session>/summary-setting.json" `
  --bindings "<session>/telephony-bindings.json"
```

## Guardrails

- Never delete a summary setting via this skill.
- Never put real customer data in configuration JSON.
- Never extract or ask for secrets in entity descriptions.
- Never claim live preview wording was reviewed when only validation ran.

## Completion message

```
AVA custom summary complete — <customer>
  Setting: <name> (<id or plan-only>)
  Entities: <N> (Detailed, GroupedBulletPoints)
  Bot flow: <bound|planned|skipped>
  HTML: custom-summary-handoff.html
  Next: review after-contact.patch.yaml → gc-callflow-test publish
```
