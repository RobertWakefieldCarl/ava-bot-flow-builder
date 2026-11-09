'use strict';

/**
 * Build summary-setting.json (Detailed, full attribute extract) from AXL spec + design artifact.
 *
 * Usage:
 *   node generate-summary-setting.js --session-dir <axl-sessions/AXL-x> --lifecycle-dir <.ava-lifecycle/slug>
 *   node generate-summary-setting.js --spec <path> --design <path> --out <summary-setting.json>
 */

const fs = require('fs');
const path = require('path');

const LIMIT_LABEL = 30;
const LIMIT_DESC = 120;
/** The platform ceiling is 10; past 8 the summary reads as a form rather than a summary. */
const MAX_ENTITIES = 8;

const SECRET_FIELD_RE = /\b(pin|otp|password|ssn|cvv|cvc|token|latitude|longitude|coord)\b/i;
const SECRET_LABEL_RE = /\b(pin|otp|password|ssn|cvv|cvc|token)\b/i;

/**
 * Identifying fields the customer gave to be verified. They are not a summary of the
 * call and a supervisor cannot act on them, so they do not earn one of the ten slots.
 * Whether verification succeeded is captured separately.
 */
const IDENTIFIER_FIELD_RE = /(^|_)(member|membership|customer|account|policy|patient|claim|order|case|record|contact)?_?(id|ids|number|num|no|key)$|^(dob|date_of_birth|birth_date|first_name|last_name|full_name|name|member_name|customer_name|email|phone|mobile|address|postcode|zip|zipcode)$/i;

function parseArgs(argv) {
  const out = { sessionDir: null, lifecycleDir: null, spec: null, design: null, out: null, settingType: 'Prompt' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--session-dir' && argv[i + 1]) out.sessionDir = path.resolve(argv[++i]);
    else if (a === '--lifecycle-dir' && argv[i + 1]) out.lifecycleDir = path.resolve(argv[++i]);
    else if (a === '--spec' && argv[i + 1]) out.spec = path.resolve(argv[++i]);
    else if (a === '--design' && argv[i + 1]) out.design = path.resolve(argv[++i]);
    else if (a === '--out' && argv[i + 1]) out.out = path.resolve(argv[++i]);
    else if (a === '--setting-type' && argv[i + 1]) out.settingType = /^basic$/i.test(argv[++i]) ? 'Basic' : 'Prompt';
  }
  return out;
}

function readText(p) {
  return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
}

function readJson(p) {
  return JSON.parse(readText(p));
}

