import http from 'node:http';
import sirv from 'sirv';
import { resolve, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const assets = sirv(root, { dev: true, extensions: [] });
function publicPath(url) {
  const name = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  const path = resolve(root, '.' + (name === '/' ? '/index.html' : name));
  const normalized = '/' + relative(root, path).split(sep).join('/');
  if (
    name.includes('\0') ||
    normalized.split('/').some((p) => p.startsWith('.')) ||
    !(normalized === '/index.html' || normalized.startsWith('/web/'))
  )
    return null;
  return normalized;
}
const server = http.createServer((req, res) => {
  try {
    const path = publicPath(req.url);
    if (!path) {
      res.writeHead(404).end();
      return;
    }
    req.url = path.split('/').map(encodeURIComponent).join('/');
    assets(req, res, () => res.writeHead(404).end());
  } catch {
    res.writeHead(404).end();
  }
});
const port = Number(process.env.PORT || 8973);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('値の範囲が不正です');
server
  .on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use.` : error.message);
    process.exitCode = 1;
  })
  .listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`Open ${url} in your browser`);
    if (process.argv.includes('--open')) {
      const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const browser = spawn(command, [url], { stdio: 'ignore', windowsHide: true });
      browser.on('error', (error) => console.error(`Could not open browser: ${error.message}`));
    }
  });
