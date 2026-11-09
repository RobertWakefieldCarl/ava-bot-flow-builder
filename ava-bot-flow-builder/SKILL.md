---
name: ava-bot-flow-builder
description: >
  Build, publish and wire the Genesys Cloud Architect bot flow that fronts a published AVA:
  no starting audio, the AVA as the starting action, processing prompt off, escalation to
  Transfer to ACD driven by the AVA's exit reason and escalation queue, a flow outcome and
  milestones either side of the AVA, After Contact custom summary and 15-25 wrap-up codes,
  and the flow added to the General speech and text analytics program, then an offer to front
  the finished flow with a Navigator. Use when an AVA is published and needs a bot flow, or when
  an existing bot flow for an AVA needs rebuilding.
compatibility: >-
  Node.js 22+, an AVA harness MCP entry with Genesys Cloud OAuth client credentials and
  AVA_HABITAT, and the gc-wrapup-codes, ava-wrap-up-codes and ava-custom-summary skills installed
  alongside this one. ava-navigator is optional and only needed for the final step.
metadata:
  version: 1.1.0
---

# AVA bot flow builder

Turns a published AVA into a running voice entry point: one bot flow whose first and only
caller-facing action is the assistant, with escalation, reporting, After Contact and analytics
wired around it.

Resolve `<SkillDir>` as the directory containing this file. Run commands from the project root
holding the session folder. Every org mutation is gated behind `--confirm-apply`.

## Required reading

| Phase | Reference |
|---|---|
| What the AVA must return, and the end-context limitation | [references/ava-end-context.md](references/ava-end-context.md) |
| The plan artifact every command reads | [references/plan-artifact.md](references/plan-artifact.md) |
| The flow document, confirmed vs probe-dependent YAML | [references/bot-flow-yaml.md](references/bot-flow-yaml.md) |
| Summary setting and wrap-up codes, via their own skills | [references/summary-and-wrapup.md](references/summary-and-wrapup.md) |
| Outcome, milestones, General program | [references/analytics-and-reporting.md](references/analytics-and-reporting.md) |
| OAuth client, scopes, role, entitlements | [references/oauth-permissions.md](references/oauth-permissions.md) |

## What gets built

```
Inbound call flow (not touched by this skill)
  └─ Bot flow  <- this skill
       Initialize Flow Outcome
       Add Flow Milestone - assistant started
       Call Agentic Virtual Agent   <- first thing the caller hears, no greeting, no processing prompt
       Add Flow Milestone - assistant completed
       Decision on exit reason / escalation queue
          -> Set Flow Outcome + Transfer to ACD + Exit Bot Flow
       After Contact: custom summary + 15-25 wrap-up codes
  └─ General speech and text analytics program mapping
```

## Operating rules

1. **Confirm the org before anything.** `whoami` prints org name, id and region; state them back.
2. **Flow name is the author's call.** Ask for it, or offer what `discover` found. An exact match
   updates and republishes that flow; no match creates a new one. Never guess a name that already
   exists in the org.
3. **Prerequisites exist first.** Wrap-up codes and the summary setting must be in the org before
   the flow is imported, because the flow references them by name and id.
4. **Ask before assigning wrap-up codes to queues** — all routing queues, or a list the author
   names. Do not default to every queue in a shared org.
5. **Plan before apply.** `plan` validates every queue, code and setting against the live org and
   writes the YAML for review. Nothing is written until `apply --confirm-apply`.
6. **Verify by re-export.** After publishing, the flow is exported again and checked construct by
   construct. Report what Architect actually kept, never what was sent.
7. **Never claim a manual step was automated.** Anything the verify step could not confirm is
   reported as an Architect UI step, in the handoff and in the readout.
8. **Never print credentials**, and never put customer data in the plan.

## Workflow

```
- [ ] 0. Preflight     org, session folder, published AVA, its start/end context
- [ ] 1. Discover      flows, queues, codes, summary settings, outcomes, STA programs
- [ ] 2. Summary       ava-custom-summary -> custom-prompt summary-setting.json with an id
- [ ] 3. Wrap-up       ava-wrap-up-codes -> 15-25 codes created and assigned to agreed queues
- [ ] 4. Plan          author bot-flow-plan.json, validate it, review bot-flow.yaml
- [ ] 5. Apply         outcome + milestones, import and publish, General program, verify
- [ ] 6. Readout       handoff HTML, manual steps, permissions note
- [ ] 7. Navigator     ask whether to front the flow with a Navigator; hand off if yes
```

### Step 0 — Preflight

```powershell
node "<SkillDir>/scripts/ava-bot-flow-builder.js" whoami
```

Then collect the AVA facts through the **harness MCP tools**, not these scripts: `get_ava` and
`get_latest_published_version` for the assistant and the version the flow will bind, and the
version's start and end context names. A published version is mandatory — the flow binds
`ver_latestPublished`. See [references/ava-end-context.md](references/ava-end-context.md), which
also covers the question that has to be asked out loud: **where does the escalation queue value
come from?** End context is only filled from start context or mapped tool outputs, so either a tool
produces it or the flow routes everything to one default queue.

### Step 1 — Discover

```powershell
node "<SkillDir>/scripts/ava-bot-flow-builder.js" discover `
  --session-dir "<session>" --ava-name "<AVA name>" [--deep]
