# Wrap-up code design (15–20 codes)

Design codes for **agents who receive escalations or wrap up after the AVA**, not for the AVA
itself. Names must be scannable in a queue dropdown (short, distinct, sort-friendly).

## Count rule

| Count | Action |
|---|---|
| &lt; 15 | Add codes until coverage is complete or document exception in `_meta.exception` |
| 15–20 | Target band for AXL |
| &gt; 20 | Split by queue or get facilitator approval to trim |

## Coverage matrix

Every code maps to at least one row. Aim for **2–4 codes per row** where the AVA has real paths.

| Dimension | Example code themes |
|---|---|
| **Authentication** | Verified, verification failed, OTP sent, abandoned before verify |
| **Primary use case success** | One code per spec §1 intent fulfilled |
| **Primary use case incomplete** | Same intent but not finished |
| **Refusal / policy** | Transfer refused unverified, limit escalated |
| **Knowledge / policy** | General policy answered via KB |
| **Escalation** | Warm transfer, specialist queue |
| **Customer exit** | Resolved, callback scheduled |
| **Operational** | Wrong number, out of scope, system error |

## Naming

- Pattern: `<Topic> - <Outcome>` — consistent within the session.
- Descriptions: one sentence, **past tense**, what happened on the interaction.

## `mapsTo` (facilitator trace)

Optional on each code in `wrap-up-codes.json`; safe for batch create (stripped at API boundary).

```json
{
  "name": "Balance - Provided",
  "description": "Customer verified; balance disclosed.",
  "mapsTo": { "useCase": "Balance inquiry", "avaOutcome": "goal met" }
}
```
