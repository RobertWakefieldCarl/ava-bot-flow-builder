# From AVA design to a five-part summary setting

Every field comes from something the session or the AVA already decided. If a value is not in
`spec-artifact.md`, `design-artifact.json`, or the facilitator's answer, it is not known — ask, or
mark `_(assumed)_` in `_meta`.

## Five-part model (facilitator ↔ platform)

| Facilitator term | Genesys mechanism | Notes |
|---|---|---|
| **Summary** | Entire generated output | Controlled by `summaryType`, `format`, and the insights + entities together. Not a fourth insight. |
| **Reason for call** | `ReasonForCall` | Required predefined insight. |
| **Outcome of call** | `Resolution` | Required predefined insight. |
| **Next best action** | `ActionItems` | Required predefined insight. Prefer one clear NBA over a long task list. |
| **Attribute extract** | `customEntities[]` | Tool- and gate-driven facts; trace in `_meta.attributeExtract`. See [tool-attribute-extract.md](tool-attribute-extract.md). |

**Always send all three insights.** They cannot be renamed. Shaping their content is done by (a)
planning what each use case implies, and (b) custom entities that supply structured facts without
duplicating the three sections.

Do **not** add custom entities whose labels restate Summary, Reason, Outcome, or Next best action —
the validator rejects those synonyms.

## Where each setting field comes from

Primary source: `spec-artifact.md`. Tool precision: `.ava-lifecycle/<slug>/design-artifact.json`.

| Field | Source | Notes |
|---|---|---|
| `name` | Internal setup → AVA build name | Fallback: `AXL - <customer> - <use case>`. ≤100 chars. |
| `language` | §3 Language(s) | BCP-47 (`en-US`). One setting per language. |
| `participantLabels.virtualAgent` | §3 Name | AVA name (e.g. Matthew), not "Bot". |
| `participantLabels.external` | Industry | Customer, Member, Policyholder, … |
| `participantLabels.internal` | §4 handoff target | Agent, Specialist, … |
| `predefinedInsights` | Fixed trio | `ReasonForCall`, `Resolution`, `ActionItems`. |
| `customEntities` | AVA tools/types + §4 gates | Attribute extract — see tool-attribute-extract.md. |
| `_meta.attributeExtract` | Same as entities | Provenance for readout and future AVA edits. |
| `_meta.summaryModel` | Fixed string | Record `summary|reason|outcome|nextBestAction|attributeExtract` for traceability. |
| `maskPII.all` | Secrets policy + readout audience | See [masking trap](#the-masking-trap). |
| `summaryType` | Readout audience | Executive → `Concise`. Practitioner → `Detailed`. |
| `format` | Default `GroupedBulletPoints` | Keeps reason / outcome / next best action visible inside the summary. |
| `settingType` | Default `Basic` | `Prompt` only for ordering/length/wording `Basic` cannot express. |

### How use cases shape sections 2–4

The use case does not map to one API field — it defines what belongs in each insight:

- **Reason for call** ← §1 one-liner plus accepted intents (e.g. balance inquiry vs transfer vs card policy).
- **Outcome of call** ← §2 great outcome plus §4 unhappy paths (refused transfer, verification failed).
- **Next best action** ← escalation targets, promised callbacks, customer homework, or explicit none.

When multiple use cases share one AVA, union the attribute extract but **prune to six** entities
supervisors act on.

## Attribute extract (section 5)

Custom entities are the attribute extract. Derive them primarily from the AVA design:

1. **DataAction tools** — inputs the caller provides; outputs disclosed after verification.
2. **KnowledgeBase tools** — policy *topic* only when KB was used for general policy (not account facts).
3. **Verification gates** in instructions/guardrails — method and pass/fail, never secrets.

Full algorithm: [tool-attribute-extract.md](tool-attribute-extract.md).

### Rules (unchanged essentials)

1. Never duplicate predefined insights as entity labels.
2. Never invent entities for data no tool captures.
3. One entity per decision-relevant fact, not per schema field.
4. Label for supervisors (≤30 chars); description for the model (≤120 chars).
5. Never secrets in labels or descriptions.
6. No real customer data in configuration files.

## The masking trap

`maskPII.all: true` redacts PII in **custom entities** too. Identifier-like entities will appear
empty. Choose masking deliberately and document in the readout.

## Format and the summary (section 1)

| Format | Shape | Use when |
|---|---|---|
| `GroupedBulletPoints` | Labeled sections, bullets | **Default** — best for five-part scanability. |
| `GroupedTextBlocks` | Labeled sections, prose | Practitioner summaries. |
| `BulletPoints` | Flat list | Very short interactions only. |
| `TextBlock` | Single paragraph | Case-note paste targets. |

Ungrouped formats hide section headings; validator warns when all three insights are set.

## Basic versus Prompt

Default **`Basic`**: insights + attribute extract compose the summary.

**`Prompt`** only when the customer mandates structure `Basic` cannot enforce. The prompt must
still require reason, outcome, and next best action in prose. Keep `predefinedInsights` populated.

## Multiple use cases

- One AVA, several use cases → one setting; entities = pruned union of tool-driven facts.
- Several AVAs → one setting per AVA; do not merge unrelated tool maps.
