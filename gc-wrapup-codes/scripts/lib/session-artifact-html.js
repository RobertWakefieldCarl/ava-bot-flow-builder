'use strict';

const fs = require('fs');
const path = require('path');

const WRAPUP_HTML = 'wrap-up-codes-handoff.html';
const SUMMARY_HTML = 'custom-summary-handoff.html';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveSessionDir(options, ...hintPaths) {
  if (options['session-dir']) return path.resolve(options['session-dir']);
  if (options.sessionDir) return path.resolve(options.sessionDir);
  for (const hint of hintPaths) {
    if (!hint) continue;
    const p = path.resolve(hint);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    const dir = path.dirname(p);
    if (dir && dir !== '.' && fs.existsSync(dir)) return dir;
  }
  if (options.out && !String(options.out).endsWith('.json')) {
    return path.resolve(options.out);
  }
  return null;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadWrapupCodesFromSession(sessionDir, codesFile) {
  const candidates = [
    codesFile,
    path.join(sessionDir, 'wrap-up-codes.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    const raw = readJsonIfExists(p);
    if (!raw) continue;
    const list = raw.codes || raw.wrapUpCodes || [];
    return {
      file: p,
      meta: raw._meta || null,
      codes: list.map((c) => ({
        name: c.name,
        description: c.description || '',
        id: c.id || null,
      })).filter((c) => c.name),
    };
  }
  return { file: null, meta: null, codes: [] };
}

function loadBindings(sessionDir, bindingsPath) {
  const p = bindingsPath || path.join(sessionDir, 'telephony-bindings.json');
  const raw = readJsonIfExists(p);
  if (!raw) return { path: p, data: null };
  return { path: p, data: raw.bindings || raw };
}

function avaBlock(options, meta) {
  const agentId = options['sage-agent-id'] || options.sageAgentId
    || meta?.agent_id || meta?.sageAgentId || meta?.agentId || null;
  const avaName = options['ava-name'] || options.avaName
    || meta?.avaName || meta?.agentName || null;
  return { agentId, avaName };
}

function pageShell(title, bodyInner) {
  const generated = new Date().toISOString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>
    :root { font-family: system-ui, Segoe UI, sans-serif; color: #1a1a1a; line-height: 1.45; }
    body { max-width: 960px; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; }
    h1 { font-size: 1.35rem; margin: 0 0 0.25rem; }
    .meta { color: #555; font-size: 0.9rem; margin-bottom: 1.5rem; }
    section { margin: 1.25rem 0; padding: 1rem 1.1rem; border: 1px solid #ddd; border-radius: 8px; }
    section h2 { font-size: 1.05rem; margin: 0 0 0.65rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
    th, td { text-align: left; vertical-align: top; padding: 0.45rem 0.5rem; border-bottom: 1px solid #eee; }
    th { font-weight: 600; background: #f7f7f7; }
    dl { margin: 0; }
    dt { font-weight: 600; margin-top: 0.5rem; }
    dd { margin: 0.15rem 0 0 0; color: #333; }
    pre { background: #f4f4f5; padding: 0.75rem; border-radius: 6px; overflow-x: auto; font-size: 0.85rem; white-space: pre-wrap; }
    .note { font-size: 0.88rem; color: #666; font-style: italic; }
    code { font-size: 0.88em; }
  </style>
</head>
<body>
${bodyInner}
<p class="meta">Generated ${escapeHtml(generated)}</p>
</body>
</html>
`;
}

function telephonySection(bindings, extra = {}) {
  if (!bindings && !extra.queueName && !extra.queueId) {
    return '<section><h2>Telephony targets</h2><p class="note">No bot flow or queue recorded. Run discover-telephony or pass telephony-bindings.json.</p></section>';
  }
  const b = bindings || {};
  const rows = [
    ['Inbound flow', b.inboundFlowName, b.inboundFlowId],
    ['Bot flow (After Contact)', b.botFlowName, b.botFlowId],
    ['Escalation queue', extra.queueName || b.escalationQueueName, extra.queueId || b.escalationQueueId],
  ].filter((r) => r[1] || r[2]);

  let html = '<section><h2>Telephony targets</h2><table><thead><tr><th>Target</th><th>Name</th><th>ID</th></tr></thead><tbody>';
  for (const [label, name, id] of rows) {
    html += `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(name || '—')}</td><td><code>${escapeHtml(id || '—')}</code></td></tr>`;
  }
  html += '</tbody></table>';
  if (extra.changeNote) html += `<p class="note">${escapeHtml(extra.changeNote)}</p>`;
  html += '</section>';
  return html;
}

function buildWrapupHandoffHtml(params) {
  const {
    sessionDir,
    avaName,
    agentId,
    codes,
    bindings,
    queueName,
    queueId,
    changeNote,
    action,
  } = params;

  const avaLines = [];
  if (avaName) avaLines.push(`<dt>AVA name</dt><dd>${escapeHtml(avaName)}</dd>`);
  if (agentId) avaLines.push(`<dt>Sage agent ID</dt><dd><code>${escapeHtml(agentId)}</code></dd>`);
  if (!avaLines.length) avaLines.push('<dd class="note">Pass --sage-agent-id or include agent_id in wrap-up-codes.json _meta.</dd>');

  let codesTable = '<p class="note">No wrap-up codes in session artifact.</p>';
  if (codes.length) {
    codesTable = `<table><thead><tr><th>Name</th><th>Description</th></tr></thead><tbody>`;
    for (const c of codes) {
      codesTable += `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.description || '—')}</td></tr>`;
    }
    codesTable += '</tbody></table>';
  }

  const body = `
  <h1>Wrap-up codes handoff</h1>
  <p class="meta">Session folder: <code>${escapeHtml(sessionDir)}</code>${action ? ` · ${escapeHtml(action)}` : ''}</p>
  <section><h2>AVA under test</h2><dl>${avaLines.join('')}</dl></section>
  ${telephonySection(bindings, { queueName, queueId, changeNote })}
  <section><h2>Wrap-up codes (${codes.length})</h2>${codesTable}
  <p class="note">Descriptions drive After Contact AI prediction on the bot flow. Queue assignment is separate from bot-flow enablement.</p>
  </section>`;

  return pageShell('Wrap-up codes handoff', body);
}

function buildConfigurationPrompt(setting, meta) {
  if (setting.settingType === 'Prompt' && setting.prompt) {
    return { mode: 'Prompt', text: setting.prompt };
  }
  const lines = [
    `Summary type: ${setting.summaryType || 'Concise'}`,
    `Format: ${setting.format || 'GroupedBulletPoints'}`,
    `Language: ${setting.language || 'en-US'}`,
    `Predefined insights (always requested): ${(setting.predefinedInsights || []).join(', ') || 'ReasonForCall, Resolution, ActionItems'}`,
    '',
    'Custom attribute extract (entities the model must extract):',
  ];
  for (const e of setting.customEntities || []) {
    lines.push(`- ${e.label}: ${e.description || ''}`);
  }
  if (meta?.useCases?.length) {
    lines.push('', 'Use cases this setting was built for:');
    for (const uc of meta.useCases) {
      lines.push(`- ${uc.name || uc}${uc.source ? ` (${uc.source})` : ''}`);
    }
  }
  return { mode: setting.settingType || 'Basic', text: lines.join('\n') };
}

function buildIllustrativeSample(setting, meta, transcriptExcerpt) {
  const parts = [];
  if (transcriptExcerpt) {
    parts.push('--- Sample transcript (excerpt) ---', transcriptExcerpt.trim().slice(0, 1200), '');
  }
  parts.push('--- Illustrative summary structure (not live model output) ---', '');
  const insightLabels = {
    ReasonForCall: 'Reason for call',
    Resolution: 'Outcome of call',
    ActionItems: 'Next best action',
  };
  for (const key of setting.predefinedInsights || ['ReasonForCall', 'Resolution', 'ActionItems']) {
    parts.push(`${insightLabels[key] || key}:`, `[Example ${insightLabels[key] || key} text for ${meta?.session || 'this AVA'}.]`, '');
  }
  for (const e of (setting.customEntities || []).slice(0, 6)) {
    parts.push(`${e.label}:`, `[Example value from tool output — ${e.description || 'see setting'}.]`, '');
  }
  parts.push('Note: Run Admin preview or a live interaction to validate actual wording.');
  return parts.join('\n');
}

function buildSummaryHandoffHtml(params) {
  const {
    sessionDir,
    avaName,
    agentId,
    setting,
    meta,
    bindings,
    settingId,
    transcriptPath,
    changeNote,
    action,
    boundAssistant,
  } = params;

  const prompt = buildConfigurationPrompt(setting, meta);
  let transcriptExcerpt = '';
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    transcriptExcerpt = fs.readFileSync(transcriptPath, 'utf8');
  } else {
    const guess = path.join(sessionDir, 'sample-transcript.txt');
    if (fs.existsSync(guess)) transcriptExcerpt = fs.readFileSync(guess, 'utf8');
  }
  const sample = buildIllustrativeSample(setting, meta, transcriptExcerpt);

  const avaLines = [];
  if (avaName) avaLines.push(`<dt>AVA name</dt><dd>${escapeHtml(avaName)}</dd>`);
  if (agentId) avaLines.push(`<dt>Sage agent ID</dt><dd><code>${escapeHtml(agentId)}</code></dd>`);
  if (!avaLines.length) avaLines.push('<dd class="note">Include agent id in summary-setting.json _meta when known.</dd>');

  const body = `
  <h1>Custom AI summary handoff</h1>
  <p class="meta">Session folder: <code>${escapeHtml(sessionDir)}</code>${action ? ` · ${escapeHtml(action)}` : ''}</p>
  <section><h2>AVA under test</h2><dl>${avaLines.join('')}</dl></section>
  ${telephonySection(bindings, { changeNote })}
  <section><h2>Summary setting</h2>
    <dl>
      <dt>Name</dt><dd>${escapeHtml(setting.name || '—')}</dd>
      <dt>Setting ID</dt><dd><code>${escapeHtml(settingId || setting.id || '—')}</code></dd>
      <dt>Configuration mode</dt><dd>${escapeHtml(prompt.mode)}</dd>
      ${boundAssistant ? `<dt>Copilot assistant</dt><dd><code>${escapeHtml(boundAssistant)}</code></dd>` : ''}
    </dl>
  </section>
  <section><h2>Configuration prompt</h2>
    <p class="note">${prompt.mode === 'Prompt' ? 'Free-text prompt sent for Prompt-type settings.' : 'Basic mode: platform composes the summary from the fields below (effective authoring prompt).'}</p>
    <pre>${escapeHtml(prompt.text)}</pre>
  </section>
  <section><h2>Sample summary</h2>
    <pre>${escapeHtml(sample)}</pre>
  </section>`;

  return pageShell('Custom AI summary handoff', body);
}

function writeWrapupSessionHtml(options = {}) {
  const sessionDir = resolveSessionDir(
    options,
    options.file,
    options.bindings,
    options['codes-file'],
  );
  if (!sessionDir) {
    return { ok: false, error: 'Could not resolve session directory. Pass --session-dir or --file under the session folder.' };
  }
  const { meta, codes } = loadWrapupCodesFromSession(sessionDir, options.file || options['codes-file']);
  const { data: bindings } = loadBindings(sessionDir, options.bindings);
  const ava = avaBlock(options, meta);
  if (bindings?.sageAgentId && !ava.agentId) ava.agentId = bindings.sageAgentId;

  const html = buildWrapupHandoffHtml({
    sessionDir,
    avaName: ava.avaName,
    agentId: ava.agentId,
    codes,
    bindings,
    queueName: options['queue-name'] || options.queueName,
    queueId: options['queue-id'] || options.queueId || bindings?.escalationQueueId,
    changeNote: options['change-note'] || options.changeNote,
    action: options.action,
  });
  const outPath = path.join(sessionDir, WRAPUP_HTML);
  fs.writeFileSync(outPath, html, 'utf8');
  return { ok: true, sessionDir, htmlPath: outPath, artifact: WRAPUP_HTML };
}

function writeSummarySessionHtml(options = {}) {
  const sessionDir = resolveSessionDir(options, options.file, options.bindings);
  if (!sessionDir) {
    return { ok: false, error: 'Could not resolve session directory. Pass --session-dir or --file summary-setting.json path.' };
  }
  const settingPath = options.file || path.join(sessionDir, 'summary-setting.json');
  let meta = null;
  let setting = {};
  if (fs.existsSync(settingPath)) {
    const raw = readJsonIfExists(settingPath);
    meta = raw?._meta || null;
    setting = { ...raw };
    delete setting._meta;
  } else if (options.setting) {
    setting = options.setting;
    meta = options.meta || null;
  } else {
    return { ok: false, error: `No summary setting at ${settingPath}` };
  }

  const { data: bindings } = loadBindings(sessionDir, options.bindings);
  const ava = avaBlock(options, meta);
  if (bindings?.sageAgentId && !ava.agentId) ava.agentId = bindings.sageAgentId;

  const html = buildSummaryHandoffHtml({
    sessionDir,
    avaName: ava.avaName,
    agentId: ava.agentId,
    setting,
    meta,
    bindings,
    settingId: options.id || options['setting-id'] || setting.id,
    transcriptPath: options.transcript,
    changeNote: options['change-note'] || options.changeNote,
    action: options.action,
    boundAssistant: options.assistant || options['assistant-id'],
  });
  const outPath = path.join(sessionDir, SUMMARY_HTML);
  fs.writeFileSync(outPath, html, 'utf8');
  return { ok: true, sessionDir, htmlPath: outPath, artifact: SUMMARY_HTML };
}

module.exports = {
  WRAPUP_HTML,
  SUMMARY_HTML,
  resolveSessionDir,
  writeWrapupSessionHtml,
  writeSummarySessionHtml,
  buildWrapupHandoffHtml,
  buildSummaryHandoffHtml,
};
