# ava-wrap-up-codes

AXL orchestration for **15–20 wrap-up codes**: generate from `spec-artifact.md`, create in
Genesys Cloud, assign to **support/sales** queues (or named queues), enable **After Contact**
on the Architect bot flow.

Install: copy to `%USERPROFILE%\.cursor\skills\ava-wrap-up-codes`. Requires sibling
`gc-wrapup-codes` skill (engine). Not replaced by `ava-mcp skills sync`.

```powershell
node scripts/ava-wrap-up-codes.js plan-axl `
  --session-dir "axl-sessions/AXL-<customer>" `
  --lifecycle-dir ".ava-lifecycle/<slug>"

node scripts/ava-wrap-up-codes.js apply-axl ... --confirm-apply [--confirm-high-impact]
```

Version 1.0.0
