# gc-wrapup-codes

Personal Cursor skill for Genesys Cloud wrap-up code administration through the official
Platform API.

It covers:

- wrap-up code discovery, create, read, update, and delete;
- division placement and division moves;
- assigning and unassigning codes on a single queue or a group of queues;
- a bounded usage scan that reports which queues reference a code before deletion;
- an allowlisted, OpenAPI-driven operation runner;
- dry-run plans, explicit write/delete/high-impact gates, retries, and read-back checks.

## Requirements

- Node.js 22 or newer.
- A Cursor AVA harness MCP entry containing `AVA_HABITAT` and Genesys OAuth Client
  Credentials. The resolver is shared with `gc-user-management`.
- `routing` scope plus `routing:wrapupCode:*` and `routing:queue:edit` permissions for
  writes. `outbound:readonly` is optional and only improves the usage scan.

The skill reads MCP configuration only when an operational command runs. The OpenAPI refresh,
help, validation, and offline tests do not read it.

## Quick check

```powershell
node scripts/gc-wrapup-codes.js help
node scripts/gc-wrapup-codes.js spec-info
node tests/run-tests.js
```

## Two things that bite

1. A wrap-up code has no `version` field, so `PUT` replaces the entire record and omitted
   properties are erased. `update-code` merges onto a fresh read for this reason.
2. Assigning to a group of queues is a client-side fan-out with no transaction, and
   attaching a code is authorized as `routing:queue:edit` rather than a wrap-up code
   permission.

See `SKILL.md` for the agent workflow, `references/API_REFERENCE.md` for endpoint details,
and `references/SAFETY.md` for the confirmation contract.
