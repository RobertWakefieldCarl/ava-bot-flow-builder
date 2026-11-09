#!/usr/bin/env node
'use strict';

/**
 * Genesys Cloud custom AI summary settings.
 *
 *   node gc_summary_setting.js whoami
 *   node gc_summary_setting.js list [--name <fragment>]
 *   node gc_summary_setting.js get --id <uuid> [--out <file.json>]
 *   node gc_summary_setting.js validate --file <summary-setting.json>
 *   node gc_summary_setting.js preview  --file <summary-setting.json> --transcript <file.txt>
 *   node gc_summary_setting.js create   --file <summary-setting.json> [--confirm-apply]
 *   node gc_summary_setting.js update   --id <uuid> --file <file.json> [--confirm-apply]
 *   node gc_summary_setting.js list-assistants [--name <fragment>]
 *   node gc_summary_setting.js bind --assistant <uuid> --id <uuid> [--confirm-apply]
 *   node gc_summary_setting.js discover-telephony --inbound-flow-id <uuid> [--out-dir <path>]
 *   node gc_summary_setting.js resolve-targets --name <customer fragment>
 *   node gc_summary_setting.js plan-bind-bot-flow --bindings <telephony-bindings.json> --id <uuid>
 *   node gc_summary_setting.js bind-bot-flow --bindings <telephony-bindings.json> --id <uuid> [--confirm-apply]
 *   node gc_summary_setting.js write-session-html --session-dir <path> [--file summary-setting.json]
 *       [--bindings telephony-bindings.json] [--transcript sample-transcript.txt] [--change-note <text>]
 *
 * Reads run immediately. Writes print a plan and do nothing without --confirm-apply.
 * There is deliberately no delete subcommand. Output is JSON. Secrets are never printed.
 */

const fs = require('fs');
const { randomUUID } = require('crypto');
const { GenesysClient } = require('./lib/genesys_client');
const summarySetting = require('./lib/summary_setting');
const summaryBotBind = require('./lib/summary_bot_bind');
const { writeSummaryHandoff } = require('./lib/session_html_bridge');

