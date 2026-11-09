'use strict';

/**
 * Generate wrap-up-codes.json (15–20) from AXL spec-artifact + design-artifact.
 *
 * Usage:
 *   node generate-wrap-up-catalog.js --session-dir <axl-sessions/AXL-x> [--lifecycle-dir <path>]
 *   node generate-wrap-up-catalog.js --spec <spec-artifact.md> [--design <design-artifact.json>] --out <file>
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {
    sessionDir: null,
    lifecycleDir: null,
    spec: null,
    design: null,
    out: null,
    min: 15,
    max: 20,
    target: 18,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--session-dir' && argv[i + 1]) out.sessionDir = path.resolve(argv[++i]);
    else if (a === '--lifecycle-dir' && argv[i + 1]) out.lifecycleDir = path.resolve(argv[++i]);
    else if (a === '--spec' && argv[i + 1]) out.spec = path.resolve(argv[++i]);
    else if (a === '--design' && argv[i + 1]) out.design = path.resolve(argv[++i]);
    else if (a === '--out' && argv[i + 1]) out.out = path.resolve(argv[++i]);
    else if (a === '--min' && argv[i + 1]) out.min = Number(argv[++i]);
    else if (a === '--max' && argv[i + 1]) out.max = Number(argv[++i]);
    else if (a === '--target' && argv[i + 1]) out.target = Number(argv[++i]);
  }
  return out;
}

function readText(p) {
  return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
}

function readJsonSafe(p) {
  if (!p || !fs.existsSync(p)) return null;
  return JSON.parse(readText(p));
}

function slugTopic(text) {
  const t = String(text || '')
    .replace(/\*\*/g, '')
    // Strip the spec's provenance markers — _(assumed)_, _(researched)_ — not, as this
    // once did, every one of the letters in them.
    .replace(/_?\((assumed|researched)[^)]*\)_?/gi, '')
    .replace(/^In one sentence:\s*/i, '')
    .replace(/[_*]/g, '')
    .trim()
    .slice(0, 48);
  const words = t.split(/\s+/).slice(0, 4).join(' ');
  return words || 'Use case';
}

