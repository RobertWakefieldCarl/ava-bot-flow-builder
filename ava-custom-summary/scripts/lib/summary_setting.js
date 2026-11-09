'use strict';

const fs = require('fs');

/** Assigned by the platform; rejected or ignored on write. */
const READ_ONLY_FIELDS = ['id', 'dateCreated', 'dateModified', 'interactionType', 'selfUri'];

const INSIGHTS = ['ReasonForCall', 'Resolution', 'ActionItems'];
const SUMMARY_TYPES = ['Concise', 'Detailed'];
const FORMATS = ['TextBlock', 'BulletPoints', 'GroupedTextBlocks', 'GroupedBulletPoints'];
const GROUPED_FORMATS = ['GroupedTextBlocks', 'GroupedBulletPoints'];
const SETTING_TYPES = ['Basic', 'Prompt'];
const SERVICE_TYPES = ['Native', 'External'];

/**
 * Server-enforced limits. Confirmed empirically against the preview endpoint; none of these
 * appear in the published API definition. See references/platform-api.md.
 */
const LIMITS = Object.freeze({
  name: 100,
  entityLabel: 30,
  entityDescription: 120,
  participantLabel: 30,
  maxEntities: 10,
});

/** Past this the summary reads as a form rather than a summary. Advisory, not enforced. */
const ENTITY_SOFT_CAP = 6;

/** Entity labels that restate a predefined insight, which makes the model emit it twice. */
const INSIGHT_SYNONYMS = [
  'reason', 'reason for call', 'reason for contact', 'call reason', 'why they called',
  'resolution', 'outcome', 'outcome of call', 'call outcome', 'result', 'how it was resolved',
  'action items', 'actions', 'follow up', 'follow-up', 'followup', 'next steps', 'next step',
  'next best action', 'next best actions', 'recommended action', 'todo', 'to do', 'tasks',
  'summary', 'call summary', 'executive summary', 'interaction summary',
];

/** Things an assistant must never collect, so must never be asked to summarise. */
const SECRET_TERMS = [
  'pin', 'otp', 'one-time passcode', 'one time passcode', 'cvv', 'cvc', 'security code',
  'password', 'passcode', 'full card', 'card number', 'social security', 'ssn',
  'account password', 'secret answer', 'api key', 'bearer token',
];

/** Entity labels that will be redacted when maskPII.all is true. */
const IDENTIFIER_TERMS = [
  'name', 'address', 'phone', 'email', 'date of birth', 'dob', 'policy number',
  'account number', 'member id', 'claim number', 'order number', 'customer id', 'nhs number',
  'patient id', 'postcode', 'zip',
];

function containsTerm(text, terms) {
  const haystack = String(text || '').toLowerCase();
  return terms.find((t) => haystack.includes(t));
}

