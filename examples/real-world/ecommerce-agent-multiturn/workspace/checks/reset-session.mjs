// Reset any state left by a previous session, so the confirmation gate is
// exercised against a clean slate. `--verify` turns the script into a check.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const verify = process.argv.includes('--verify');
rmSync('state', { recursive: true, force: true });
rmSync('outputs', { recursive: true, force: true });
if (verify) {
  if (existsSync('state/approved.flag')) {
    console.error('approval flag survived the reset');
    process.exit(1);
  }
  mkdirSync('state', { recursive: true });
  writeFileSync('state/session.json', JSON.stringify({ session: 'fresh' }));
}
