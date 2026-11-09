---
name: gc-wrapup-codes
description: >
  Low-level Genesys Cloud wrap-up code Platform API engine (CRUD, queue assign, telephony
  discover). For AXL sessions that need 15–20 codes from use cases plus support/sales queue
  assignment and bot After Contact, use ava-wrap-up-codes instead. Use this skill for
  one-off audits, renames, deletes, or custom queue operations.
compatibility: Requires Node.js 22 or newer and an AVA harness entry in Cursor MCP configuration with Genesys Cloud OAuth Client Credentials and AVA_HABITAT.
---

# Genesys Cloud Wrap-up Codes (engine)

> **AXL default:** [ava-wrap-up-codes](../ava-wrap-up-codes/SKILL.md) orchestrates catalog
> generation, support/sales queue assignment, and bot-flow After Contact. This folder remains
> the **Platform API engine** (`scripts/gc-wrapup-codes.js`).

Use the official Genesys Cloud Platform API only. Resolve the target org and OAuth
credentials at runtime from the AVA harness entry in `~/.cursor/mcp.json`. Never display,
copy, or persist credentials or access tokens.

Resolve `<SkillDir>` as the directory containing this file. Run commands from the user's
active workspace.

## Required reading

Before a mutation, read:

- [API_REFERENCE.md](references/API_REFERENCE.md)
- [SAFETY.md](references/SAFETY.md)

The bundled OpenAPI files are:

- `references/openapi/purecloud-platform-api-v2.json` — pinned official full definition
- `references/openapi/wrapup-codes.openapi.json` — allowlisted wrap-up-code subset
- `references/openapi/metadata.json` — source, timestamp, hashes, and operation count

The upstream definition is not covered by an MIT license. See [NOTICE.md](NOTICE.md).

## Operating rules

1. Identify one exact wrap-up code or queue by immutable ID before changing anything. A name
   listing is discovery evidence, not mutation authorization.
2. Default to read-only or dry-run. A write requires the user's explicit request and the
   matching confirmation flag.
3. Read the current entity immediately before an update.
4. A wrap-up code has **no `version` field**. `PUT /routing/wrapupcodes/{codeId}` replaces the
   whole record, so any property the request omits is erased. Always merge onto the current
   record; never hand-build a bare `{ "name": ... }` update.
5. Treat a division change as an access-control change, not a rename.
6. Prefer unassigning a code from queues over deleting it. Deletion cannot be undone through
   this API and it degrades historical reporting.
7. Before deleting, run the usage scan and report which queues reference the code.
8. Queue assignment is a fan-out of independent writes with no transaction. Never claim the
   whole group succeeded without a per-queue read-back.
9. `sync-queue-codes` is declarative and removes codes that are not in the requested set.
   Use `assign` when the intent is purely additive.
10. Never enumerate every wrap-up code or queue in the org into chat. Filter by name, cap
    pages, and show only the fields needed to disambiguate.
11. Honor `Retry-After` on 429 responses. Do not blindly retry validation, permission, or
    conflict errors.
12. Never use the current user's real MCP configuration in offline tests.

## Data model

A wrap-up code is an org-level entity that belongs to exactly one division. Queues reference
codes through a separate many-to-many association:

- code definitions live at `/api/v2/routing/wrapupcodes`;
- the codes offered to an agent on a given queue live at
  `/api/v2/routing/queues/{queueId}/wrapupcodes`.

Assigning a code to a queue does not copy it. Removing a code from a queue does not delete
the code. Deleting the code removes it from every queue at once.

## CLI

Run:

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" help
```

All output is JSON. Read commands execute immediately. Write commands print a plan and do
nothing unless the appropriate confirmation flags are present.

### Discover

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" list-codes --name "<fragment>"
node "<SkillDir>/scripts/gc-wrapup-codes.js" get-code --code-id "<uuid>"
node "<SkillDir>/scripts/gc-wrapup-codes.js" list-queues --name "<fragment>"
node "<SkillDir>/scripts/gc-wrapup-codes.js" list-queue-codes --queue-id "<uuid>"
```

`list-codes --include-state ActiveAndDeleted` switches to the division view, which is the
only operation that can surface deleted codes.

`resolve-codes --names "A,B"` and `resolve-queues --names "Support,Billing"` map names to
IDs. They fail when a name is missing or matches more than one entity, and they report the
candidates so the user can choose.

### Audit before deleting

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" code-usage --code-id "<uuid>"
```

There is no reverse index from a code to its queues, so this scans queues and reads each
queue's assignments. The result reports `queuesScanned`, `scanTruncated`, and the outbound
campaign mapping. Architect flows, agent scripts, and saved reports can also reference a
code and are **not** discoverable through this API. Say so when advising on a deletion.

### Create a wrap-up code

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" create-code --name "Resolved" `
  --description "Customer issue resolved on first contact" --division-id "<uuid>"
```

Add `--confirm-apply` to execute. Omitting `--division-id` places the code in the org's home
division. A request body file works too: `create-code --body "create-wrapup-code.json"`.

### Update a wrap-up code

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" update-code --code-id "<uuid>" --description "New text"
```

