'use strict';

const fs = require('fs');
const path = require('path');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function row(label, value) {
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

function list(items) {
  if (!items || !items.length) return '<p class="muted">None.</p>';
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

/**
 * Facilitator-facing summary of what the skill did to the org.
 * Never embeds credentials; ids only.
 */
function writeHandoff(sessionDir, { plan, org, applied, tracking, flowJob, flowMeta, program, verification, warnings }) {
  const outPath = path.join(path.resolve(sessionDir), 'bot-flow-handoff.html');
  const title = `AVA bot flow — ${plan?.botFlow?.name || 'unnamed'}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
 body{font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;margin:2rem auto;max-width:60rem;color:#15202b}
 h1{font-size:1.5rem;margin-bottom:.25rem} h2{font-size:1.1rem;margin-top:2rem}
 table{border-collapse:collapse;width:100%;margin:.5rem 0} th,td{border:1px solid #d7dde3;padding:.45rem .6rem;text-align:left;vertical-align:top}
 th{background:#f4f7fa;width:16rem;font-weight:600} .muted{color:#6b7a88}
 .badge{display:inline-block;padding:.1rem .5rem;border-radius:.6rem;font-size:.8rem;background:#e7f0ff;color:#14467c}
 .warn{background:#fff4e5;border:1px solid #f0c38a;padding:.6rem .8rem;border-radius:.4rem}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p class="muted">${escapeHtml(org?.orgName || 'unknown org')} (${escapeHtml(org?.orgId || '')}) —
<span class="badge">${applied ? 'applied' : 'plan only'}</span> — generated ${escapeHtml(new Date().toISOString())}</p>

<h2>Bot flow</h2>
<table>
${row('Name', plan?.botFlow?.name)}
${row('Flow id', flowMeta?.flowId || flowJob?.flowId || '(not created)')}
${row('Published version', flowMeta?.publishedVersion || '(none)')}
${row('Starting action', `Call Agentic Virtual Agent — ${plan?.ava?.name || ''}`)}
${row('Starting audio', plan?.botFlow?.audioProfile === 'silent' ? 'None (silent start)' : 'Default playback timings')}
${row('Processing prompt', 'Off (voiceProcessingPrompt = noValue)')}
${row('Exit reason variable', plan?.ava?.exitReasonVariable || '(unmapped)')}
${row('Default escalation queue', plan?.escalation?.defaultQueue)}
</table>

<h2>Outcome and milestones</h2>
<table>
${row('Flow outcome', `${tracking?.outcome?.name || '(none)'} — ${tracking?.outcome?.action || 'n/a'} ${tracking?.outcome?.id || ''}`)}
${(tracking?.milestones || []).map((milestone) => row(`Milestone (${milestone.position} AVA)`, `${milestone.name} — ${milestone.action} ${milestone.id || ''}`)).join('\n')}
</table>

<h2>After Contact</h2>
<table>
${row('Conversation summary', plan?.afterContact?.summarization === false ? 'Off' : 'On')}
${row('Summary setting', plan?.afterContact?.summarySetting?.name
    ? `${plan.afterContact.summarySetting.name} (${plan.afterContact.summarySetting.id || 'no id'})`
    : '(org default)')}
${row('Setting bound in published flow', verification?.constructs
    ? (verification.constructs.summarySettingBound ? 'Yes — confirmed by re-export' : 'No — the flow is on the org default')
    : 'Not verified')}
${row('Wrap-up codes enabled', String((plan?.afterContact?.wrapUpCodes || []).length))}
</table>
${list(plan?.afterContact?.wrapUpCodes)}

<h2>Escalation routing</h2>
<table>
${(plan?.escalation?.routes || []).map((route) => row(`AVA value "${route.match}"`, `Transfer to ACD → ${route.queue}`)).join('\n')}
${row('Fallback', `Transfer to ACD → ${plan?.escalation?.defaultQueue}`)}
</table>

<h2>Speech and Text Analytics</h2>
<table>
${row('Program', program ? `${program.programName} (${program.programId})` : '(not mapped)')}
${row('Flow mapped', program ? (program.alreadyMapped ? 'Already present' : (program.applied ? 'Added' : 'Planned')) : 'No')}
${row('Publish job', program?.publishJob ? `${program.publishJob.jobId} — ${program.publishJob.state}` : 'n/a')}
</table>

<h2>Architect job</h2>
<table>
${row('Status', flowJob?.status || '(not run)')}
${row('Job id', flowJob?.jobId || '')}
</table>
${list(flowJob?.messages)}

<h2>Round-trip verification</h2>
${verification ? `<table>
${row('Re-export checked', verification.checkedAt || '')}
${Object.entries(verification.constructs || {}).map(([key, value]) => row(key, value ? 'present in published YAML' : 'NOT present — configure in Architect')).join('\n')}
</table>` : '<p class="muted">Not run. Run the verify command after publishing.</p>'}

<h2>Warnings and manual steps</h2>
${(warnings || []).length ? `<div class="warn">${list(warnings)}</div>` : '<p class="muted">None.</p>'}
</body></html>
`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  return outPath;
}

module.exports = { writeHandoff };
