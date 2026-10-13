'use strict';

// The Workspace's status model (src/shared/workspace/agentStatus.ts): the ONE
// mapping from the store's raw signals (status, action, pty, archived, an open
// ASK ME question) to the words every Workspace surface shows. Sidebar dots,
// agent cards, the orchestrator's roster and the roster main caches for the
// Stapler all read it, so a drift here is a drift everywhere at once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  WS_AGENT_STATUSES, deriveAgentStatus, statusColorVar, statusColorToken, statusKey,
  isActiveStatus, agentLiveLine, liveLine, LIVE_LINE_KINDS, liveLineTakesDetail
} = loadTs('src/shared/workspace/agentStatus.ts');

const root = path.join(__dirname, '..');
const live = (over) => ({ status: 'idle', action: 'idle', ptyId: 'pty-a', ...over });

test('each store status maps to its Workspace word', () => {
  const cases = [
    ['working', 'working'],
    ['thinking', 'thinking'],
    ['blocked', 'needs-you'],
    ['waiting', 'waiting'],
    ['compacting', 'compacting'],
    ['looping', 'looping'],
    ['idle', 'idle'],
    ['success', 'idle'],
    // 'typing' is the USER's draft holding the queue, not a state of the agent.
    ['typing', 'idle'],
    ['ghost', 'offline']
  ];
  for (const [store, ws] of cases) {
    assert.equal(deriveAgentStatus(live({ status: store })), ws, `${store} -> ${ws}`);
  }
});

test('no terminal means offline, whatever the stale status says', () => {
  assert.equal(deriveAgentStatus({ status: 'working', action: 'using Bash' }), 'offline');
  assert.equal(deriveAgentStatus(live({ status: 'working', archived: true })), 'offline');
  assert.equal(deriveAgentStatus(live({ status: 'looping', ptyId: undefined })), 'offline');
});

test('a hook turn that has not reached a tool yet reads as thinking', () => {
  // useHive writes { status: 'working', action: 'thinking' } on agy's PreInvocation.
  assert.equal(deriveAgentStatus(live({ status: 'working', action: 'thinking' })), 'thinking');
  assert.equal(deriveAgentStatus(live({ status: 'working', action: 'using Read' })), 'working');
});

test('precedence: breaker > needs-you > compacting > in-flight > asked-you > waiting', () => {
  const q = { hasOpenQuestion: true };
  assert.equal(deriveAgentStatus(live({ status: 'looping', ...q })), 'looping');
  assert.equal(deriveAgentStatus(live({ status: 'blocked', ...q })), 'needs-you');
  assert.equal(deriveAgentStatus(live({ status: 'compacting', ...q })), 'compacting');
  // An agent that asked and carried on with other work IS working; the
  // question surfaces as a chip, not by hiding the work.
  assert.equal(deriveAgentStatus(live({ status: 'working', ...q })), 'working');
  assert.equal(deriveAgentStatus(live({ status: 'idle', ...q })), 'needs-you');
  assert.equal(deriveAgentStatus(live({ status: 'waiting', ...q })), 'needs-you');
  assert.equal(deriveAgentStatus(live({ status: 'waiting' })), 'waiting');
});

test('every status has a colour token that exists in both themes', () => {
  const css = fs.readFileSync(path.join(root, 'src/renderer/src/design/tokens.css'), 'utf8');
  const dark = css.slice(css.indexOf(":root[data-cth-theme='dark']"));
  assert.ok(dark.length > 100, 'the dark theme block moved');
  for (const s of WS_AGENT_STATUSES) {
    const token = statusColorToken(s);
    assert.match(token, /^--cth-status-[a-z]+$/);
    assert.equal(statusColorVar(s), `var(${token})`);
    assert.ok(css.includes(`${token}:`), `${token} is not defined in tokens.css`);
    assert.ok(dark.includes(`${token}:`), `${token} has no dark-theme value`);
  }
  assert.equal(statusColorVar('needs-you'), 'var(--cth-status-blocked)');
  assert.equal(statusColorVar('offline'), 'var(--cth-status-ghost)');
});

test('only in-flight statuses count as active (the pulsing dot)', () => {
  const active = WS_AGENT_STATUSES.filter(isActiveStatus);
  assert.deepEqual(active.sort(), ['compacting', 'thinking', 'working']);
});