function normaliseLabel(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Read a summary-setting artifact. `_meta` is provenance for the session folder and is
 * stripped before the payload ever reaches the API.
 */
function read(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${filePath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${filePath} is not valid JSON: ${err.message}`);
  }
  const meta = parsed._meta || null;
  const setting = { ...parsed };
  delete setting._meta;
  for (const field of READ_ONLY_FIELDS) delete setting[field];
  return { meta, setting };
}

/**
 * Validate a setting against the API contract and the authoring rules in
 * references/spec-to-summary-mapping.md.
 *
 * Errors block a write. Warnings are judgement calls that must be surfaced, not silently
 * accepted — the caller reports them and the facilitator decides.
 */
function validate(setting, meta) {
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);

  if (!setting.name || !String(setting.name).trim()) E('name is required.');
  else if (setting.name.length > LIMITS.name) {
    E(`name is ${setting.name.length} characters; the platform allows at most ${LIMITS.name}.`);
  }
  if (!setting.language || !String(setting.language).trim()) {
    E('language is required, e.g. "en-US".');
  } else if (!/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/i.test(setting.language)) {
    W(`language "${setting.language}" is not a BCP-47 tag like "en-US". The platform may not accept it.`);
  }

  for (const [field, allowed] of [
    ['summaryType', SUMMARY_TYPES], ['format', FORMATS],
    ['settingType', SETTING_TYPES], ['serviceType', SERVICE_TYPES],
  ]) {
    if (setting[field] !== undefined && !allowed.includes(setting[field])) {
      E(`${field} must be one of ${allowed.join(' | ')} (got "${setting[field]}").`);
    }
  }

  if (setting.maskPII !== undefined && typeof (setting.maskPII || {}).all !== 'boolean') {
    E('maskPII.all is required when maskPII is present, and must be a boolean.');
  }

  // The three sections are the whole point of this skill.
  const insights = setting.predefinedInsights || [];
  const unknown = insights.filter((i) => !INSIGHTS.includes(i));
  if (unknown.length) E(`predefinedInsights contains unsupported values: ${unknown.join(', ')}. Allowed: ${INSIGHTS.join(' | ')}.`);
  const missing = INSIGHTS.filter((i) => !insights.includes(i));
  if (missing.length) {
    E(`predefinedInsights is missing ${missing.join(', ')}. An AXL summary must carry all three: `
      + 'ReasonForCall (reason for the call), Resolution (outcome of the call), ActionItems (next best action).');
  }

  if (setting.settingType === 'Prompt') {
    if (!setting.prompt || !String(setting.prompt).trim()) {
      E('settingType is "Prompt" but no prompt was supplied.');
    } else {
      const p = String(setting.prompt).toLowerCase();
      const absent = [
        !/reason/.test(p) && 'the reason for the call',
        !/(outcome|resol)/.test(p) && 'the outcome',
        !/(follow|action|next step|next best)/.test(p) && 'any next best action',
      ].filter(Boolean);
      if (absent.length) {
        W(`settingType is "Prompt", so the prompt governs the output, but it does not mention ${absent.join(', ')}. `
          + 'Those sections will be missing even though predefinedInsights requests them.');
      }
      W('settingType "Prompt" means this text, not summaryType and format, decides what the summary says. '
        + 'That is what makes it specific to this assistant, and also why it varies more between interactions than '
        + '"Basic" does. Read the prompt before accepting the setting.');
    }
  } else if (setting.prompt) {
    W('A prompt is present but settingType is not "Prompt", so the prompt is ignored.');
  }

  if (setting.serviceType === 'External' && !String(setting.integrationId || '').trim()) {
    E('serviceType is "External" but integrationId is empty. External summarisation needs the backing integration id.');
  }

  if (insights.length && setting.format && !GROUPED_FORMATS.includes(setting.format)) {
    W(`format "${setting.format}" is ungrouped, so reason, outcome and next best action will run together `
      + `without headings. Use ${GROUPED_FORMATS.join(' or ')} to keep the sections legible.`);
  }

  for (const side of ['internal', 'external', 'virtualAgent']) {
    const value = (setting.participantLabels || {})[side];
    if (value && String(value).length > LIMITS.participantLabel) {
      E(`participantLabels.${side} is ${value.length} characters; the platform allows at most ${LIMITS.participantLabel}.`);
    }
  }

  const masked = Boolean(setting.maskPII && setting.maskPII.all);
  const entities = setting.customEntities || [];
  const seen = new Map();
  entities.forEach((entity, i) => {
    const at = `customEntities[${i}]`;
    if (!entity || typeof entity !== 'object') { E(`${at} must be an object with label and description.`); return; }
    if (!entity.label || !String(entity.label).trim()) E(`${at} is missing a label.`);
    else if (entity.label.length > LIMITS.entityLabel) {
      E(`${at} label is ${entity.label.length} characters; the platform allows at most ${LIMITS.entityLabel}. ("${entity.label}")`);
    }
    if (!entity.description || !String(entity.description).trim()) {
      E(`${at} ("${entity.label || '?'}") is missing a description. The description is what tells the model what to extract.`);
    } else if (entity.description.length > LIMITS.entityDescription) {
      E(`${at} ("${entity.label}") has a ${entity.description.length}-character description; the platform allows at most `
        + `${LIMITS.entityDescription}. Say what to extract and where it comes from, and stop there.`);
    }

    const key = normaliseLabel(entity.label);
    if (key && seen.has(key)) E(`${at} duplicates the label of customEntities[${seen.get(key)}] ("${entity.label}").`);
    else if (key) seen.set(key, i);

    if (INSIGHT_SYNONYMS.includes(key)) {
      E(`${at} label "${entity.label}" restates a predefined insight. `
        + 'Reason, outcome and next best action are already covered by predefinedInsights; a custom entity for them makes the model emit the same content twice.');
    }

    const secret = containsTerm(`${entity.label} ${entity.description}`, SECRET_TERMS);
    if (secret) {
      E(`${at} mentions "${secret}". The assistant never collects secrets, so the summary must never ask for one. `
        + 'Capture that verification happened, not what was given.');
    }

    if (masked) {
      const ident = containsTerm(entity.label, IDENTIFIER_TERMS);
      if (ident) {
        W(`${at} ("${entity.label}") looks like an identifier but maskPII.all is true, so it will be redacted and the line will come out empty. `
          + 'Either turn masking off (only defensible on fabricated data) or make the entity non-identifying.');
      }
    }
  });

  if (entities.length > LIMITS.maxEntities) {
    E(`${entities.length} custom entities; the platform allows at most ${LIMITS.maxEntities} per configuration.`);
  } else if (entities.length > ENTITY_SOFT_CAP) {
    W(`${entities.length} custom entities. Past ${ENTITY_SOFT_CAP} the summary reads as a form, not a summary `
      + `(the platform's hard limit is ${LIMITS.maxEntities}). Keep the ones a supervisor would act on.`);
  }
  if (!entities.length) {
    W('No custom entities, so the summary will carry the four narrative sections but no attribute extract from AVA tools. '
      + 'Derive entities from design-artifact.json tools/types (see references/tool-attribute-extract.md) or spec-artifact §5.');
  }

  if (meta && Array.isArray(meta.attributeExtract) && meta.attributeExtract.length) {
    const labels = new Set(entities.map((e) => normaliseLabel(e.label)));
    for (const row of meta.attributeExtract) {
      const key = normaliseLabel(row.entityLabel);
      if (key && !labels.has(key)) {
        W(`_meta.attributeExtract references entity "${row.entityLabel}" but customEntities has no matching label.`);
      }
    }
  } else if (entities.length) {
    W('_meta.attributeExtract is empty. Record tool → entity mapping so attribute extract stays traceable when the AVA changes.');
  }

  if (!meta || !Array.isArray(meta.useCases) || !meta.useCases.length) {
    W('_meta.useCases is empty. Record which chosen use cases this setting was built from so the readout and the next session can trace it.');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Field-level diff for the confirmation plan, since PUT replaces the whole record. */
function diff(current, next) {
  const changes = [];
  const keys = new Set([...Object.keys(current || {}), ...Object.keys(next || {})]);
  for (const key of keys) {
    if (READ_ONLY_FIELDS.includes(key)) continue;
    const before = (current || {})[key];
    const after = (next || {})[key];
    const b = JSON.stringify(before);
    const a = JSON.stringify(after);
    if (b === a) continue;
    changes.push({
      field: key,
      before: before === undefined ? null : before,
      after: after === undefined ? null : after,
      erased: after === undefined && before !== undefined,
    });
  }
  return changes;
}

module.exports = {
  READ_ONLY_FIELDS,
  INSIGHTS,
  LIMITS,
  read,
  validate,
  diff,
};
