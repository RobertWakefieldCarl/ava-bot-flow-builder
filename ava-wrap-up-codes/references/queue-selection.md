# Queue selection

## Default (AXL)

`discover-target-queues.js` includes a routing queue when **any** of:

- Name matches `(?i)support`
- Name matches `(?i)sales`

Optional broadening via `--include-pattern "service,customer care,member"` (comma-separated
substrings, case-insensitive).

## Facilitator override

| Flag | Behavior |
|------|----------|
| `--queue-names "A,B"` | Exact name resolution only (engine `resolve-queues`) |
| `--queue-ids "uuid,..."` | Explicit list; skips pattern scan |
| `--exclude-pattern "test,sandbox"` | Drop matches after scan |

## Assignment mode

- **`assign`** (default) — additive; existing queue codes remain.
- **`sync-queue-codes`** — only when facilitator explicitly wants the queue limited to this
  catalog (destructive removals — requires `--confirm-delete` on engine).

## Escalation queue from telephony

`discover-telephony` may record `escalationQueueId` in `telephony-bindings.json`. The AXL
default still assigns **all** support/sales queues unless `--queues escalation-only` is passed
to `plan-axl` / `apply-axl`.