test('every status and live-line kind has its words in every language', () => {
  for (const lng of ['en', 'zh-CN', 'ar']) {
    const ws = JSON.parse(fs.readFileSync(path.join(root, `src/renderer/src/i18n/features/ws.${lng}.json`), 'utf8'));
    for (const s of WS_AGENT_STATUSES) {
      assert.ok(ws.status[statusKey(s)], `${lng}: ws.status.${statusKey(s)} missing`);
    }
    for (const kind of LIVE_LINE_KINDS) {
      assert.ok(ws.live[kind], `${lng}: ws.live.${kind} missing`);
      assert.equal(`${kind}Detail` in ws.live, liveLineTakesDetail(kind),
        `${lng}: ws.live.${kind}Detail must exist exactly when the kind takes a detail`);
    }
    // No orphan keys: every ws.live key is a kind (or a kind's Detail).
    for (const key of Object.keys(ws.live)) {
      const kind = key.endsWith('Detail') ? key.slice(0, -'Detail'.length) : key;
      assert.ok(LIVE_LINE_KINDS.includes(kind), `${lng}: ws.live.${key} is not a live-line kind`);
    }
  }
});

test('the live line reads the three shapes the store holds', () => {
  const at = (over) => agentLiveLine(live(over));
  // Hook form: `using <Tool>`.
  assert.deepEqual(at({ status: 'working', action: 'using Bash' }), { kind: 'running', text: 'Running a command' });
  assert.equal(at({ status: 'working', action: 'using Read' }).kind, 'reading');
  assert.equal(at({ status: 'working', action: 'using MultiEdit' }).kind, 'editing');
  assert.equal(at({ status: 'working', action: 'using Grep' }).kind, 'searching');
  assert.equal(at({ status: 'working', action: 'using WebSearch' }).kind, 'browsing');
  assert.equal(at({ status: 'working', action: 'using TodoWrite' }).kind, 'planning');
  assert.equal(at({ status: 'working', action: 'using Task' }).kind, 'delegating');
  assert.deepEqual(at({ status: 'working', action: 'using mcp__github__create_issue' }),
    { kind: 'tool', detail: 'mcp__github__create_issue', text: 'Using mcp__github__create_issue' });
  // Parser form: `<tool> <arg>`, arg verbatim.
  assert.deepEqual(at({ status: 'working', action: 'bash npm test auth/login' }),
    { kind: 'running', detail: 'npm test auth/login', text: 'Running npm test auth/login' });
  assert.deepEqual(at({ status: 'working', action: 'read SPEC.md' }),
    { kind: 'reading', detail: 'SPEC.md', text: 'Reading SPEC.md' });
  // Fixed phrases.
  assert.equal(at({ status: 'working', action: 'reading inbox' }).kind, 'inbox');
  assert.equal(at({ status: 'working', action: 'resumed' }).kind, 'working');
  assert.equal(at({ status: 'idle', action: 'starting up' }).kind, 'starting');
  assert.equal(at({ status: 'idle', action: 'reconnecting…' }).kind, 'starting');
  assert.equal(at({ status: 'idle', action: 'running the floor' }).kind, 'idle');
  assert.equal(at({ status: 'idle', action: 'awaiting' }).kind, 'idle');
  // Something new the store learns to say is still shown, not swallowed.
  assert.deepEqual(at({ status: 'working', action: 'warming the cache' }),
    { kind: 'working', detail: 'warming the cache', text: 'Working: warming the cache' });
});

test('the live line follows the derived status first', () => {
  const at = (over) => agentLiveLine(live(over));
  assert.equal(at({ status: 'working', action: 'using Bash', ptyId: undefined }).kind, 'offline');
  assert.deepEqual(at({ status: 'looping', action: 'token cap reached' }),
    { kind: 'looping', detail: 'token cap reached', text: 'Stopped by the breaker: token cap reached' });
  // The default breaker reason says nothing the kind does not.
  assert.deepEqual(at({ status: 'looping', action: 'breaker armed' }), { kind: 'looping', text: 'Stopped by the breaker' });
  assert.equal(at({ status: 'blocked', action: 'waiting on you' }).kind, 'needsYou');
  assert.equal(at({ status: 'idle', hasOpenQuestion: true }).kind, 'askedYou');
  assert.equal(at({ status: 'waiting', action: 'waiting on god' }).kind, 'waiting');
  assert.equal(at({ status: 'compacting', action: 'compacting context' }).kind, 'compacting');
});

test('a detail is dropped for a kind that has no slot for one', () => {
  assert.deepEqual(liveLine('idle', 'whatever'), { kind: 'idle', text: 'Idle' });
  assert.deepEqual(liveLine('running', '  npm   test '), { kind: 'running', detail: 'npm test', text: 'Running npm test' });
});
