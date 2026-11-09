# AVA bot flow builder

Four Cursor Agent Skills that turn a published Genesys Cloud **Agentic Virtual Agent** into a
running, reportable voice entry point: one Architect bot flow whose first and only caller-facing
action is the assistant, with escalation, reporting, After Contact and analytics wired around it.

```
Inbound call  ->  Bot flow
                    Initialize Flow Outcome
                    Milestone: assistant started
                    Call Agentic Virtual Agent     <- no greeting, no processing prompt
                    Milestone: assistant finished
                    Escalation queue -> Transfer to ACD
                    Contained        -> Exit
                    Error/guardrail  -> Transfer to ACD (default queue)
                  After Contact: custom-prompt summary + 15-25 wrap-up codes
                  General speech and text analytics program
```

## What is in here

| Skill | Role |
|---|---|
| [`ava-bot-flow-builder`](ava-bot-flow-builder/SKILL.md) | Builds, publishes and verifies the bot flow. The one you invoke. |
| [`ava-custom-summary`](ava-custom-summary/SKILL.md) | Custom-prompt After Contact summary setting, derived from the AVA's spec and tools. |
| [`ava-wrap-up-codes`](ava-wrap-up-codes/SKILL.md) | 15-25 wrap-up codes from the AVA's use cases, plus queue assignment. |
| [`gc-wrapup-codes`](gc-wrapup-codes/SKILL.md) | Shared engine: credentials, region resolution, HTTP client, wrap-up code API. |

They resolve each other **by relative path** as siblings, so keep the folder names and keep all
four together. Installation, requirements and OAuth scopes are in [INSTALL.md](INSTALL.md).

## Why it verifies everything twice

Architect silently discards YAML keys it does not recognise. A flow document can import cleanly,
publish cleanly, and leave half of what you asked for unapplied — the After Contact summary
setting being the costly example, since four plausible-looking key names all publish without
complaint and leave the flow on the org default.

So nothing here trusts a successful publish. `plan` validates every queue, code, outcome and
setting against the live org before anything is written, and `apply` re-exports the published flow
and checks thirteen constructs one by one. Anything it cannot confirm is reported as a named
manual Architect step rather than claimed as done.

## Quick start

```powershell
node ava-bot-flow-builder/scripts/ava-bot-flow-builder.js whoami
node ava-bot-flow-builder/scripts/ava-bot-flow-builder.js discover --session-dir <session> --ava-name "<AVA>"
# author bot-flow-plan.json, then:
node ava-bot-flow-builder/scripts/ava-bot-flow-builder.js plan  --session-dir <session>
node ava-bot-flow-builder/scripts/ava-bot-flow-builder.js apply --session-dir <session> --confirm-apply
```

Requires Node.js 22+ and a Genesys Cloud OAuth client-credentials client reachable through an
`ava-harness` MCP entry. No npm dependencies.

## What it changes in an org

- Creates and publishes an Architect bot flow, and maps it into the General speech and text
  analytics program.
- Creates a flow outcome and two milestones. **The Platform API has no delete for flow outcomes**,
  so the name is effectively permanent — agree it before the first run.
- Creates wrap-up codes and a summary setting, and asks before assigning codes to queues.
- Never attaches a phone number, never edits an inbound call flow, and never deletes anything. The
  sole exception is `probe-schema.js`, which removes the disposable flows it just created.
