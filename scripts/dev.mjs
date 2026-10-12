// Runs the sync server (port 3001) and the Vite dev server (port 5173) together.
import { spawn } from 'node:child_process';

const run = (cmd, args, env = {}) =>
  spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });

const server = run(process.execPath, ['--watch', 'server/index.js'], { PORT: '3001' });
const vite = run('npx', ['vite']);
const stop = () => {
  server.kill();
  vite.kill();
  process.exit();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
