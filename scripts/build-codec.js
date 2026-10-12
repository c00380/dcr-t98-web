import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { codecRevision as revision } from './codec-source.js';
const root = fileURLToPath(new URL('../', import.meta.url));
function run(program, args, capture = false) {
  const result = spawnSync(program, args, {
    cwd: root,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout?.trim();
}
if (!existsSync(new URL('../vendor/blip25-vocoder/', import.meta.url))) {
  run('git', [
    'clone',
    'https://github.com/OpenBLIP25/blip25-vocoder.git',
    'vendor/blip25-vocoder',
  ]);
}
const vendorArgs = ['-C', 'vendor/blip25-vocoder'];
if (run('git', [...vendorArgs, 'status', '--porcelain'], true)) {
  console.error('vendor/blip25-vocoder has local changes. Save or revert them before building.');
  process.exit(1);
}
if (run('git', [...vendorArgs, 'rev-parse', 'HEAD'], true) !== revision) {
  const available = spawnSync('git', [...vendorArgs, 'cat-file', '-e', `${revision}^{commit}`], {
    cwd: root,
    stdio: 'ignore',
  });
  if (available.error) throw available.error;
  if (available.status !== 0) run('git', [...vendorArgs, 'fetch', 'origin', revision]);
  run('git', [...vendorArgs, 'checkout', '--detach', revision]);
}
run('wasm-pack', ['build', 'codec', '--release', '--target', 'web', '--out-dir', '../web/codec', '--', '--locked']);

rmSync(new URL('../web/codec/.gitignore', import.meta.url), { force: true });
