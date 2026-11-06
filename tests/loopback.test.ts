import assert from 'node:assert/strict';
import test from 'node:test';
import { probeLoopback } from '../src/loopback.js';

test('probeLoopback reports a successful bind and close', async () => {
  const result = await probeLoopback(() => ({
    once: () => undefined,
    listen: (_options, listening) => listening(),
    close: closed => closed(),
  }));
  assert.equal(result, true);
});

test('probeLoopback reports a bind error', async () => {
  const result = await probeLoopback(() => ({
    once: (_event, failed) => failed(new Error('bind failed')),
    listen: () => undefined,
    close: () => undefined,
  }));
  assert.equal(result, false);
});

test('probeLoopback reports a close error', async () => {
  const result = await probeLoopback(() => ({
    once: () => undefined,
    listen: (_options, listening) => listening(),
    close: closed => closed(new Error('close failed')),
  }));
  assert.equal(result, false);
});
