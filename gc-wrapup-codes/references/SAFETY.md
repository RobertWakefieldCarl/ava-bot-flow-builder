# Wrap-up-code safety contract

Wrap-up codes look like harmless reference data, but they are wired into agent-facing
queues, Architect flows, outbound campaign dispositions, and every historical conversation
record. Apply these controls without exception.

## Confirmation levels

### Read

GET and listing operations execute without a confirmation flag. Listings must be filtered and
use bounded page sizes.

### Standard write

Creating a wrap-up code and additive queue assignment over 5 or fewer queues require
`--confirm-apply`. Without it, emit a dry-run plan.

### High impact

The following require `--confirm-apply --confirm-high-impact`:

- any wrap-up code update, because `PUT` is an unconditional full replacement;
- moving a code to another division;
- `sync-queue-codes`, which removes codes not present in the requested set;
- a fan-out across more than 5 queues.

### Destructive

The following require `--confirm-apply --confirm-delete`:

- unassigning a code from a queue;
- any `sync-queue-codes` run that removes at least one code.

Deleting the code definition requires all three flags:

```text
--confirm-apply --confirm-delete --confirm-high-impact
```

## Hard refusals

- More than 50 queues in one fan-out.
- More than 200 planned writes in one fan-out.
- A queue whose assignment list exceeds the page cap, because it cannot be diffed safely.
- A name that matches zero or several entities, for any mutating command.
- `--replace` without an explicit `--body`.
- Both `--description` and `--clear-description`.
- Both an ID list and a name list for the same target type.

## Read-before-write

1. Resolve the exact immutable ID. Names are for discovery only.
2. GET the current entity, and for a queue operation GET the queue's current assignments.
3. Show a minimal before/after plan or a per-queue add/remove ledger.
4. Merge onto the current record. Never send a partial wrap-up code body.
5. Apply only after the required confirmation.
6. GET again and verify the intended values.

Do not retry HTTP 409 automatically. Re-read and present the conflict.

## The missing version field

`WrapupCode` has no `version`, so the API cannot detect a lost update. Two consequences:

- Never build an update body from user text alone; always merge onto a fresh GET.
- Never describe an update as safe because it "only changes the name". The request replaces
  the record.

If a concurrent change is plausible, re-read immediately before applying and show the user
the exact body that will be sent.

## Deletion

- Prefer `unassign` over `delete-code`. Removing a code from a queue stops agents seeing it
  while preserving reporting.
- Run the usage scan before deleting, and present the queue references it found.
- State plainly that the scan cannot see Architect flows, agent scripts, saved reports, or
  external integrations, so its result is a lower bound on impact.
- The delete is a soft delete. The code is detached from every queue, vanishes from the
  active listing, and `getRoutingWrapupcode` returns 404, but the record survives and is
  still readable through `getRoutingWrapupcodesDivisionviews` with
  `includeState=Deleted`. Historical reporting can therefore still resolve the name.
- Do not describe a deleted code as permanently erased, and do not describe it as
  recoverable either: this API exposes no restore operation.

## Queue fan-out

- Diff each queue before writing so the plan reflects real changes, not requested ones.
- A fan-out has no transaction. Stop at the first failure.
- On failure, report `applied` and `notAttempted` explicitly. Never summarize a partial
  fan-out as a success or as a total failure.
- Verify each queue with a read-back before counting it as applied.
- `assign` must remain idempotent: a code already on the queue is a skip, not a write.

## Division changes

- A division move changes which users and queues can access the code. Treat it as an
  authorization change and show both division names, not just IDs.
- Never infer a division from a similar name.

## Data handling

- Do not log request or response bodies by default.
- Console output may show code and queue IDs, names, descriptions, and division names.
- Never print OAuth client IDs, secrets, Basic authorization values, or bearer tokens.
- Redact secret-like fields recursively and truncate server error payloads.
- Do not enumerate the full wrap-up code or queue inventory into chat.
- Do not save org inventories, request bodies, or operation plans inside the skill.

## Region and credentials

- Runtime commands read only the AVA harness MCP entry selected by the credential resolver.
- An explicit region must resolve to the same regional host as `AVA_HABITAT`.
- Reject unknown hosts and URLs containing credentials, paths, query strings, or fragments.
- Never fall back to another region after authentication or API failure.

## Failure handling

- 400: report field validation details; do not retry.
- 401: refresh the access token once, then stop.
- 403: report the missing scope or permission and stop. Distinguish
  `routing:wrapupCode:*` from `routing:queue:edit`, since queue assignment fails on the
  latter.
- 404: verify the target ID and region. A 404 on a code may mean it was deleted; confirm with
  the division view before concluding it never existed.
- 409: re-read and report the conflict; do not overwrite.
- 429: honor `Retry-After`. A fan-out is the most likely trigger.
- 5xx/network: bounded exponential retry for idempotent reads; do not automatically retry a
  non-idempotent write unless the response proves it was not accepted.

Always include the sanitized Genesys context/correlation ID when available.
