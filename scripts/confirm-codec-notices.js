import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { codecRevision } from './codec-source.js';
import { hasCodecConsent, saveCodecConsent } from './codec-consent.js';

if (hasCodecConsent()) {
  console.log('このバージョンのコーデックについては同意済みです。');
  process.exit(0);
}

const root = fileURLToPath(new URL('../', import.meta.url));
let noticeDirectory;
process.once('exit', () => {
  if (!noticeDirectory) return;
  if (dirname(noticeDirectory) !== root.replace(/[\\/]$/, '') || !basename(noticeDirectory).startsWith('.codec-notices-')) return;
  rmSync(noticeDirectory, { recursive: true, force: true });
});
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));

async function readNotice(name) {
  const source = `https://raw.githubusercontent.com/OpenBLIP25/blip25-vocoder/${codecRevision}/${name}`;
  console.log(`${name} を取得しています: ${source}`);
  const response = await fetch(source, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${name} の取得に失敗しました (HTTP ${response.status})。`);
  const contents = await response.text();
  if (!contents.trim()) throw new Error(`${name} が空です。`);
  return { contents, source };
}

try {
  const notices = [];
  for (const name of ['PATENT_NOTICE.md', 'ATTRIBUTION.md']) {
    notices.push({ name, ...await readNotice(name) });
  }
  noticeDirectory = mkdtempSync(join(root, '.codec-notices-'));
  console.log('\n告知文書を保存しました。次のファイルを開いて内容を確認してください。');
  for (const { name, contents, source } of notices) {
    const path = join(noticeDirectory, name);
    writeFileSync(path, contents, 'utf8');
    console.log(`${name}: ${path}\n取得元: ${source}`);
  }
} catch (error) {
  console.error(`告知文書を確認できないため、処理を中止しました: ${error.message}`);
  process.exit(1);
}

console.log('\n上記の PATENT_NOTICE.md 及び ATTRIBUTION.md に記載された免責事項、特許及び出典に関する注意事項を理解し、その内容を了承したうえで本ソフトウェアを利用することに同意しますか？');
console.log('同意し、vocoder の取得・ビルドを続行する場合は yes と入力してください。同意しない場合は no と入力してください。');

if (!process.stdin.isTTY) {
  console.error('対話入力ができないため、処理を中止しました。');
  process.exitCode = 1;
} else {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  input.once('SIGINT', () => process.exit(130));
  let confirmed = false;
  process.stdout.write('[yes/No]: ');
  try {
    for await (const answer of input) {
      confirmed = answer.trim().toLowerCase() === 'yes';
      break;
    }
  } finally {
    input.close();
    process.stdin.pause();
  }
  if (confirmed) {
    try {
      saveCodecConsent();
      console.log('処理を続行します。');
    } catch (error) {
      console.error(`同意記録を保存できないため、処理を中止しました: ${error.message}`);
      process.exitCode = 1;
    }
  } else {
    console.error('処理を中止します。');
    process.exitCode = 1;
  }
  process.stdout.write('', () => process.exit(process.exitCode ?? 0));
}
