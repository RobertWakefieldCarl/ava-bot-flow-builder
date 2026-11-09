# Automatic AXL summary generation

## Generator

`scripts/generate-summary-setting.js` reads:

| Input | Used for |
|-------|----------|
| `spec-artifact.md` §1 | `_meta.useCases`, setting name |
| §2 / §4 | `_meta.insightGuidance` (reason, outcome, next best action shaping) |
| §3 | `language`, `participantLabels.virtualAgent` |
| `design-artifact.json` `tools[]` + `types[]` | `customEntities` + `_meta.attributeExtract` |

Defaults for AXL showcases:

- `summaryType`: **Detailed**
- `format`: **GroupedBulletPoints**
- `settingType`: **Basic**
- Up to **10** custom entities (all decision-relevant tool outputs/inputs, no secrets)

## Orchestrator

`scripts/ava-custom-summary-axl.js`:

| Command | Steps |
|---------|--------|
| `plan-axl` | generate → validate → discover-telephony → create (dry) → plan-bind-bot-flow |
| `apply-axl` | same + `create --confirm-apply` → `bind-bot-flow --confirm-apply` → handoff HTML |

Telephony bindings are written to **`session/telephony-bindings.json`** (not only under `.flow-lifecycle/`).

## Pair with wrap-up

When `wrap-up-codes.json` exists, `plan-bind-bot-flow` includes wrap-up checklist from gc-wrapup-codes.
Run [ava-wrap-up-codes](../ava-wrap-up-codes/SKILL.md) before or after summary apply; pass the same
`--summary-setting-id` on wrap-up `apply-axl` if enabling both in one pass.