const SETTINGS_PATH = '/api/v2/conversations/summaries/settings';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; } else { args[key] = next; i += 1; }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function out(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/** Load and validate in one step; every write path goes through this. */
function loadValidated(file) {
  const { meta, setting } = summarySetting.read(file);
  const result = summarySetting.validate(setting, meta);
  if (!result.valid) {
    throw new Error(`${file} is not a valid summary setting:\n- ${result.errors.join('\n- ')}`);
  }
  return { meta, setting, warnings: result.warnings };
}

async function whoami(client) {
  return client.whoami();
}

async function list(client, args) {
  const query = args.name ? `?name=${encodeURIComponent(args.name)}&pageSize=100` : '?pageSize=100';
  const page = await client.get(`${SETTINGS_PATH}${query}`);
  return {
    action: 'list',
    total: page.total,
    settings: (page.entities || []).map((e) => ({
      id: e.id,
      name: e.name,
      language: e.language,
      summaryType: e.summaryType,
      format: e.format,
      settingType: e.settingType,
      maskPII: e.maskPII && e.maskPII.all,
      insights: e.predefinedInsights,
      customEntities: (e.customEntities || []).length,
      dateModified: e.dateModified,
    })),
  };
}

async function get(client, args) {
  const setting = await client.get(`${SETTINGS_PATH}/${args.id}`);
  let written = null;
  if (args.out && args.out !== true) {
    const clean = { ...setting };
    for (const field of summarySetting.READ_ONLY_FIELDS) delete clean[field];
    fs.writeFileSync(args.out, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
    written = args.out;
  }
  return { action: 'get', setting, writtenTo: written };
}

async function validate(client, args) {
  const { meta, setting } = summarySetting.read(args.file);
  const result = summarySetting.validate(setting, meta);
  return {
    action: 'validate',
    file: args.file,
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    useCases: meta && meta.useCases,
    nextStep: result.valid
      ? 'Report the warnings, then preview --file <file> --transcript <file>.'
      : 'Fix the errors. Nothing was sent to Genesys Cloud.',
  };
}

/**
 * Server-side validation without creating an entity. The generated summary is delivered on a
 * user-scoped notification topic that client credentials cannot subscribe to, so the text
 * itself is not retrievable here — see references/platform-api.md.
 */
async function preview(client, args) {
  const { setting, warnings } = loadValidated(args.file);
  if (!args.transcript || args.transcript === true) {
    throw new Error('--transcript <file.txt> is required: preview needs an example transcript to run the setting against.');
  }
  const transcript = fs.readFileSync(args.transcript, 'utf8');
  if (!transcript.trim()) throw new Error(`${args.transcript} is empty.`);

  const sessionId = randomUUID();
  await client.post('/api/v2/conversations/summaries/preview', {
    transcript,
    summaryPreviewSessionId: sessionId,
    summarySetting: setting,
  });
  const htmlHandoff = writeSummaryHandoff(args, {
    file: args.file,
    transcript: args.transcript,
    action: 'preview',
    changeNote: 'Preview validation only — setting not created or bound.',
  });

  return {
    action: 'preview',
    accepted: true,
    summaryPreviewSessionId: sessionId,
    warnings,
    htmlHandoff,
    note: 'The setting is valid server-side and nothing was created. The generated summary text is '
      + 'delivered on a user-scoped notification topic and cannot be read with client credentials — '
      + 'use the preview pane in Admin to see actual wording.',
    nextStep: `create --file ${args.file} --confirm-apply`,
  };
}

async function create(client, args) {
  const { meta, setting, warnings } = loadValidated(args.file);
  if (!args['confirm-apply']) {
    const htmlHandoff = writeSummaryHandoff(args, {
      file: args.file,
      action: 'create (plan)',
      changeNote: 'Dry run — summary setting not created in Genesys Cloud yet.',
    });
    return {
      action: 'create',
      applied: false,
      plan: { operation: `POST ${SETTINGS_PATH}`, name: setting.name, setting },
      useCases: meta && meta.useCases,
      warnings,
      htmlHandoff,
      nextStep: 'Re-run with --confirm-apply to create it.',
    };
  }
  const created = await client.post(SETTINGS_PATH, setting);
  const verified = await client.get(`${SETTINGS_PATH}/${created.id}`);
  const htmlHandoff = writeSummaryHandoff(args, {
    file: args.file,
    id: created.id,
    action: 'create',
    changeNote: `Created AI Studio summary setting "${created.name}" in org.`,
  });
  return {
    action: 'create',
    applied: true,
    id: created.id,
    name: created.name,
    verified,
    warnings,
    htmlHandoff,
    nextStep: `Nothing uses this setting yet. Bind it: bind --assistant <uuid> --id ${created.id}`,
  };
}

/** PUT is a full replacement with no optimistic locking, so read, diff, then confirm. */
async function update(client, args) {
  const { meta, setting, warnings } = loadValidated(args.file);
  const current = await client.get(`${SETTINGS_PATH}/${args.id}`);
  const changes = summarySetting.diff(current, setting);
  const erased = changes.filter((c) => c.erased);

  if (!args['confirm-apply']) {
    return {
      action: 'update',
      applied: false,
      id: args.id,
      currentName: current.name,
      plan: { operation: `PUT ${SETTINGS_PATH}/${args.id}`, changes },
      erasedFields: erased.map((c) => c.field),
      useCases: meta && meta.useCases,
      warnings: [
        ...warnings,
        ...(erased.length
          ? [`PUT replaces the whole record and the file omits these fields: ${erased.map((c) => c.field).join(', ')}. `
            + 'Each will be cleared or reset to the platform default. Add them to the file to keep the current values.']
          : []),
        ...(changes.length ? [] : ['No changes — the file already matches the live setting.']),
      ],
      nextStep: changes.length ? 'Re-run with --confirm-apply to write it.' : 'Nothing to do.',
    };
  }

  const updated = await client.request('PUT', `${SETTINGS_PATH}/${args.id}`, setting);
  const verified = await client.get(`${SETTINGS_PATH}/${args.id}`);
  return {
    action: 'update',
    applied: true,
    id: updated.id,
    name: updated.name,
    changes,
    verified,
    warnings,
  };
}

/**
 * The assistants endpoint reports no `total` or `pageCount`, so a full page back means the
 * result may be truncated and a "no match" answer cannot be trusted. Say so rather than
 * letting the caller conclude an assistant does not exist.
 */
async function listAssistants(client, args) {
  const pageSize = 200;
  const page = await client.get(`/api/v2/assistants?pageSize=${pageSize}`);
  const all = page.entities || [];
  let entities = all;
  if (args.name && args.name !== true) {
    const needle = String(args.name).toLowerCase();
    entities = all.filter((e) => String(e.name || '').toLowerCase().includes(needle));
  }
  const maybeTruncated = all.length >= pageSize;
  return {
    action: 'list-assistants',
    scanned: all.length,
    matched: entities.length,
    assistants: entities.map((e) => ({ id: e.id, name: e.name })),
    maybeTruncated,
    note: maybeTruncated
      ? `Exactly ${pageSize} assistants came back and this endpoint reports no total, so there may be more. `
        + 'A "no match" result here is not proof that no assistant exists.'
      : (args.name ? undefined : 'Filter with --name to avoid listing the whole org.'),
  };
}

/** Attach a setting to an assistant's Copilot. PUT replaces the Copilot object, so merge. */
async function bind(client, args) {
  const copilot = await client.get(`/api/v2/assistants/${args.assistant}/copilot`);
  const setting = await client.get(`${SETTINGS_PATH}/${args.id}`);

  const currentConfig = copilot.summaryGenerationConfig || {};
  const previousId = (currentConfig.summarySetting || {}).id || null;
  const next = {
    ...copilot,
    summaryGenerationConfig: {
      ...currentConfig,
      enabled: true,
      summarySetting: { id: args.id },
    },
  };
  delete next.selfUri;
  delete next.enabled; // read-only on Copilot

  if (!args['confirm-apply']) {
    const htmlHandoff = writeSummaryHandoff(args, {
      id: args.id,
      assistant: args.assistant,
      action: 'bind (plan)',
      changeNote: 'Dry run — Copilot summary binding not applied.',
    });
    return {
      action: 'bind',
      applied: false,
      plan: {
        operation: `PUT /api/v2/assistants/${args.assistant}/copilot`,
        assistant: args.assistant,
        summarySetting: { id: args.id, name: setting.name },
        previousSummarySettingId: previousId,
        summaryGenerationEnabled: { before: currentConfig.enabled === true, after: true },
      },
      warnings: [
        ...(previousId && previousId !== args.id
          ? [`This assistant already points at summary setting ${previousId}. Binding replaces that reference.`]
          : []),
        ...(copilot.liveOnQueue ? [] : ['Copilot liveOnQueue is false, so no queue will produce summaries yet.']),
      ],
      htmlHandoff,
      nextStep: 'Re-run with --confirm-apply to bind it.',
    };
  }

  await client.request('PUT', `/api/v2/assistants/${args.assistant}/copilot`, next);
  const verified = await client.get(`/api/v2/assistants/${args.assistant}/copilot`);
  const boundId = ((verified.summaryGenerationConfig || {}).summarySetting || {}).id || null;
  const htmlHandoff = writeSummaryHandoff(args, {
    id: args.id,
    assistant: args.assistant,
    action: 'bind',
    changeNote: `Bound summary setting to Agent Copilot assistant ${args.assistant} (Track 2).`,
  });
  return {
    action: 'bind',
    applied: true,
    assistant: args.assistant,
    summarySettingId: boundId,
    summaryGenerationEnabled: (verified.summaryGenerationConfig || {}).enabled === true,
    liveOnQueue: verified.liveOnQueue,
    verified: boundId === args.id,
    htmlHandoff,
  };
}

async function writeSessionHtml(client, args) {
  const sessionDir = args['session-dir'];
  if (!sessionDir) throw new Error('write-session-html requires --session-dir <path>.');
  const htmlHandoff = writeSummaryHandoff(args, { action: 'write-session-html' });
  if (!htmlHandoff.ok) throw new Error(htmlHandoff.error);
  return { action: 'write-session-html', ...htmlHandoff };
}

const COMMANDS = {
  'whoami': { run: whoami, requires: [] },
  'list': { run: list, requires: [] },
  'get': { run: get, requires: ['id'] },
  'validate': { run: validate, requires: ['file'] },
  'preview': { run: preview, requires: ['file', 'transcript'] },
  'create': { run: create, requires: ['file'] },
  'update': { run: update, requires: ['id', 'file'] },
  'list-assistants': { run: listAssistants, requires: [] },
  'bind': { run: bind, requires: ['assistant', 'id'] },
  'discover-telephony': { run: (client, args) => summaryBotBind.discoverTelephony(args), requires: [] },
  'resolve-targets': { run: (client, args) => summaryBotBind.resolveTargets(client, args), requires: [] },
  'plan-bind-bot-flow': {
    run: (client, args) => summaryBotBind.planBindBotFlow(client, args),
    requires: ['bindings'],
  },
  'bind-bot-flow': {
    run: (client, args) => summaryBotBind.bindBotFlow(client, args),
    requires: ['bindings'],
  },
  'write-session-html': { run: writeSessionHtml, requires: ['session-dir'] },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const spec = COMMANDS[command];
  if (!spec) {
    throw new Error(`Unknown command "${command || '(none)'}". Expected one of: ${Object.keys(COMMANDS).join(', ')}.`);
  }
  // Check flags before resolving credentials, so a missing flag reports itself.
  const missing = spec.requires.filter((flag) => !args[flag] || args[flag] === true);
  if (missing.length) {
    throw new Error(`${command} requires: ${missing.map((f) => `--${f} <value>`).join(', ')}.`);
  }
  if (command === 'plan-bind-bot-flow' || command === 'bind-bot-flow') {
    if (!args.id && !args.file) {
      throw new Error(`${command} requires --id <setting-uuid> or --file <summary-setting.json> (after create).`);
    }
  }
  if (command === 'discover-telephony') {
    if (!args['inbound-flow-id'] && !args['flow-name']) {
      throw new Error('discover-telephony requires --inbound-flow-id <uuid> or --flow-name <exact name>.');
    }
  }
  // validate is purely local; it must work with no org and no credentials.
  const client = command === 'validate'
    ? null
    : new GenesysClient({ region: args.region, configPath: args.configPath });
  out(await spec.run(client, args));
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
