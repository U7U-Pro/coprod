// Set a new password for an account, for whoever runs the server (accounts
// have no email, so there's no "forgot password" link). Stop the server first:
// it keeps accounts in memory and would write over this change.
//
//   node scripts/reset-password.mjs ana
//   COPROD_DATA=/srv/coprod node scripts/reset-password.mjs @ana

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Db } from '../server/db.js';
import { hashPassword, cleanUsername } from '../server/auth.js';

const username = cleanUsername(process.argv[2]);
if (!username) {
  console.error('Usage: node scripts/reset-password.mjs <username>');
  process.exit(1);
}
const dataDir = process.env.COPROD_DATA ?? fileURLToPath(new URL('../data', import.meta.url));
const db = await Db.open(join(dataDir, 'coprod.json'));
const user = db.userByUsername(username);
if (!user || user.guest) {
  console.error(`No account @${username} in ${dataDir}`);
  process.exit(1);
}
const password = randomBytes(9).toString('base64url');
db.updateUser(user.id, { pass: await hashPassword(password) });
db.endSessions(user.id); // signed out everywhere
await db.flush();
console.log(`New password for ${user.name} (@${user.username}): ${password}\nThey can change it under their profile once they're signed in.`);