function extractSection(md, headingPrefix) {
  // `$` under /m matches every line ending, so the lazy body has to be terminated by
  // the next heading or true end-of-input. Without the lookahead the section comes
  // back empty and the catalogue falls through to its generic codes.
  const re = new RegExp(`^##\\s+${headingPrefix}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'im');
  const m = md.match(re);
  return m ? m[1] : '';
}

function extractUseCaseLabels(specMd) {
  const labels = [];
  const s1 = extractSection(specMd, '1\\.');
  const bullets = s1.match(/^-\s+\*\*[^*]+\*\*:[^\n]+/gm) || s1.match(/^-\s+[^\n]+/gm) || [];
  for (const b of bullets) {
    const one = b.replace(/^-\s+/, '').replace(/\*\*/g, '').trim();
    if (one.length > 10 && !/not today|parked/i.test(one)) labels.push(slugTopic(one));
  }
  const sentence = s1.match(/In one sentence:\*\*[^\n]+/i) || s1.match(/In one sentence:[^\n]+/i);
  if (sentence) {
    const s = sentence[0].replace(/.*sentence:\*?\*?\s*/i, '').trim();
    if (s) labels.unshift(slugTopic(s));
  }
  return [...new Set(labels)].slice(0, 6);
}

function extractTools(design) {
  if (!design || !Array.isArray(design.tools)) return [];
  return design.tools.map((t) => t.name || t.id).filter(Boolean);
}

function hasVerification(specMd, design) {
  const s4 = extractSection(specMd, '4\\.');
  if (/verif|confirm|PIN|OTP|identity/i.test(s4)) return true;
  if (design?.tools?.some((t) => /verif|auth|otp|pin/i.test(String(t.name)))) return true;
  return false;
}

function hasKnowledge(specMd, design) {
  if (/Knowledge:\*\*\s*Yes/i.test(specMd) || /Knowledge:\s*Yes/i.test(specMd)) return true;
  if (design?.tools?.some((t) => /knowledge|kb/i.test(String(t.name)))) return true;
  return false;
}

function code(name, description, mapsTo) {
  return { name, description, mapsTo: mapsTo || undefined };
}

function buildCatalog({ specMd, design, sessionName, agentId }) {
  const useCases = extractUseCaseLabels(specMd);
  const tools = extractTools(design);
  const codes = [];
  const push = (c) => {
    if (!codes.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) codes.push(c);
  };

  if (hasVerification(specMd, design)) {
    push(code('Auth - Verified', 'Customer identity was verified on this contact.', { useCase: 'Authentication', avaOutcome: 'verified' }));
    push(code('Auth - Failed', 'Identity verification failed; no sensitive data was disclosed.', { useCase: 'Authentication', avaOutcome: 'failed' }));
    push(code('Auth - Abandoned', 'Customer ended contact before completing verification.', { useCase: 'Authentication', avaOutcome: 'abandoned' }));
  }

  for (const uc of useCases) {
    const short = uc.length > 32 ? uc.slice(0, 32).trim() : uc;
    push(code(`${short} - Completed`, `${uc} was completed successfully in the virtual agent.`, { useCase: uc, avaOutcome: 'goal met', tools: tools.slice(0, 2) }));
    push(code(`${short} - Not completed`, `${uc} was started but not completed on this contact.`, { useCase: uc, avaOutcome: 'incomplete' }));
  }

  if (hasKnowledge(specMd, design)) {
    push(code('KB - Policy answered', 'Customer policy or FAQ question was answered from knowledge.', { useCase: 'Knowledge', tools: tools.filter((t) => /knowledge|kb/i.test(t)).slice(0, 1) }));
    push(code('KB - No answer', 'Knowledge did not contain the answer; customer was offered escalation.', { useCase: 'Knowledge', avaOutcome: 'gap' }));
  }

  push(code('Escalation - Live agent', 'Customer was transferred or queued to a live agent.', { useCase: 'Escalation' }));
  push(code('Escalation - Callback', 'Callback was promised; issue was not fully resolved on contact.', { useCase: 'Escalation', avaOutcome: 'callback' }));
  push(code('Resolved - Self service', 'Customer need was met entirely in the virtual agent.', { useCase: 'Resolution', avaOutcome: 'self service' }));
  push(code('Refusal - Policy', 'Request was refused per policy without disclosing restricted data.', { useCase: 'Policy', avaOutcome: 'refused' }));
  push(code('Out of scope', 'Request was outside virtual agent capabilities.', { useCase: 'Operational', avaOutcome: 'out of scope' }));
  push(code('Error - System', 'Tool or system error prevented completing the request.', { useCase: 'Operational', avaOutcome: 'error' }));
  push(code('Wrong number / misdial', 'Caller was not the intended customer or wrong department.', { useCase: 'Operational' }));

  // Spec §1 is prose, so a label cut to four words can come out as a sentence
  // fragment. Those codes are unusable as written; name them rather than ship them.
  const fragments = codes
    .filter((c) => /\b(that|we|all|the|a|an|of|for|with|and|or|to|is|in|on)\s*(-|$)/i.test(c.name.split(' - ')[0]))
    .map((c) => c.name);

  return {
    _meta: {
      session: sessionName || '',
      agent_id: agentId || '',
      codeCount: codes.length,
      ...(fragments.length ? {
        needsCuration: [`Rename before creating — these came out as sentence fragments from spec §1: ${
          [...new Set(fragments)].join('; ')}`],
      } : {}),
      generatedBy: 'ava-wrap-up-codes/generate-wrap-up-catalog.js',
      generatedAt: new Date().toISOString(),
      sources: ['spec-artifact.md', design ? 'design-artifact.json' : null].filter(Boolean),
      targetQueues: 'support,sales (default discover-target-queues pattern)',
    },
    codes,
  };
}

function trimToTarget(catalog, min, max, target) {
  let { codes } = catalog;
  while (codes.length > max) {
    const idx = codes.findIndex((c) => /Not completed|Misdial|Wrong number/i.test(c.name));
    if (idx >= 0) codes.splice(idx, 1);
    else codes.pop();
  }
  if (codes.length < min) {
    // Padding to the minimum used to repeat one filler code, which gave the assistant
    // nothing to choose between. A short catalogue is a spec that did not describe
    // enough distinct outcomes; say so and let the author add real ones.
    catalog._meta.shortfall = min - codes.length;
    catalog._meta.needsCuration = (catalog._meta.needsCuration || []).concat(
      `${min - codes.length} short of the ${min}-code minimum. Add codes for outcomes the spec names `
      + 'that this generator could not infer; do not pad with a generic code.',
    );
  }
  if (codes.length > target && codes.length <= max) {
    /* keep as-is within band */
  }
  catalog._meta.codeCount = codes.length;
  return catalog;
}

function main() {
  const args = parseArgs(process.argv);
  let specPath = args.spec;
  let designPath = args.design;
  let outPath = args.out;
  let sessionName = '';

  if (args.sessionDir) {
    specPath = specPath || path.join(args.sessionDir, 'spec-artifact.md');
    outPath = outPath || path.join(args.sessionDir, 'wrap-up-codes.json');
    sessionName = path.basename(args.sessionDir);
  }

  if (!specPath || !fs.existsSync(specPath)) {
    console.error(JSON.stringify({ ok: false, error: 'Missing spec-artifact.md; pass --session-dir or --spec' }));
    process.exit(1);
  }

  let agentId = '';
  if (args.lifecycleDir) {
    // After publish the design artifact is often gone; the version definition carries
    // the same tools and is what actually runs.
    designPath = designPath || [
      path.join(args.lifecycleDir, 'design-artifact.json'),
      path.join(args.lifecycleDir, 'version-definition.json'),
    ].find((p) => fs.existsSync(p));
    const sage = path.join(args.lifecycleDir, 'sage-agent.json');
    agentId = readJsonSafe(sage)?.agent_id || '';
  }

  const specMd = readText(specPath);
  const designFile = readJsonSafe(designPath);
  // A version definition wraps the design under `definition`; a design artifact is flat.
  const design = designFile?.definition?.tools ? designFile.definition : designFile;
  let catalog = buildCatalog({ specMd, design, sessionName, agentId });
  catalog = trimToTarget(catalog, args.min, args.max, args.target);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    out: outPath,
    codeCount: catalog.codes.length,
    needsCuration: catalog._meta.needsCuration || [],
  }, null, 2));
}

main();
