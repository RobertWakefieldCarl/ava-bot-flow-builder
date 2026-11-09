# Tool-driven attribute extract (AVA design artifact)

Custom entities are the **attribute extract**: structured facts the summary pulls from what the AVA
actually did — especially **tool inputs collected** and **tool outputs that changed the next step**.
Derive them from `.ava-lifecycle/<slug>/design-artifact.json` (or the published Sage definition)
whenever it exists; fall back to spec-artifact §5 only when design is not built yet.

## Inputs to walk

| Source in design artifact | What to extract |
|---|---|
| `tools[]` where `type` is `DataAction` | `name`, `output` type name, `inputs[]` (targetName, type, source) |
| `tools[]` where `type` is `KnowledgeBase` | Whether KB was used for **policy** vs **account facts** (from `inputInstructions`) — entity for *topic*, not article text |
| `types[]` | Properties on each tool `output` object type and on start-context `InputData` |
| Global `instructions` / `guardrails` | Verification gates (PIN, OTP) → entity for **verification method**, never the secret |

Ignore tool wiring-only types (datatable ids, API keys, fixed SMS from-address) unless a supervisor
cares about them.

## Per-tool mapping rules

1. **One entity per decision-relevant fact**, not per schema field. Prefer the field a supervisor
   acts on (balance band, claim status, appointment slot) over raw ids when both exist.
2. **Inputs the user supplied** (`source`: `External`, `User`, or start context) → entities when
   they identify the interaction (phone on file, account type requested, amount to transfer).
3. **Outputs** → entities when they are disclosed to the customer after verification (checking
   balance, eligibility result, case reference returned by the tool).
4. **Never extract secrets** — drop properties and inputs typed or described as PIN, OTP, SSN, CVV,
   full PAN, password. Record *that* verification succeeded and *which method* (PIN vs OTP), not
   values.
5. **Do not duplicate predefined insights** — if the only output is "transfer refused", that belongs
   in **Outcome** (`Resolution`), not a custom entity.
6. **Knowledge Base** — at most one entity such as "Policy topic" when the AVA used KB for general
   policy; do not entity-copy article bodies.

## Priority when over the soft cap (6 entities)

Keep, in order:

1. Verification outcome (method + pass/fail, no secrets)
2. Primary business outcome from tools (balance, status, eligibility)
3. Identifiers the supervisor needs to continue the case (claim #, order #) when masking allows
4. Handoff context (queue, specialist type, promised callback window)
5. Secondary facts (account type selected, amount requested)
6. Drop restating fields the three insights already cover

Hard platform limit: **10** entities; validator errors above that.

## Recording provenance in `_meta`

Always attach a trace list so the readout and the next edit session can see why each entity exists:

```json
"attributeExtract": [
  {
    "entityLabel": "Checking balance",
    "tool": "Get banking core information by phone number",
    "source": "output.CheckingAccountBalance",
    "notes": "After PIN/OTP verification; maskPII may redact if misconfigured."
  }
]
```

`entityLabel` must match a `customEntities[].label` exactly.

## Label and description limits

| Field | Limit |
|---|---|
| `label` | 30 characters |
| `description` | 120 characters |

Descriptions must say **what** to extract and **which tool or verification step** it comes from.
Write to the limit once; do not draft long prose and trim.

## Example (banking AVA)

Tools: core lookup, OTP send, transfer update, KB, random number (OTP generation).

| Entity label | Tool / gate | Notes |
|---|---|---|
| Verification method | PIN / OTP gates | "PIN verified" or "OTP verified", never codes |
| Account requested | User utterance + instruction | Checking vs savings vs loan |
| Checking balance | Core lookup output | After verification |
| Transfer requested | User + transfer tool input | Amount and direction if discussed |
| Transfer outcome | Transfer tool / agent statement | Completed vs refused vs pending |
| Policy topic | KB | Only if KB invoked for policy |

Random Number and SMS plumbing types → **no entities**.
