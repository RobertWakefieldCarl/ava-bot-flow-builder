# OAuth client and permissions

One OAuth **Client Credentials** grant runs every step of this skill. It is the same client the
AVA harness MCP server uses (`GENESYS_CLIENT_ID` / `GENESYS_CLIENT_SECRET` / `AVA_HABITAT` in
`~/.cursor/mcp.json`), so adding the scopes below to that client is usually all that is needed.

Client credentials grants have **no user**, so authorisation comes from the **role assigned to the
OAuth client** plus the **divisions** that role is granted in. A missing division is the most common
cause of a 403 that looks like a missing permission: the flow, queue or wrap-up code lives in a
division the client's role does not cover. Grant the role in **All divisions** for a lab or POC org,
or in the specific divisions that hold the bot flow, queues and codes.

## Scopes

| Scope | Needed for |
|---|---|
| `architect` | Create, import, publish and delete flows; flow outcomes; flow milestones; export jobs |
| `routing` | Read queues; read, create and assign wrap-up codes |
| `ai-studio` | Read and create conversation summary settings |
| `speech-and-text-analytics` | Read the General program, set its flow mappings, publish it |

Read-only variants (`architect:readonly`, `routing:readonly`, `ai-studio:readonly`,
`speech-and-text-analytics:readonly`) are enough for `whoami`, `discover`, `plan` and `verify`, but
not for `apply`.

## Permissions by step

| Step | Operation | Permissions |
|---|---|---|
| Org confirmation | `GET /api/v2/organizations/me` | none beyond a valid token |
| Discover flows | `GET /api/v2/flows`, `GET /api/v2/flows/{id}` | `architect:flow:view` |
| Export a flow (plan diff, verify) | `POST/GET /api/v2/flows/export/jobs` | `architect:jobExport:create`, `architect:jobExport:view` |
| Create / update / publish the bot flow | `POST /api/v2/flows/jobs`, `GET /api/v2/flows/jobs/{id}` | `architect:job:create`, `architect:job:view`, plus `architect:flow:add`, `architect:flow:edit`, `architect:flow:publish` for the flow the job writes |
| Flow outcome | `GET/POST /api/v2/flows/outcomes` | `architect:flowOutcome:view`, `architect:flowOutcome:add` |
| Flow milestones | `GET/POST /api/v2/flows/milestones` | `architect:flowMilestone:view`, `architect:flowMilestone:add` |
| Schema probe cleanup only | `DELETE /api/v2/flows/{id}`, `DELETE /api/v2/flows/milestones/{id}` | `architect:flow:delete`, `architect:flowMilestone:delete` |
| Escalation queue checks | `GET /api/v2/routing/queues` | `routing:queue:view` |
| Wrap-up codes (via ava-wrap-up-codes) | `GET/POST /api/v2/routing/wrapupcodes` | `routing:wrapupCode:view`, `routing:wrapupCode:add` |
| Assign codes to queues | `POST /api/v2/routing/queues/{id}/wrapupcodes` | `routing:queue:edit` |
| Custom summary (via ava-custom-summary) | `GET/POST /api/v2/conversations/summaries/settings` | `aiStudio:summaryConfig:view`, `aiStudio:summaryConfig:add` |
| Read the General program | `GET /api/v2/speechandtextanalytics/programs`, `.../{id}/mappings` | `speechAndTextAnalytics:program:view` |
| Map the bot flow into the program | `PUT /api/v2/speechandtextanalytics/programs/{id}/mappings` | `speechAndTextAnalytics:program:edit` |
| Publish the program | `POST /api/v2/speechandtextanalytics/programs/publishjobs` | `speechAndTextAnalytics:program:publish` |

## Minimum role

A single custom role carries all of it:

```
architect:flow:view, architect:flow:add, architect:flow:edit, architect:flow:publish, architect:flow:delete
architect:job:create, architect:job:view
architect:jobExport:create, architect:jobExport:view
architect:flowOutcome:view, architect:flowOutcome:add
architect:flowMilestone:view, architect:flowMilestone:add
routing:queue:view, routing:queue:edit
routing:wrapupCode:view, routing:wrapupCode:add
aiStudio:summaryConfig:view, aiStudio:summaryConfig:add
speechAndTextAnalytics:program:view, speechAndTextAnalytics:program:edit, speechAndTextAnalytics:program:publish
```

Drop `architect:flow:delete` and `architect:flowMilestone:delete` unless `probe-schema.js` will be
run — that is the only command that deletes anything, and only the disposable objects it created
itself. Note that the Platform API has **no delete for flow outcomes**: an outcome created by the
probe, or by a plan that was later renamed, can only be removed in Architect. Name outcomes
deliberately.

## Product entitlements, not permissions

Permissions alone are not enough when the org lacks the product:

- **Virtual Agent must be enabled on the org** before a bot flow can host a Call Agentic Virtual
  Agent action (`settingsBotFlow.virtualAgentEnabled: true`).
- **Agent Assist / AI Studio summaries** must be licensed for After Contact conversation summary.
- **Speech and Text Analytics** must be licensed, and voice transcription enabled, before mapping a
  flow into the General program changes anything.
- The AVA itself must be **published**; the flow binds `ver_latestPublished`.

## Failure signatures

| Symptom | Cause |
|---|---|
| `401` on the token request | Wrong client id/secret, or wrong region in `AVA_HABITAT` |
| `403` with a correct-looking scope | Role not granted in the division holding the object |
| Architect job `Failure` mentioning the agent | AVA not published, or Virtual Agent not enabled on the org |
| `404` on the General program | Speech and Text Analytics not provisioned in the org |
| Summary toggle reverts after publish | `ai-studio` scope present but no summary licence |
