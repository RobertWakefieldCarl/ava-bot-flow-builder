# Genesys Cloud wrap-up-code API reference

This reference is derived from the official regional Swagger 2.0 definition at
`/api/v2/docs/swagger`. The pinned source URL and checksum are in `openapi/metadata.json`.
The bundled OpenAPI files, not this summary, are authoritative for request schemas.

## Official sources

- Platform API and OpenAPI location: https://developer.genesys.cloud/api/rest/
- Routing API: https://developer.genesys.cloud/routing/routing/
- Wrap-up codes overview: https://help.genesys.cloud/articles/add-wrap-up-codes/
- OAuth scopes: https://developer.genesys.cloud/authorization/platform-auth/scopes
- Fine-grained access control: https://developer.genesys.cloud/authorization/platform-auth/fgac
- Rate limits: https://developer.genesys.cloud/api/rest/rate_limits

## OAuth scopes and permissions

| Area | Read scope | Write scope |
| --- | --- | --- |
| wrap-up codes and queues | `routing:readonly` | `routing` |
| divisions | `authorization:readonly` | not used |
| outbound mapping check | `outbound:readonly` | not used |

Scope alone is not sufficient. The OAuth client must also hold role and division grants
containing each operation's Genesys permission:

- `routing:wrapupCode:view`, `routing:wrapupCode:add`, `routing:wrapupCode:edit`,
  `routing:wrapupCode:delete`, `routing:wrapupCode:search`
- `routing:queue:view`, `routing:queue:edit`, `routing:queue:search`
- `outbound:wrapUpCodeMapping:view` for the optional outbound dependency check

Note that attaching a code to a queue is authorized as a **queue** edit
(`routing:queue:edit`), not as a wrap-up code edit. A client can therefore be allowed to
create codes yet unable to assign them, or the reverse.

Read `security` and `x-inin-requires-permissions` on the exact operation in the subset before
execution.

## Wrap-up code definitions

| Operation | Method and path |
| --- | --- |
| `getRoutingWrapupcodes` | `GET /api/v2/routing/wrapupcodes` |
| `postRoutingWrapupcodes` | `POST /api/v2/routing/wrapupcodes` |
| `getRoutingWrapupcode` | `GET /api/v2/routing/wrapupcodes/{codeId}` |
| `putRoutingWrapupcode` | `PUT /api/v2/routing/wrapupcodes/{codeId}` |
| `deleteRoutingWrapupcode` | `DELETE /api/v2/routing/wrapupcodes/{codeId}` |
| `getRoutingWrapupcodesDivisionviews` | `GET /api/v2/routing/wrapupcodes/divisionviews` |
| `getRoutingWrapupcodesDivisionview` | `GET /api/v2/routing/wrapupcodes/divisionviews/{codeId}` |

The `WrapupCodeRequest` model requires `name` and accepts `description` and `division`:

```json
{
  "name": "Resolved",
  "description": "Customer issue resolved on first contact",
  "division": { "id": "<division-uuid>" }
}
```

`id`, `selfUri`, `dateCreated`, `dateModified`, `createdBy`, and `modifiedBy` are
server-managed. The CLI sends only `name`, `description`, and `division`.

### No optimistic concurrency

`WrapupCode` has **no `version` property**. `putRoutingWrapupcode` is an unconditional full
replacement:

- a request without `description` clears the existing description;
- a request without `division` can move the code out of its current division;
- a concurrent edit by another administrator is overwritten with no 409.

Always GET the code first and merge. This is why the CLI classifies every update as high
impact.

### Listing and deleted codes

`getRoutingWrapupcodes` supports `name`, `id`, `divisionId`, `pageSize`, `pageNumber`,
`sortBy`, and `sortOrder`. It returns only active codes.

`getRoutingWrapupcodesDivisionviews` adds `includeState` with `Active`, `Deleted`, or
`ActiveAndDeleted`, and requires `routing:wrapupCode:search`. It is the only way to see a
deleted code. The division view is a read-only projection; it cannot restore a code.

`deleteRoutingWrapupcode` performs a **soft delete**, confirmed against a live org: after
deletion the code is detached from every queue, is absent from `getRoutingWrapupcodes`, and
`getRoutingWrapupcode` returns 404, but the record is still returned by the division view
with `includeState=Deleted`. Historical reporting can therefore still resolve the name.
There is no restore operation, so treat the deletion as irreversible even though the record
persists.

A newly created code, and any code not explicitly placed in a division, can report its
division as the wildcard `"*"` rather than a real division ID. That value cannot be echoed
back on a write, so the update helper omits it instead of restating it.

`id` and `divisionId` are `collectionFormat: multi`, so each value is sent as a repeated
query parameter rather than a comma-joined string. The operation builder preserves arrays for
`multi` parameters and joins any csv-format parameter before transport.

## Queue association

| Operation | Method and path | Permission |
| --- | --- | --- |
| `getRoutingQueueWrapupcodes` | `GET /api/v2/routing/queues/{queueId}/wrapupcodes` | `routing:queue:view` |
| `postRoutingQueueWrapupcodes` | `POST /api/v2/routing/queues/{queueId}/wrapupcodes` | `routing:queue:edit` |
| `deleteRoutingQueueWrapupcode` | `DELETE /api/v2/routing/queues/{queueId}/wrapupcodes/{codeId}` | `routing:queue:edit` |

`postRoutingQueueWrapupcodes` takes an array of references and is **additive**:

```json
[{ "id": "<code-uuid>" }, { "id": "<code-uuid>" }]
```

Constraints that shape the CLI design:

- There is no bulk replace and no bulk unassign. Removal is one request per code per queue.
- There is no operation that assigns to several queues at once. A queue group is a
  client-side fan-out with no transaction.
- There is no reverse lookup from a code to the queues that use it. `code-usage` scans
  queues and reads each queue's assignments, which is why it is bounded and reports
  truncation.
- `WrapUpCodeReference` declares no required properties, so a body of `[{}]` passes schema
  validation. The CLI validates each entry is a UUID itself.

Re-posting a code that is already assigned is tolerated by the API, but the CLI still diffs
first so the plan reports honestly what will actually change.

## Divisions

`getAuthorizationDivisions`, `getAuthorizationDivision`, and `getAuthorizationDivisionsHome`
are included to resolve and display division names for create and move operations. Division
structure mutation is out of scope.

## Outbound dependency check

`getOutboundWrapupcodemappings` returns a `mapping` object keyed by wrap-up code ID with
campaign disposition flags such as `CONTACT_UNCALLABLE` and `BUSINESS_SUCCESS`. `code-usage`
reads it to warn that deleting a code will orphan its outbound mapping entry. The
corresponding `PUT` is excluded because it replaces the org-wide mapping in one call.

## Pagination and rate limits

- Listings use `pageNumber` and `pageSize`; the CLI clamps `pageSize` to 100.
- Diffing helpers page until `pageCount` with a 25-page cap and report `truncated`.
- Routing endpoints are limited to 300 requests per minute per org by default.

A queue fan-out multiplies request count quickly: `sync-queue-codes` over 20 queues issues at
least 20 reads, up to 20 additions, one delete per removed code, and 20 verification reads.
On HTTP 429, wait for `Retry-After`.

## Excluded operations

The generated subset intentionally excludes:

- deprecated operations;
- queue create, update, and delete;
- queue membership administration;
- `putOutboundWrapupcodemappings`;
- per-conversation wrap-up submission on participants and communications;
- task management workitem wrap-ups;
- division structure mutation.

Refresh the OpenAPI subset only after reviewing any proposed allowlist expansion.
