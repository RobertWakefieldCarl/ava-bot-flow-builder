# Summary settings — Platform API

Credentials and region resolve from the `ava-harness` entry in `~/.cursor/mcp.json`, the same way
every other skill in this library resolves them. Never print a token or a client secret.

## Endpoints

| Step | Method and path | Purpose |
|---|---|---|
| List | `GET /api/v2/conversations/summaries/settings` | Paged. Supports `name`, `language`, `sortBy`, `sortOrder`. |
| Read | `GET /api/v2/conversations/summaries/settings/{id}` | One setting. |
| Validate | `POST /api/v2/conversations/summaries/preview` | Server-side check without creating anything. See [preview](#preview-validates-but-cannot-show-you-the-summary). |
| Create | `POST /api/v2/conversations/summaries/settings` | Body is a `SummarySetting`. Returns the created record. |
| Update | `PUT /api/v2/conversations/summaries/settings/{id}` | **Full replacement.** See [PUT replaces](#put-replaces-the-whole-record). |
| Bind | `GET`/`PUT /api/v2/assistants/{assistantId}/copilot` | Attach the setting to an Agent Copilot. |

`DELETE /api/v2/conversations/summaries/settings/{id}` exists. This skill does not expose it — see
the guardrails in SKILL.md.

## The payload

Verified against a live org: created, read back, and deleted.

```json
{
  "name": "AXL - Acme Insurance - Claim Status",
  "language": "en-US",
  "summaryType": "Concise",
  "format": "GroupedBulletPoints",
  "maskPII": { "all": false },
  "participantLabels": {
    "internal": "Agent",
    "external": "Policyholder",
    "virtualAgent": "Vera"
  },
  "predefinedInsights": ["ReasonForCall", "Resolution", "ActionItems"],
  "customEntities": [
    { "label": "Claim number", "description": "The claim number the caller provided or that the assistant looked up." }
  ],
  "settingType": "Basic",
  "serviceType": "Native",
  "timeoutDuration": 20
}
```

### Fields

| Field | Required | Values |
|---|---|---|
| `name` | yes | Free text. |
| `language` | yes | BCP-47, e.g. `en-US`. Stored lowercased. |
| `summaryType` | no | `Concise` \| `Detailed` |
| `format` | no | `TextBlock` \| `BulletPoints` \| `GroupedTextBlocks` \| `GroupedBulletPoints` |
| `maskPII.all` | yes, if `maskPII` sent | boolean |
| `participantLabels` | no | `internal`, `external`, `virtualAgent` |
| `predefinedInsights` | no | `ReasonForCall` (reason for call) \| `Resolution` (outcome of call) \| `ActionItems` (next best action). The **summary** is the full generated document; **attribute extract** = `customEntities`. |
| `customEntities[]` | no | `{ label, description }` |
| `settingType` | no | `Basic` \| `Prompt` |
| `prompt` | when `Prompt` | Free text. |
| `serviceType` | no | `Native` \| `External` |
| `integrationId` | when `External` | Integration backing an external summarisation service. |
| `timeoutDuration` | no | Seconds. Orgs in the field use `20`. |

Read-only, never send: `id`, `dateCreated`, `dateModified`, `interactionType`, `selfUri`. The
script strips them, so the output of `get` can be edited and re-applied without hand-cleaning.

## Server-enforced limits the definition does not state

Confirmed empirically against the preview endpoint. None appear in the published definition, and
all six are enforced on create and update as well. The validator in
`scripts/lib/summary_setting.js` checks them locally so they fail before a network call.

| Field | Limit | Failure |
|---|---|---|
| `name` | 100 characters | `The name must be at most 100 characters` |
| `customEntities[].label` | **30 characters** | `The label must be at most 30 characters` |
| `customEntities[].description` | **120 characters** | `The description must be at most 120 characters` |
| `customEntities` | **10 entities** | `Maximum 10 entities per configuration can be defined.` |
| `participantLabels.*` | 30 characters each | `The internal label must be at most 30 characters` |
| `summaryPreviewSessionId` | must be a UUID | `Preview session id must be a valid UUID` |

The 120-character description cap is the one that bites. A description has room to say what to
extract and where it comes from, and nothing more. No limit was found on `prompt` up to 2000
characters.

## The preview transcript needs a recognised speaker prefix

A transcript is rejected with `summary.setting.invalid.transcript` ("Transcripts are not valid")
unless **at least one line is prefixed with a speaker token the parser recognises.**

- Recognised: `Customer:`, `Agent:`, `External:`, `Internal:`, `Bot:`
- **Not** recognised: `Caller:`, `Assistant:`, `User:`, `System:`, or any arbitrary name

Only one line needs a recognised token; the remaining lines may use anything. A transcript with no
prefixes at all, or only unrecognised ones, is rejected.

This vocabulary is **independent of `participantLabels`.** A setting that labels the parties
"Caller" and "BMV Virtual Assistant" still needs `Customer:` and `Bot:` in the preview transcript —
the labels control how the *generated summary* refers to participants, not how the transcript is
parsed. Use `Customer:` with `Agent:` for an agent conversation, or `Customer:` with `Bot:` for a
virtual agent.

JSON transcripts are rejected. The field is plain text.

## Facts the public API definition gets wrong

The bundled `purecloud-platform-api-v2.json` is pinned and slightly stale here. Both of these were
confirmed directly against a live org:

1. **`participantLabels.virtualAgent` is real.** The published `SummarySettingParticipantLabels`
   definition lists only `internal` and `external`. The field is accepted on write and returned on
   read, and settings created through the Admin UI carry it. Use it — for an AVA-fronted
   interaction it is the label that matters most.
2. **The definition's nesting is misleading.** `predefinedInsights`, `customEntities`,
   `settingType`, `prompt`, `serviceType`, `integrationId` and `timeoutDuration` are all
   properties of `SummarySetting` itself, despite appearing after a nested object reference.
   `SummarySettingPII` has exactly one property, `all`.

## PUT replaces the whole record

`PUT` is an unconditional full replacement with no `version` field and no optimistic locking.
Anything the request body omits is erased. The script therefore reads the current setting, shows a
field-level diff, and refuses to apply without `--confirm-apply`. Two people editing the same
setting will silently overwrite each other — read immediately before writing.

## Preview validates, but cannot show you the summary

`POST /api/v2/conversations/summaries/preview` takes the setting plus a transcript and a
`summaryPreviewSessionId`, which **must be a valid UUID** or the call fails with
`constraint.validation`. On success it returns `200` with an **empty body**.

The generated summary is delivered asynchronously on the notification topic
`v2.users.{id}.conversations.summaries.settings.preview` — keyed to the *user* who requested it.
This skill authenticates with OAuth Client Credentials, which has no user context
(`GET /api/v2/users/me` returns `not.a.user`), so **the generated text cannot be retrieved here.**

What preview is still good for: it validates the setting server-side without creating an entity.
A 200 means the payload is acceptable; a 400 names what is wrong. Use it as the dry run. To see
actual generated text, use the preview pane in Admin, or run a real interaction.

## Binding — two runtimes

| Track | Runtime | Skill commands | API / UI |
|---|---|---|---|
| **1** | Virtual Agent bot flow (After Contact) | `discover-telephony`, `plan-bind-bot-flow`, `bind-bot-flow` + `gc-wrapup-codes plan-bot-wrapup` | Architect bot flow **Settings → After Contact**; select AI Studio setting. No REST bind in this skill yet — checklist + optional YAML fragment. |
| **2** | Agent Copilot on a queue | `bind --assistant` | `PUT /api/v2/assistants/{assistantId}/copilot` |

Copilot bind does **not** configure bot-flow After Contact for a VA-only disconnect.

## Binding to Agent Copilot (Track 2)

A setting does nothing until something references it. The reference lives on the Copilot
configuration of an assistant:

```
GET  /api/v2/assistants/{assistantId}/copilot
PUT  /api/v2/assistants/{assistantId}/copilot
```

with `summaryGenerationConfig.summarySetting.id` set to the setting id. `PUT` replaces the whole
Copilot object, and `Copilot` requires `defaultLanguage` and `liveOnQueue`, so the script merges
onto the current configuration rather than building a bare body. Assistants are attached to queues
separately; this skill does not change queue membership.

Virtual-agent summaries also surface on `v2.bot.conversation.{id}.conversations.summaries`, which
is informational only — there is nothing to configure there.

## Permissions

The OAuth client needs:

- `conversation:summarySetting:view`, `:add`, `:edit` for the settings themselves
- `assistant:assistant:view` and `:edit` to list assistants and bind a setting

A `403` here is a permissions gap on the client, not a bad payload. Report it as such rather than
retrying.

## Limits observed

- One language per setting. A bilingual prototype needs one setting per language.
- `interactionType` (`Live` / `Email`) is assigned by the platform and is not settable.
- Settings are org-level and are not divisioned; anyone with view permission sees all of them.
- No endpoint reports which assistants reference a setting, so there is no reverse-index usage
  scan before an edit. Check the assistants you know about with `list-assistants`.
