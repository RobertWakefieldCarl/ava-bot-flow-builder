# Custom summary and wrap-up codes

Both are produced by the existing skills. This skill does not reimplement either — it supplies the
AVA-derived content, consumes their artifacts, and is the thing that actually switches them on in
the bot flow's After Contact settings.

## Custom summary — ava-custom-summary

An AVA summary is a **custom-prompt** setting: `settingType: "Prompt"` with a `prompt` that names
this assistant's use cases, the facts its tools return, and the four ways the conversation can end.
`settingType: "Basic"` only picks a length and a layout, which produces a summary that could have
come from any bot. The generator writes the prompt by default; `--setting-type basic` opts out and
`plan` warns when the setting it finds in the org is not a prompt setting.

The prompt must cover, in order: reason for the call, outcome, follow-up, what the assistant found
from its tools, and how the call ended (contained, escalated with its reason and queue, guardrail
stop, or assistant error). It must also forbid carrying values over from an earlier lookup and
forbid repeating the identifiers the caller gave to be verified.

The rest of the setting still applies, since the prompt governs wording rather than plumbing:

| Part | Platform field | Content for an AVA POC |
|---|---|---|
| Summary | `summaryType` + `format` | `Detailed`, `GroupedBulletPoints` |
| Reason for call | `ReasonForCall` | The AVA's use cases / intents from the spec |
| Outcome of call | `Resolution` | Success paths, refusals, guardrail stops, and the escalation or exit reason |
| Follow-up | `ActionItems` | Callbacks, handoffs and anything the assistant promised |
| Attribute extract | `customEntities[]` | One entity per decision-relevant tool input/output across every tool the AVA uses (max 10) |

Run it from the session folder:

```powershell
$summary = "$env:USERPROFILE\.cursor\skills\ava-custom-summary\scripts"
node "$summary\generate-summary-setting.js" --session-dir "<session>" --lifecycle-dir ".ava-lifecycle/<slug>"
node "$summary\gc_summary_setting.js" validate --file "<session>/summary-setting.json"
node "$summary\gc_summary_setting.js" create   --file "<session>/summary-setting.json" --confirm-apply
```

Four things to check before accepting the generated file:

- **The prompt reads like this AVA.** It is generated from the spec's use cases and the design's
  tools, so a thin spec produces a thin prompt. Read it as the next agent would.
- **The name does not carry the customer's name.** Summary settings are org-wide and these orgs are
  usually shared. Name the setting after the assistant.
- **Escalation and exit reason are present in the Resolution guidance.** The generator derives
  Resolution from the spec; if the AVA escalates, the wording must say so, and the exit-reason tool
  output should appear as a custom entity.
- **Tool outputs are covered.** Every tool the AVA calls should contribute at least its
  decision-relevant output fields, up to the ten-entity ceiling. `_meta.attributeExtract` traces
  each entity back to its tool and field — read it rather than trusting the labels.

Copy the created `id` and `name` into `afterContact.summarySetting` in the bot flow plan. Do **not**
run that skill's `bind-bot-flow`: its After Contact fragment is a patch for a flow this skill is
building from scratch, and it reports the bind as a manual Architect step. This skill binds the
setting itself, by name, in the flow document.

## Wrap-up codes — ava-wrap-up-codes

15-25 codes derived from the AVA's use cases, created in the org and assigned to queues:

```powershell
$wrapup = "$env:USERPROFILE\.cursor\skills\ava-wrap-up-codes\scripts"
node "$wrapup\generate-wrap-up-catalog.js" --session-dir "<session>" --lifecycle-dir ".ava-lifecycle/<slug>" --min 15 --max 25
node "$wrapup\discover-target-queues.js"   --session-dir "<session>" [--queue-names "Acme Support,Acme Sales"]
node "$wrapup\ava-wrap-up-codes.js" apply-axl --session-dir "<session>" --lifecycle-dir ".ava-lifecycle/<slug>" --confirm-apply
```

The generator reports `needsCuration` for codes it could only name from prose in the spec, and it
no longer pads a short catalogue with a repeated filler code. Rename the flagged ones and add real
codes for any shortfall before creating them in the org — `plan` fails below 15 and on duplicates.

**Ask before assigning queues.** The default behaviour assigns to every queue whose name contains
"support" or "sales". Put the choice to the author as all routing queues versus a named list, and
pass `--queue-names` when they name them. Assigning a POC's codes to every queue in a shared org is
a change other teams will notice.

Code design that holds up in a bot flow:

- Every code needs a **description**. After Contact selection is AI-driven and a code without a
  description is effectively invisible. `plan` warns on each one.
- Cover the four exit reasons, not just the happy paths: contained, escalated (per destination),
  guardrail stop, assistant error.
- One code per distinguishable business result, not one per utterance. 15-25 total.
- **No repeats.** Generated catalogues have shipped with the same generic code three times, which
  gives the assistant nothing to choose between. `plan` fails on duplicate names; read the
  descriptions too, since three differently-named codes can still say the same thing.
- **Prefix the codes** in a shared org, so a POC's codes cannot be confused with production ones.

Then put the **names** into `afterContact.wrapUpCodes` in the bot flow plan. `plan` fails if any
name does not exist in the org, which is the check that keeps the published flow honest: Architect
accepts an unknown code name in the YAML and silently drops it.

## Order matters

Codes and the summary setting must exist in the org **before** the flow is imported, because the
flow references them by name and id. The lifecycle in `SKILL.md` runs them in that order.
