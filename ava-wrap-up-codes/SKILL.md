---
name: ava-wrap-up-codes
description: >
  AXL-focused wrap-up workflow: auto-generate 15–20 org wrap-up codes from spec and AVA
  use cases, assign them to support/sales queues (or facilitator-selected queues), enable
  After Contact on the Architect bot flow, and produce wrap-up-codes-handoff.html. Use for
  AXL post-review, supervisor ACW, or when the user mentions wrap-up codes with an AVA session.
compatibility: Node.js 22+, AVA harness MCP (Genesys OAuth), gc-wrapup-codes engine scripts
metadata:
  version: 1.0.0
---

# AVA Wrap-Up Codes (AXL)

End-to-end **15–20 wrap-up codes** for an AXL showcase: **generate** from use cases,
**create** in Genesys Cloud, **assign** to human queues, **enable on the bot flow** for
After Contact, and ship facilitator HTML.

Low-level Platform API CRUD remains in [gc-wrapup-codes](../gc-wrapup-codes/SKILL.md) (engine).
This skill **orchestrates** AXL defaults; call the engine directly only for one-off audits.

Resolve `<SkillDir>` as the directory containing this file. Run from the project root where
`axl-sessions/` and `.ava-lifecycle/` live.

## Required reading

| Phase | Reference |
|-------|-----------|
| Code design (15–20) | [references/wrap-up-code-design.md](references/wrap-up-code-design.md) |
| Catalog generation | [references/catalog-from-spec.md](references/catalog-from-spec.md) |
| Queue targeting | [references/queue-selection.md](references/queue-selection.md) |
| Bot flow / After Contact | [axl-post-review flow-binding](../axl-post-review/references/flow-binding-investigation.md) |
| Engine CLI | [gc-wrapup-codes SKILL](../gc-wrapup-codes/SKILL.md) |

## Outputs

| Artifact | Location |
|----------|----------|
| Wrap-up catalog | `axl-sessions/AXL-<customer>/wrap-up-codes.json` |
| Telephony bindings | `axl-sessions/AXL-<customer>/telephony-bindings.json` or `session/.flow-lifecycle/` |
| Bot plan + patch | `plan-bot-wrapup.md`, `after-contact.patch.yaml` (session folder) |
| Facilitator HTML | `axl-sessions/AXL-<customer>/wrap-up-codes-handoff.html` |

## Operating rules

1. **Org confirm first** — run `whoami` (see CLI) and state org name/id before mutations.
2. **15–20 codes** — auto-generate then trim/merge with facilitator; fewer than 15 needs
   `_meta.exception` documented.
3. **Queue assignment** — default: all routing queues whose names match **support** or **sales**
   (case-insensitive substring). Override with `--queue-names` or `--queue-ids`.
4. **Bot flow** — always run telephony discover for the AXL inbound flow; apply After Contact
   fragment after codes exist (pairs with [ava-custom-summary](../ava-custom-summary/SKILL.md)
   when a summary setting id is known).
5. **Plan before write** — every Genesys mutation dry-runs first; apply only with
   `--confirm-apply` (and engine high-impact flags when required).
6. **Never delete** org wrap-up codes from this skill. Prefer new distinct names on collision.
7. **CX Activate** — same org confirmation as axl-lab-facilitator before apply.

## Workflow

```
- [ ] 0. Preflight — session folder, spec, AVA slug, org
- [ ] 1. Generate wrap-up-codes.json (15–20) from AXL use cases
- [ ] 2. Facilitator review table (name + description)
- [ ] 3. Discover target queues (support/sales or designated)
- [ ] 4. Discover telephony (inbound + bot flow)
- [ ] 5. Create org codes (batch)
- [ ] 6. Assign codes to all target queues
- [ ] 7. Plan + apply bot After Contact (wrap-up + optional summary)
- [ ] 8. HTML handoff + completion readout
```

### Step 0 — Preflight