The helper reads the current code and merges the requested change onto it, so unrelated
properties survive the replacement. The plan shows a `diff` with the exact changed fields.
Every update is high impact because the underlying operation is an unconditional full
replacement:

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" update-code --code-id "<uuid>" `
  --description "New text" --confirm-apply --confirm-high-impact
```

Use `--clear-description` to remove a description deliberately. Use `--body <file> --replace`
only when the user explicitly wants a literal, non-merged replacement.

### Delete a wrap-up code

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" delete-code --code-id "<uuid>" `
  --confirm-apply --confirm-delete --confirm-high-impact
```

All three flags are required. The plan includes the usage scan unless
`--skip-usage-scan` is passed.

### Assign to a queue or a group of queues

`assign` is additive and idempotent; codes already present on a queue are skipped.

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" assign `
  --queue-ids "<queue-uuid>,<queue-uuid>" --code-ids "<code-uuid>,<code-uuid>"
```

`unassign` detaches codes from the listed queues and leaves the codes themselves intact:

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" unassign `
  --queue-ids "<queue-uuid>" --code-ids "<code-uuid>" --confirm-apply --confirm-delete
```

`sync-queue-codes` makes each listed queue match the requested set exactly and therefore
removes anything else:

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" sync-queue-codes `
  --queue-ids "<queue-uuid>" --code-ids "<code-uuid>,<code-uuid>" `
  --confirm-apply --confirm-delete --confirm-high-impact
```

All three accept `--queue-names` and `--code-names` instead of IDs. A name must resolve to
exactly one entity or the command refuses to run.

A fan-out over more than 5 queues also requires `--confirm-high-impact`. More than 50
queues or 200 planned writes is refused outright. Because there is no transaction across
queues, a failure stops the run and reports `applied` and `notAttempted` so the operation can
be resumed deliberately.

### AVA telephony — bot flow After Contact (Track 1)

Use these when an AXL or AVA phone showcase needs org wrap-up codes **and** After Contact
enablement on the **Architect bot flow** (not the same as queue assignment).

**Discover** inbound DID flow, bot flow candidates, and optional escalation-queue Copilot:

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" discover-telephony `
  --flow-name "<Inbound Architect flow>" --out-dir "<session>/.flow-lifecycle"
```

Or pass `--inbound-flow-id <uuid>`. When multiple bot flows appear, pass `--bot-flow-id` or
`--bot-flow-name`. Writes `telephony-bindings.json` under the lifecycle folder.

**Batch-create** codes from a post-review artifact (`wrap-up-codes.json` with `codes[]` and
descriptions):

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" create-codes-batch `
  --file "<session>/wrap-up-codes.json" --confirm-apply
```

**Plan** After Contact wrap-up toggles vs exported bot YAML (manual checklist when schema is unclear):

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" plan-bot-wrapup `
  --file "<session>/wrap-up-codes.json" `
  --bindings "<session>/telephony-bindings.json" --out "<session>"
```

**Fragment** for summary + wrap-up master toggles (merge manually; validate before publish):

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" apply-bot-after-contact-fragment `
  --bindings "<session>/telephony-bindings.json" `
  --summary-setting-id "<uuid>" --confirm-apply
```

Escalation **queue** assignment for human ACW remains `assign --queue-names ...`.

### Session HTML handoff

Telephony and batch commands write **`wrap-up-codes-handoff.html`** at the **session folder root**
(when the session path is inferrable from `--session-dir`, `--file`, `--bindings`, or `--out`).

The page includes: AVA / Sage agent id, inbound and bot flow (and queue when known), the full
wrap-up code list with descriptions, and a note on what changed.

Regenerate explicitly:

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" write-session-html `
  --session-dir "<session>" --file "<session>/wrap-up-codes.json" `
  --bindings "<session>/telephony-bindings.json" --sage-agent-id "<uuid>" `
  --change-note "Assigned codes to escalation queue Support."
```

Pass `--session-dir` on `assign` when updating the handoff after queue changes.

### Generic allowlisted operation

```powershell
node "<SkillDir>/scripts/gc-wrapup-codes.js" invoke `
  --operation-id "<operationId>" `
  --path-params "path.json" --query "query.json" --body "request.json"
```

Only operations in the bundled subset can execute. Deprecated operations are excluded.
Unknown path and query parameters and bodies that violate the OpenAPI request model are
rejected before a network call. Use `spec-info` to list the allowlist.

## OpenAPI maintenance

Refresh only when the user explicitly asks to update the bundled definition:

```powershell
node "<SkillDir>/scripts/refresh-openapi.js" --confirm-refresh
```

The refresh utility downloads the official definition, validates identity and required
operations, generates the allowlisted subset, and atomically replaces the three OpenAPI
artifacts. It does not authenticate or read MCP configuration.

## Completion report

After a read, report the target region, operation, result count, and any pagination limit.
After a mutation, report:

- exact operation and immutable target ID;
- before/after values or the per-queue add/remove ledger;
- verification result from a follow-up GET;
- sanitized Genesys correlation/context ID on failure;
- for a partial fan-out, which queues changed and which were not attempted.

Never paste access tokens, credentials, or unbounded org inventories into chat.
