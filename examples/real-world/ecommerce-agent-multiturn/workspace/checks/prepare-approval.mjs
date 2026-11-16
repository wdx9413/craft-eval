// Simulates the human approver: writes the approval flag and a completed brief
// with the city the agent asked for in turn 1.
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('state', { recursive: true });
writeFileSync('state/approved.flag', 'approved-by-human');
writeFileSync('state/brief.json', JSON.stringify({ delivery_city: 'Shanghai' }, null, 2));