1. Resolve `axl-sessions/AXL-<customer>/` and `spec-artifact.md`.
2. Resolve `.ava-lifecycle/<slug>/` (`sage-agent.json`, `design-artifact.json`).
3. Record inbound flow name/id from `telephony-bindings.json`, session config, or facilitator.

### Step 1 — Generate catalog

```powershell
node "<SkillDir>/scripts/generate-wrap-up-catalog.js" `
  --session-dir "axl-sessions/AXL-<customer>" `
  --lifecycle-dir ".ava-lifecycle/<slug>" `
  [--min 15] [--max 20]
```

Writes or updates `wrap-up-codes.json` with `_meta` (sources, `codeCount`, `mapsTo` per code).
See [catalog-from-spec.md](references/catalog-from-spec.md).

Present the full **name + description** table before any Genesys write.

### Step 2 — Discover queues

```powershell
node "<SkillDir>/scripts/discover-target-queues.js" `
  [--queue-names "Support Tier 1,Sales"] `
  [--include-pattern "support,sales,service,customer care"]
```

Default pattern assigns **support** and **sales** queues. Saves
`wrap-up-target-queues.json` in the session folder when `--session-dir` is set.

### Step 3 — One-shot pipeline (plan or apply)

```powershell
node "<SkillDir>/scripts/ava-wrap-up-codes.js" plan-axl `
  --session-dir "axl-sessions/AXL-<customer>" `
  --lifecycle-dir ".ava-lifecycle/<slug>" `
  [--inbound-flow-id <uuid>] [--inbound-flow-name "<name>"] `
  [--queue-names "..."] [--summary-setting-id <uuid>]

node "<SkillDir>/scripts/ava-wrap-up-codes.js" apply-axl `
  ...same flags... --confirm-apply [--confirm-high-impact]
```

**plan-axl** runs: generate catalog (if missing) → discover queues → discover-telephony →
create-codes-batch (dry) → assign (dry) → plan-bot-wrapup.

**apply-axl** executes confirmed steps in order and regenerates handoff HTML.

Individual engine commands (same as gc-wrapup-codes):

```powershell
$engine = "$env:USERPROFILE\.cursor\skills\gc-wrapup-codes\scripts\gc-wrapup-codes.js"
node $engine create-codes-batch --file "<session>/wrap-up-codes.json"
node $engine assign --queue-names "..." --code-names "..." --session-dir "<session>"
node $engine discover-telephony --inbound-flow-id <uuid> --out-dir "<session>/.flow-lifecycle"
node $engine plan-bot-wrapup --file "<session>/wrap-up-codes.json" --bindings "<session>/telephony-bindings.json"
node $engine apply-bot-after-contact-fragment --bindings "<session>/telephony-bindings.json" --summary-setting-id <uuid>
```

### Step 4 — Pair with custom summary

When `summary-setting.json` exists, pass `--summary-setting-id` on apply so After Contact
enables **AI summary** alongside wrap-up. Use ava-custom-summary `plan-bind-bot-flow` if the
orchestrator did not already merge summary binding.

## Invocation examples

- `/ava-wrap-up-codes` — full plan for current AXL session
- `/ava-wrap-up-codes apply` — generate + create + assign + bot flow (with confirms)
- "Wrap-up codes for AXL-acg, sales and support queues only"
- "Regenerate wrap-up JSON from spec only, no Genesys writes"

## Guardrails

- Do not assign codes without listing target queue **names and ids** in the plan.
- Do not publish bot YAML without facilitator review of `after-contact.patch.yaml`.
- Do not strip `mapsTo` from the session JSON — the engine ignores unknown fields on create.
- Never commit session HTML that embeds secrets.

## Completion message

```
AVA wrap-up codes complete — <customer>
  Catalog: <N> codes in wrap-up-codes.json
  Queues: <M> assigned (<names summary>)
  Bot flow: <name> After Contact plan/applied <Y/N>
  HTML: wrap-up-codes-handoff.html
  Engine: gc-wrapup-codes (org mutations)
```
