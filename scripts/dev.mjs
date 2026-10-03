import { spawn } from 'node:child_process';
const env = { ...process.env, DEMO_MODE: process.env.DEMO_MODE ?? 'true', NEXT_TELEMETRY_DISABLED: '1' };
const children = [];
function run(args) {
  const p = spawn(process.execPath, args, { stdio: 'inherit', env, windowsHide: true });
  children.push(p);
  return p;
}
const compiler = run(['--import', 'tsx', 'scripts/compile-content.ts']);
await new Promise((resolve, reject) => {
  compiler.once('error', reject);
  compiler.once('exit', (code) =>
    code === 0 ? resolve() : reject(new Error('Не удалось подготовить пакеты правил')),
  );
});
console.log('Демонстрационное приложение: http://127.0.0.1:3000 · остановка Ctrl+C');
const api = run(['--import', 'tsx', 'apps/api/src/server.ts']);
const web = run(['node_modules/next/dist/bin/next', 'dev', 'apps/web', '--hostname', '127.0.0.1']);
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}
for (const p of [api, web]) {
  p.on('error', (e) => {
    console.error(e);
    process.exitCode = 1;
    stop();
  });
  p.on('exit', (code) => {
    if (!closing) {
      process.exitCode = code ?? 1;
      stop();
    }
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
