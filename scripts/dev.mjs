// Runs the sync server (port 3001) and the Vite dev server (port 5173) together.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Vite 8 (rolldown) needs Node ^20.19 or >=22.12; older versions crash with a cryptic import error.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 19) || (major === 22 && minor < 12) || major === 21) {
  console.error(`coprod needs Node 20.19+ or 22.12+ (you have ${process.version}). Install a newer Node from https://nodejs.org.`);
  process.exit(1);
}

// Both children are Node scripts, so spawn node directly: no shell, no quoting issues with
// paths like "C:\Program Files\nodejs\node.exe", and kill() reaches the real process.
const run = (args, env = {}) => spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ...env } });

const server = run(['--watch', 'server/index.js'], { PORT: '3001' });
const vite = run([fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))]);
const stop = () => {
  server.kill();
  vite.kill();
  process.exit();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
