# Catalog generation from AXL spec

`generate-wrap-up-catalog.js` builds `wrap-up-codes.json` from:

1. **`spec-artifact.md`** — §1 scope sentence and bullets; §4 happy path and hand-off; §5 tools.
2. **`design-artifact.json`** — tool names, escalation events, knowledge tools.
3. **Fixed operational tail** — auth, escalation, KB, error, out-of-scope (see script).

## Use-case extraction heuristics

| Source | Parsed as |
|--------|-----------|
| §1 bullet list after "building" | Primary intents |
| §4 numbered happy path steps | Success / incomplete variants |
| §4 "Hands off to a person when" | Escalation codes |
| §5 tool table rows | Success codes tied to `mapsTo.tools` |
| Verification in spec §4 | Auth verified / failed / abandoned |

## Count control

- Script targets **18** codes by default (`--target 18`), clamped `--min 15` `--max 20`.
- If too few intents: add generic KB, callback, and operational codes.
- If too many: merge incomplete variants or drop duplicate KB lines.

## `_meta` block

```json
"_meta": {
  "session": "AXL-acme",
  "agent_id": "<uuid>",
  "codeCount": 18,
  "generatedBy": "ava-wrap-up-codes/generate-wrap-up-catalog.js",
  "sources": ["spec-artifact.md", "design-artifact.json"],
  "targetQueues": "support,sales (default pattern)"
}
```

Facilitator edits names/descriptions after generation; re-run HTML handoff without regenerating
if only copy changed.
