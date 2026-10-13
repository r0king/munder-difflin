'use strict';

// The Workspace budget's "default token cap per agent": the breaker applies it
// to every agent without a cap of its own, and an agent's own cap still wins.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { CircuitBreaker } = loadTs('src/main/breaker.ts');

/** A cumulative sample with `work` work-tokens (input+output+cacheCreation). */
function sample(agentId, work, ts = 1_000) {
  return { agentId, sessionId: 's', ts, input: work, output: 0, cacheRead: 5_000_000, cacheCreation: 0, model: null, usd: 0 };
}

function tick(cfg, inputs) {
  const breaker = new CircuitBreaker(() => cfg);
  return breaker.tick(inputs.map((s) => ({ agentId: s.agentId, sample: s, progressing: true })), 1_000);
}

test('no default, no per-agent cap: nobody trips on tokens', () => {
  const [d] = tick({}, [sample('a', 900_000)]);
  assert.equal(d.state.level, 'healthy');
});

test('the default cap trips an agent with no cap of its own', () => {
  const [over, under] = tick({ defaultAgentTokenCap: 500_000 }, [sample('a', 900_000), sample('b', 100_000)]);
  assert.equal(over.state.level, 'steering');
  assert.match(over.state.reason, /token limit/);
  assert.equal(under.state.level, 'healthy');
});

test('an agent\'s own cap overrides the default, in both directions', () => {
  const [raised, lowered] = tick(
    { defaultAgentTokenCap: 500_000, agentTokenCaps: { a: 2_000_000, b: 50_000 } },
    [sample('a', 900_000), sample('b', 100_000)]
  );
  assert.equal(raised.state.level, 'healthy');
  assert.equal(lowered.state.level, 'steering');
});

test('cache reads do not count against the default cap (#189 parity)', () => {
  // 5M cache-read tokens, 10k of work: well under a 100k default.
  const [d] = tick({ defaultAgentTokenCap: 100_000 }, [sample('a', 10_000)]);
  assert.equal(d.state.level, 'healthy');
});
