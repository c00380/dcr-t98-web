import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codecRevision } from './codec-source.js';

const receiptPath = new URL('../.codec-consent.json', import.meta.url);

export function hasCodecConsent() {
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    return receipt?.version === 1 && receipt.accepted === true && receipt.codecRevision === codecRevision;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

export function saveCodecConsent() {
  writeFileSync(receiptPath, JSON.stringify({
    version: 1,
    accepted: true,
    codecRevision,
    acceptedAt: new Date().toISOString(),
    notices: ['PATENT_NOTICE.md', 'ATTRIBUTION.md'],
  }, null, 2) + '\n', 'utf8');
}

export function ensureCodecConsent() {
  if (hasCodecConsent()) return;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./confirm-codec-notices.js', import.meta.url))], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (!hasCodecConsent()) throw new Error('コーデックの同意記録を確認できません。');
}
