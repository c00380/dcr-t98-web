import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const codec = spawnSync(process.execPath, ['scripts/build-codec.js'], {
  cwd: root,
  stdio: 'inherit',
});
if (codec.error) throw codec.error;
if (codec.status !== 0) process.exit(codec.status ?? 1);
if (!['dcr_codec.js', 'dcr_codec_bg.wasm'].every((name) => existsSync(`web/codec/${name}`))) {
  console.error('Codec build did not produce both JavaScript and WASM files.');
  process.exit(1);
}
await build({
  stdin: { contents: "export { default } from 'fft.js';", resolveDir: process.cwd() },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  outfile: 'web/lib/fft.js',
});
copyFileSync('node_modules/fft.js/README.md', 'web/lib/fft.README.md');
await build({
  stdin: {
    contents: "export { RTL2832U_Provider } from '@jtarrio/webrtlsdr/rtlsdr.js';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  banner: {
    js: '// Web RTL-SDR: Copyright 2024 Jacobo Tarrio Barreiro; Copyright 2013 Google Inc.\n// Apache-2.0; see webrtlsdr.LICENSE.',
  },
  outfile: 'web/lib/rtlsdr.js',
});
copyFileSync('node_modules/@jtarrio/webrtlsdr/LICENSE', 'web/lib/webrtlsdr.LICENSE');
await build({
  entryPoints: readdirSync('web').filter((name) => name.endsWith('.js')).map((name) => `web/${name}`),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outdir: 'web/.build-check',
  write: false,
});
console.log('Build complete: codec, libraries, and application modules checked.');