```

Writes `bot-flow-discovery.json`: BOT flows, queues, wrap-up codes, summary settings, existing flow
outcomes and milestones, and the org's speech and text analytics programs. `--deep` additionally
exports each bot flow to find the ones already calling this AVA — slower, but it is how you answer
"is there already a flow for this assistant?" before creating a duplicate.

Put the flow name question to the author now: a new name, or one of the discovered flows.

### Step 2 — Custom summary

Run [ava-custom-summary](../ava-custom-summary/SKILL.md) to produce a **custom-prompt** setting
(`settingType: "Prompt"`) whose prompt covers reason, outcome and follow-up, the facts the AVA's
tools return, and the escalation or exit reason. A `Basic` setting only picks a length and a
layout and produces a summary that could have come from any bot. Commands and the review checklist
are in [references/summary-and-wrapup.md](references/summary-and-wrapup.md). Carry the created
`id` and `name` into the plan — the flow binds the setting by **name**, so it must be unique.

### Step 3 — Wrap-up codes

Run [ava-wrap-up-codes](../ava-wrap-up-codes/SKILL.md) for 15-25 codes generated from the AVA's use
cases, created in the org and assigned to the queues the author chose. Carry the code **names**
into the plan. Codes without descriptions are flagged later; fix them in that skill, not here.

### Step 4 — Plan

Author `<session>/bot-flow-plan.json` from
[references/plan-artifact.md](references/plan-artifact.md), then:

```powershell
node "<SkillDir>/scripts/ava-bot-flow-builder.js" plan --session-dir "<session>"
```

It checks every escalation queue, every wrap-up code, the summary setting and the flow name against
the live org, reports `create-new-flow` or `update-existing-flow`, and writes `bot-flow.yaml`.
Review the YAML with the author before applying — it is the whole flow, and it is readable.

Every construct the emitter writes has been verified against a live org, so a schema probe is a
regression check rather than a required step. Run it when a build fails for a reason the job
messages do not explain, or on an org whose Architect version is in doubt:

```powershell
node "<SkillDir>/scripts/probe-schema.js" `
  --ava-name "<AVA name>" --queue-name "<existing queue>" [--output-name "<AVA end context name>"] `
  --session-dir "<session>" --confirm-apply
```

It imports each construct as a disposable flow, deletes it again, and recommends a profile. It
leaves one flow outcome behind, because the Platform API cannot delete outcomes. See
[references/bot-flow-yaml.md](references/bot-flow-yaml.md).

### Step 5 — Apply

```powershell
node "<SkillDir>/scripts/ava-bot-flow-builder.js" apply `
  --session-dir "<session>" --confirm-apply [--degrade-on-reject]
```

In order: create the flow outcome and both milestones if missing, import the YAML through the
Architect job (which saves **and publishes**), add the flow to the General program and publish the
program, re-export the published flow and verify each construct, write `bot-flow-handoff.html`.

With `--degrade-on-reject`, a rejected document is retried once without the probe-dependent
constructs so the flow still ships, and every dropped item becomes a reported manual step.

### Step 6 — Readout

Re-check at any time:

```powershell
node "<SkillDir>/scripts/ava-bot-flow-builder.js" verify --session-dir "<session>"
```

Give the author the handoff path, the flow id and published version, the outcome and milestone
ids, the General program state, and every unverified item as a named Architect step. Finish with
the permissions note from [references/oauth-permissions.md](references/oauth-permissions.md) when
anything returned 403.

### Step 7 — Navigator (ask, do not assume)

A published bot flow can take calls, but only through a number pointed straight at it. Once the
readout is given, ask the author whether this assistant should sit behind a **Navigator** — one
intent-routed entry point that can front several assistants — or stand alone.

If they say yes, run [ava-navigator](../ava-navigator/SKILL.md) and give it this flow as an asset
hint of kind `botflow`:

```json
{"kind": "botflow", "name": "<exact bot flow name>"}
```

That skill owns the rest: it verifies the flow, proposes intents, and routes the one that matches
this assistant to it. Three things it needs from this build, so state them when handing over:

- **The exact flow name**, since Navigator resolves assets by name and fails on a mismatch.
- **Published, `BOT` type.** Both are true after `apply`; a flow that only saved is rejected.
- **What the assistant actually does**, in a sentence — it becomes the intent description, and a
  vague one makes the classifier route badly.

Navigator builds its own inbound call flow, so the number is attached there, not to this flow.
Say so, because it changes where the author goes next in Admin.

If they say no, the flow stands alone and attaching a number to it is the author's next step. This
skill never attaches one either way.

## Guardrails

- Never delete a flow, outcome, milestone, wrap-up code or summary setting. `probe-schema.js` is
  the single exception and only removes the disposable objects it just created.
- Treat a flow outcome name as permanent: the Platform API has no delete for outcomes. Confirm the
  name with the author before `apply` creates it.
- Never edit the customer's inbound call flow; attaching a number or routing traffic to this bot
  flow is a separate, manual, owner-assigned step.
- Never write the STA program mappings without merging the current lists first.
- Never report After Contact summary as bound to a specific setting unless `summarySettingBound`
  came back true from the re-exported YAML. The toggle on its own means the org default.
- Never enable wrap-up codes in the flow that do not exist in the org — Architect drops unknown
  names silently and the flow looks configured when it is not. The same is true of any key it does
  not recognise, which is why a clean publish is not evidence that anything was applied.

## Completion message

```
AVA bot flow complete — <bot flow name>
  Org: <org name> (<id>, <region>)
  Flow: <flow id> published version <v> — <created|updated>
  AVA: <AVA name> ver_latestPublished, exit reason -> <variable>
  Escalation: <N> routed queues, default <queue>
  Outcome: <name> (<created|reused>) with milestones <before> / <after>
  After Contact: summary <setting name|org default>, <N> wrap-up codes
  Analytics: General program <added|already mapped>, publish <state>
  Verified: <N>/<M> constructs present in the published YAML
  Manual steps: <list or none>
  HTML: bot-flow-handoff.html
  Next: Navigator in front of this flow, or a number attached to it directly?
```
