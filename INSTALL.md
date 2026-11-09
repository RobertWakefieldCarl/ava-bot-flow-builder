# AVA bot flow builder — install

Four skills that together turn a published Genesys Cloud AVA into a running, reportable voice bot
flow. Install all four: the first one calls the other three and will not run without them.

| Skill | Version | Why it is here |
|---|---|---|
| `ava-bot-flow-builder` | 1.1.0 | The skill you want. Builds, publishes and verifies the bot flow. |
| `ava-custom-summary` | 2.0.0 | Produces the custom-prompt After Contact summary setting the flow binds. |
| `ava-wrap-up-codes` | 1.0.0 | Produces the 15-25 wrap-up codes the flow enables, and assigns them to queues. |
| `gc-wrapup-codes` | 1.0.0 | The shared engine: credentials, region resolution, HTTP client, wrap-up code API. |

The three dependencies are resolved by **path**, as siblings of each other. Keep the folder names
exactly as they are and keep all four in the same skills directory, or the first thing any of them
does is throw `gc-wrapup-codes engine not found at ...`.

## 1. Copy the skills

Put the four folders in your skills directory, so that `<skills>/ava-bot-flow-builder/SKILL.md`
exists.

- **Personal, all projects** — `%USERPROFILE%\.cursor\skills` on Windows, `~/.cursor/skills`
  on macOS and Linux.
- **One project only** — `<repo>/.cursor/skills`.

```powershell
$dest = "$env:USERPROFILE\.cursor\skills"
Copy-Item .\ava-bot-flow-builder,.\ava-custom-summary,.\ava-wrap-up-codes,.\gc-wrapup-codes $dest -Recurse
```

```bash
cp -R ava-bot-flow-builder ava-custom-summary ava-wrap-up-codes gc-wrapup-codes ~/.cursor/skills/
```

## 2. Requirements

- **Node.js 22 or later.** The scripts use the built-in `fetch`; nothing is installed, and there
  are no npm dependencies.
- **A Genesys Cloud OAuth client** using the client-credentials grant, reachable through an MCP
  entry named `ava-harness` in `~/.cursor/mcp.json` with `GENESYS_CLIENT_ID`,
  `GENESYS_CLIENT_SECRET` and `AVA_HABITAT`. Every script reads credentials from there; none of
  them take a secret on the command line.
- **Scopes:** `architect`, `routing`, `ai-studio`, `speech-and-text-analytics`. The role behind
  the client needs the matching permissions in the divisions the flow, queues and codes live in.
  `ava-bot-flow-builder/references/oauth-permissions.md` lists them per step, along with the 403
  signature each missing permission produces.

## 3. Verify

```powershell
node "$env:USERPROFILE\.cursor\skills\ava-bot-flow-builder\scripts\ava-bot-flow-builder.js" whoami
```

It prints the org name, id and region it authenticated against. **Read it before going further** —
these scripts publish flows and create org-wide objects, and the org you are pointed at is not
always the one you assumed.

Optionally, run the engine's own tests:

```powershell
node "$env:USERPROFILE\.cursor\skills\gc-wrapup-codes\tests\run-tests.js"
```

## 4. Optional extras, not included

- **`gc-callflow-test`** — only needed for `gc-wrapup-codes discover-telephony`, which inspects an
  existing inbound call flow. The bot flow build never calls it.
- **`ava-navigator`** — the last step of `ava-bot-flow-builder` offers to put the finished flow
  behind an intent-routed Navigator. That skill needs its own MCP server tools, so it is packaged
  separately; without it, the step is simply skipped.

## What the bundle will do to an org

Worth knowing before the first run, because some of it is not reversible:

- It **creates and publishes an Architect bot flow**, and adds it to the General speech and text
  analytics program.
- It **creates a flow outcome and two milestones** if they do not already exist. The Platform API
  has no delete for flow outcomes, so an outcome name is effectively permanent — agree it first.
- It **creates wrap-up codes and a summary setting**, and asks before assigning codes to queues.
- It **never** attaches a phone number, edits an inbound call flow, or deletes anything. The one
  exception is `probe-schema.js`, which deletes the disposable flows it just created.
