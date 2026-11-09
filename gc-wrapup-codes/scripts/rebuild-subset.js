#!/usr/bin/env node
'use strict';

// Regenerates the allowlisted subset from the already-pinned full definition.
// Unlike refresh-openapi.js this performs no download, so upstream provenance
// (source, fetchedAt, full-definition hash) is preserved exactly.

const fs = require('fs');
const path = require('path');

const { OPERATION_IDS, buildSubset, sha256 } = require('./refresh-openapi');

const openapiDir = path.resolve(__dirname, '..', 'references', 'openapi');
const metadataPath = path.join(openapiDir, 'metadata.json');

function main() {
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const fullPath = path.join(openapiDir, metadata.full.file);
  const fullBuffer = fs.readFileSync(fullPath);
  if (sha256(fullBuffer) !== metadata.full.sha256) {
    throw new Error('Pinned full definition does not match its recorded hash; refresh instead of rebuilding.');
  }

  const subset = buildSubset(JSON.parse(fullBuffer.toString('utf8')));
  const subsetBuffer = Buffer.from(`${JSON.stringify(subset, null, 2)}\n`);
  fs.writeFileSync(path.join(openapiDir, metadata.subset.file), subsetBuffer);

  metadata.subset = {
    ...metadata.subset,
    bytes: subsetBuffer.length,
    sha256: sha256(subsetBuffer),
    operations: OPERATION_IDS.length,
    definitions: Object.keys(subset.definitions || {}).length,
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, subset: metadata.subset }, null, 2)}\n`);
}

main();