function extractSection(md, num) {
  // `$` under /m matches every line ending, so the lazy body must be terminated by
  // the next heading or true end-of-input — otherwise it matches nothing at all and
  // every use case and insight silently falls back to a generic default.
  const re = new RegExp(`^##\\s+${num}\\.[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'im');
  const m = md.match(re);
  return m ? m[1] : '';
}

function truncate(s, max) {
  const t = String(s || '').trim();
  if (t.length <= max) return t;
  // Cut at the last word or list separator so the text does not end mid-word.
  const head = t.slice(0, max - 1);
  const stop = Math.max(head.lastIndexOf(' '), head.lastIndexOf('·'));
  return `${(stop > max * 0.6 ? head.slice(0, stop) : head).replace(/[\s·,;]+$/, '')}…`;
}

/** Tool property names arrive in both snake_case and camelCase; compare on one form. */
function snakeCase(fieldName) {
  return String(fieldName || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function labelFromField(fieldName, toolName) {
  const map = {
    membership_id: 'Membership ID',
    member_name: 'Member name',
    service_zip: 'Service ZIP',
    tier: 'Membership tier',
    calls_remaining: 'Calls remaining',
    covered_tow_miles: 'Covered tow miles',
    vehicle_on_file: 'Vehicle on file',
    service_call_id: 'Service call ID',
    truck_type: 'Truck type',
    eta_minutes: 'ETA minutes',
    formatted_address: 'Breakdown location',
    shared: 'Location shared',
    created: 'Dispatch created',
    found: 'Member found',
    counts_against_allotment: 'Uses allotment',
  };
  const snake = snakeCase(fieldName);
  if (map[snake]) return map[snake];
  const words = snake.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return truncate(words, LIMIT_LABEL);
}

function descriptionForEntity(label, toolName, fieldPath) {
  return truncate(
    `From ${toolName} ${fieldPath}; supervisor-facing fact only.`,
    LIMIT_DESC,
  );
}

function findType(types, name) {
  return (types || []).find((t) => t.name === name);
}

function collectOutputProperties(typeDef) {
  if (!typeDef || !Array.isArray(typeDef.properties)) return [];
  return typeDef.properties.filter(
    (p) => p.name
      && !SECRET_FIELD_RE.test(snakeCase(p.name))
      && !SECRET_FIELD_RE.test(p.description || '')
      && !IDENTIFIER_FIELD_RE.test(snakeCase(p.name)),
  );
}

function extractUseCases(specMd) {
  const s1 = extractSection(specMd, '1');
  const cases = [];
  const sentence = s1.match(/In one sentence:\*?\*?\s*([^\n]+)/i) || s1.match(/one sentence:\*?\*?\s*([^\n]+)/i);
  if (sentence) cases.push({ name: truncate(sentence[1].replace(/\*\*/g, ''), 80), source: 'spec-artifact.md §1' });
  const bullets = s1.match(/^-\s+\*\*[^*]+\*\*:[^\n]+/gm) || [];
  for (const b of bullets.slice(0, 4)) {
    const t = b.replace(/^-\s+/, '').replace(/\*\*/g, '').trim();
    if (t.length > 8) cases.push({ name: truncate(t, 80), source: 'spec-artifact.md §1' });
  }
  return cases.length ? cases : [{ name: 'Primary AVA use case', source: 'spec-artifact.md §1' }];
}

function parseAssistantName(specMd) {
  const s3 = extractSection(specMd, '3');
  const m = s3.match(/\*\*Name:\*\*\s*"?([^"\n]+)"?/i) || s3.match(/Name:\*\*\s*([^\n]+)/i);
  return m ? m[1].replace(/"/g, '').trim() : 'Virtual Agent';
}

function parseLanguage(specMd) {
  const s3 = extractSection(specMd, '3');
  const m = s3.match(/Language\(s\):\*\*\s*([^\n·]+)/i);
  const raw = m ? m[1].replace(/_/g, '').trim() : 'English';
  // Specs name a primary language and often a second one the build does not cover
  // ("English, with Spanish noted as a likely second path"). Take the first named.
  const first = (raw.match(/english|spanish|french|german|portuguese|italian|dutch|japanese/i) || ['english'])[0];
  const map = {
    english: 'en-US', spanish: 'es-US', french: 'fr-FR', german: 'de-DE',
    portuguese: 'pt-BR', italian: 'it-IT', dutch: 'nl-NL', japanese: 'ja-JP',
  };
  return map[first.toLowerCase()] || 'en-US';
}

function insightGuidance(specMd) {
  const s2 = extractSection(specMd, '2');
  const s4 = extractSection(specMd, '4');
  const great = s2.match(/Great outcome[^\n]*:\*\*\s*([^\n]+)/i) || s2.match(/Great outcome[^\n]*:\s*([^\n]+)/i);
  const handoff = s4.match(/Hands off[^\n]*when:\*\*\s*([^\n]+)/i) || s4.match(/Hands off[^\n]*when:([^\n]+)/i);
  return {
    reasonForCall: 'Why the customer contacted, in their words; distinguish primary intents from spec §1.',
    // The spec states the ideal outcome; the summary has to say what actually
    // happened, which is only useful next to that yardstick.
    resolution: great
      ? truncate(`What was completed, refused or left open, against what good looks like — ${
        great[1].replace(/\*\*/g, '')}`, 400)
      : 'What was completed, refused, or left open on this contact, including verification failures.',
    actionItems: handoff
      ? truncate(`Best follow-up: ${handoff[1].replace(/\*\*/g, '')}`, 400)
      : 'Single next step for the business or customer: handoff, callback, or none.',
  };
}

function buildEntitiesFromDesign(design) {
  const types = design.types || [];
  const entities = [];
  const traces = [];
  const seen = new Set();

  const add = (label, description, trace) => {
    const finalLabel = truncate(label, LIMIT_LABEL);
    const key = finalLabel.toLowerCase();
    if (seen.has(key) || entities.length >= MAX_ENTITIES) return;
    const finalDesc = truncate(description, LIMIT_DESC);
    if (SECRET_LABEL_RE.test(finalLabel) || SECRET_FIELD_RE.test(finalDesc)) return;
    seen.add(key);
    entities.push({ label: finalLabel, description: finalDesc });
    traces.push({ ...trace, entityLabel: finalLabel });
  };

  // Two passes: what the tools returned earns a slot before what the customer was
  // asked for, so a tool late in the list is not crowded out by the first tool's inputs.
  for (const tool of design.tools || []) {
    const toolName = tool.name || tool.description || 'tool';
    if (tool.type === 'KnowledgeBase' || tool.type === 'KnowledgeSetting') {
      add(
        'Policy topic',
        'General policy or FAQ topic answered from knowledge; not account-specific facts.',
        { entityLabel: 'Policy topic', tool: toolName, source: 'knowledge retrieval', notes: 'Topic only' },
      );
      continue;
    }
    if (tool.type !== 'DataAction') continue;

    const outType = findType(types, tool.output);
    for (const prop of collectOutputProperties(outType)) {
      const label = labelFromField(prop.name, toolName);
      add(
        label,
        descriptionForEntity(label, toolName, `output.${prop.name}`),
        { entityLabel: label, tool: toolName, source: `output.${prop.name}`, notes: prop.description || '' },
      );
    }
  }

  for (const tool of design.tools || []) {
    if (tool.type !== 'DataAction') continue;
    const toolName = tool.name || tool.description || 'tool';
    for (const input of tool.inputs || []) {
      if (!['External', 'User', 'StartContext'].includes(input.source)) continue;
      if (SECRET_FIELD_RE.test(snakeCase(input.targetName))) continue;
      if (IDENTIFIER_FIELD_RE.test(snakeCase(input.targetName))) continue;
      const label = labelFromField(input.targetName, toolName);
      add(
        `${truncate(label, 22)} requested`,
        descriptionForEntity(label, toolName, `input.${input.targetName}`),
        { entityLabel: truncate(`${label} requested`, LIMIT_LABEL), tool: toolName, source: `input.${input.targetName}` },
      );
    }
  }

  const role = String(design.role || '');
  const instructions = (design.instructions || []).join(' ');
  if (/confirm|verif|identity|last name|zip code/i.test(`${role} ${instructions}`)) {
    add(
      'Identity confirmed',
      'Whether the caller confirmed identity (method only); never include PIN, OTP, or codes.',
      { entityLabel: 'Identity confirmed', tool: '(verification gate)', source: 'instructions/guardrails' },
    );
  }

  return { entities, traces };
}

/**
 * The custom prompt is what makes this a summary of *this* assistant rather than a
 * generic one: it names the use cases it was built for, the facts its tools return,
 * and the four ways an AVA conversation can end. `settingType: "Prompt"` means this
 * text, not summaryType/format, governs the output.
 */
function buildPrompt({ avaLabel, useCases, guidance, entities }) {
  const lines = [
    `Summarise a completed conversation between a customer and ${avaLabel}, an automated assistant, `
      + 'for the agent or supervisor who handles the contact next.',
    '',
    'The assistant handles: '
      + useCases.map((u) => u.name.replace(/\s+/g, ' ').trim()).join('; ') + '.',
    '',
    'Write these sections, each with its heading, in this order:',
    `Reason for the call: ${guidance.reasonForCall}`,
    `Outcome: ${guidance.resolution}`,
    `Follow-up: ${guidance.actionItems} Write "None" when nothing is outstanding.`,
  ];
  if (entities.length) {
    lines.push(
      'What the assistant found: one short line for each of these, and nothing else — '
        + entities.map((e) => e.label).join('; ') + '. '
        + 'Take each value from the tool result in this conversation. '
        + 'Omit the line when the conversation does not contain it.',
    );
  }
  lines.push(
    'How the call ended: the customer finished with the assistant, the assistant handed the call to a person '
      + '(name the reason and the queue), a guardrail stopped the call, or the assistant hit an error. '
      + 'Name which one and why.',
    '',
    'Rules: state only what the transcript or a tool result in this conversation contains, and never infer, '
      + 'estimate or carry a value over from an earlier lookup. Do not repeat the identifiers the customer gave '
      + 'to be verified — say whether verification succeeded, not what was said. Use plain language the next '
      + 'person can act on, and keep the whole summary under 200 words.',
  );
  return lines.join('\n');
}

function buildSetting({ specMd, design, sessionName, agentId, avaBuildName, settingType }) {
  const useCases = extractUseCases(specMd);
  const { entities, traces } = buildEntitiesFromDesign(design);
  const avaLabel = avaBuildName || design.name || parseAssistantName(specMd);
  // Named after the assistant, not the customer: these settings are org-wide and
  // often live in a shared lab org where a customer name does not belong.
  const settingName = truncate(`AXL - ${avaLabel} Summary`.replace(/\s+/g, ' ').trim(), 100);
  const guidance = insightGuidance(specMd);
  const type = settingType === 'Basic' ? 'Basic' : 'Prompt';
  const prompt = buildPrompt({ avaLabel, useCases, guidance, entities });

  return {
    _meta: {
      session: sessionName,
      summaryModel: 'summary|reason|outcome|nextBestAction|attributeExtract',
      generatedBy: 'ava-custom-summary/generate-summary-setting.js',
      generatedAt: new Date().toISOString(),
      useCases,
      sources: ['spec-artifact.md', 'design-artifact.json'],
      attributeExtract: traces,
      insightGuidance: guidance,
      assumed: [],
      agent_id: agentId || design._meta?.agent_id || '',
    },
    name: settingName,
    language: parseLanguage(specMd),
    summaryType: 'Detailed',
    format: 'GroupedBulletPoints',
    maskPII: { all: false },
    participantLabels: {
      internal: 'Agent',
      external: 'Customer',
      virtualAgent: parseAssistantName(specMd),
    },
    predefinedInsights: ['ReasonForCall', 'Resolution', 'ActionItems'],
    customEntities: entities,
    settingType: type,
    ...(type === 'Prompt' ? { prompt } : {}),
    serviceType: 'Native',
    timeoutDuration: 20,
  };
}

function main() {
  const args = parseArgs(process.argv);
  let specPath = args.spec;
  let designPath = args.design;
  let outPath = args.out;
  let sessionName = '';

  if (args.sessionDir) {
    sessionName = path.basename(args.sessionDir);
    specPath = specPath || path.join(args.sessionDir, 'spec-artifact.md');
    outPath = outPath || path.join(args.sessionDir, 'summary-setting.json');
  }
  if (args.lifecycleDir) {
    // Once an AVA is published the design artifact is often gone, but the version
    // definition carries the same tools and types and is what actually runs.
    const candidates = [
      path.join(args.lifecycleDir, 'design-artifact.json'),
      path.join(args.lifecycleDir, 'version-definition.json'),
    ];
    designPath = designPath || candidates.find((p) => fs.existsSync(p)) || candidates[0];
  }

  if (!specPath || !fs.existsSync(specPath)) {
    console.error(JSON.stringify({ ok: false, error: 'Missing spec-artifact.md' }));
    process.exit(1);
  }
  if (!designPath || !fs.existsSync(designPath)) {
    console.error(JSON.stringify({ ok: false, error: 'Missing design-artifact.json' }));
    process.exit(1);
  }

  const specMd = readText(specPath);
  const designFile = readJson(designPath);
  // A version definition wraps the design under `definition`; a design artifact is flat.
  const design = designFile.definition && designFile.definition.tools ? designFile.definition : designFile;
  const sagePath = args.lifecycleDir ? path.join(args.lifecycleDir, 'sage-agent.json') : null;
  const agentId = sagePath && fs.existsSync(sagePath) ? readJson(sagePath).agent_id : '';

  const doc = buildSetting({
    specMd,
    design,
    sessionName,
    agentId,
    avaBuildName: design.name,
    settingType: args.settingType,
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    out: outPath,
    entityCount: doc.customEntities.length,
    summaryType: doc.summaryType,
    settingType: doc.settingType,
    promptWords: doc.prompt ? doc.prompt.split(/\s+/).length : 0,
    name: doc.name,
  }, null, 2));
}

if (require.main === module) main();

module.exports = { buildSetting, buildEntitiesFromDesign, buildPrompt };
