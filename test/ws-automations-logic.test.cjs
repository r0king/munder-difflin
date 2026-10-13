/**
 * Workspace Automations — the pure logic behind the one list of schedules,
 * context rules and webhooks (src/shared/workspace/automations.ts).
 *
 * Three things are worth pinning: the words for "when" (as structured phrases,
 * so every language builds its own sentence), the ORDER of the list (stable by
 * age, so a switch flip or an arriving delivery never moves a row), and the
 * blur-save decision (write only when the meaning changed; never persist a
 * blank required field).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

process.env.TZ = 'UTC';

const {
  intervalPhrase, describeWhen, nextRunAt, firstLine, missionCreatedAt,
  assembleAutomations, filterAutomations, countOn, countByKind,
  heldCountByWebhook, webhookDeliveries, webhookGate,
  patchMission, removeMission, newMission, missionBlocker,
  normalizeFieldText, blurDecision, changedKeys
} = loadTs('src/shared/workspace/automations.ts');
const { DEFAULT_CONTEXT_TRIGGER } = loadTs('src/shared/triggers.ts');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* ───────────────────────────── when → words ─────────────────────────────── */

test('intervalPhrase picks the largest unit that divides exactly', () => {
  assert.deepEqual(intervalPhrase(30 * MIN), { unit: 'minute', count: 30 });
  assert.deepEqual(intervalPhrase(90 * MIN), { unit: 'minute', count: 90 }, 'never rounds 90m to 2h');
  assert.deepEqual(intervalPhrase(2 * HOUR), { unit: 'hour', count: 2 });
  assert.deepEqual(intervalPhrase(DAY), { unit: 'day', count: 1 });
  assert.deepEqual(intervalPhrase(14 * DAY), { unit: 'week', count: 2 });
  assert.deepEqual(intervalPhrase(10_000), { unit: 'minute', count: 1 }, 'sub-minute rounds up to one');
  assert.equal(intervalPhrase(0), null);
  assert.equal(intervalPhrase(-5), null);
  assert.equal(intervalPhrase(NaN), null);
});

test('describeWhen names the common day sets and keeps the time', () => {
  assert.deepEqual(
    describeWhen({ intervalMs: HOUR, weekly: { days: [5, 4, 3, 2, 1], minute: 540 } }),
    { kind: 'weekly', set: 'weekdays', time: '09:00' },
    'unsorted weekdays still read as weekdays'
  );
  assert.deepEqual(describeWhen({ intervalMs: HOUR, weekly: { days: [0, 1, 2, 3, 4, 5, 6], minute: 0 } }),
    { kind: 'weekly', set: 'everyDay', time: '00:00' });
  assert.deepEqual(describeWhen({ intervalMs: HOUR, weekly: { days: [6, 0], minute: 630 } }),
    { kind: 'weekly', set: 'weekends', time: '10:30' });
  assert.deepEqual(describeWhen({ intervalMs: HOUR, weekly: { days: [5], minute: 17 * 60 } }),
    { kind: 'weekly', set: 'days', days: [5], time: '17:00' }, 'Fridays at 17:00');
  assert.deepEqual(describeWhen({ intervalMs: HOUR, weekly: { days: [1, 3, 5], minute: 545 } }),
    { kind: 'weekly', set: 'days', days: [1, 3, 5], time: '09:05' });
});

test('describeWhen falls back to the interval exactly as the scheduler does', () => {
  assert.deepEqual(describeWhen({ intervalMs: 2 * HOUR }), { kind: 'interval', every: { unit: 'hour', count: 2 } });
  // An invalid weekly (no days) is ignored by main, so the interval is what runs.
  assert.deepEqual(describeWhen({ intervalMs: HOUR, weekly: { days: [], minute: 540 } }),
    { kind: 'interval', every: { unit: 'hour', count: 1 } });
  assert.deepEqual(describeWhen({ intervalMs: 0 }), { kind: 'unset' });
  // Heartbeats are never weekly in main, even if a weekly rides along.
  assert.deepEqual(
    describeWhen({ intervalMs: 2 * MIN, kind: 'heartbeat', weekly: { days: [1], minute: 0 } }),
    { kind: 'heartbeat', every: { unit: 'minute', count: 2 } }
  );
});

test('nextRunAt mirrors syncMissions: calendar for weekly, lastFiredAt + interval otherwise', () => {
  const now = Date.UTC(2026, 9, 12, 10, 0); // Monday 10:00 UTC
  const base = { id: 'm_x', label: 'x', to: 'god', body: 'b', enabled: true, intervalMs: HOUR };
  assert.equal(nextRunAt({ ...base, enabled: false }, now), null, 'off never runs');
  assert.equal(nextRunAt({ ...base }, now), now, 'never fired → runs as soon as it is armed');
  assert.equal(nextRunAt({ ...base, lastFiredAt: now - 20 * MIN }, now), now + 40 * MIN);
  assert.equal(nextRunAt({ ...base, lastFiredAt: now - 3 * HOUR }, now), now, 'overdue → now, never the past');
  assert.equal(
    nextRunAt({ ...base, weekly: { days: [5], minute: 17 * 60 } }, now),
    Date.UTC(2026, 9, 16, 17, 0),
    'Friday 17:00 of the same week'
  );
  assert.equal(nextRunAt({ ...base, kind: 'heartbeat' }, now), null, 'adaptive cadence has no single next');
  assert.equal(nextRunAt({ ...base, intervalMs: 0 }, now), null);
});

test('firstLine skips blank lines and clips long ones', () => {
  assert.equal(firstLine('\n\n  Sort new issues into tickets.\nThen ping me.'), 'Sort new issues into tickets.');
  assert.equal(firstLine(''), '');
  const long = 'x'.repeat(200);
  const clipped = firstLine(long, 20);
  assert.equal(clipped.length, 20);
  assert.ok(clipped.endsWith('…'));
});

/* ───────────────────────────── list assembly ────────────────────────────── */

const T0 = Date.UTC(2026, 0, 1);
const mid = (ms) => `m_${ms.toString(36)}`;

function sources(over = {}) {
  return {
    missions: [
      { id: 'ops-standup', label: 'Hourly ops standup', intervalMs: HOUR, to: 'god', body: 'b', enabled: true },
      { id: 'heartbeat', label: 'Floor heartbeat', intervalMs: 2 * MIN, to: 'god', body: 'b', enabled: false, kind: 'heartbeat' },
      { id: mid(T0 + 3000), label: 'Friday summary', intervalMs: HOUR, weekly: { days: [5], minute: 1020 }, to: 'god', body: 'Summarise', enabled: true }
    ],
    contextTrigger: DEFAULT_CONTEXT_TRIGGER,
    houseRules: [
      { id: 'cr-a-aaaaaa', name: 'House style', text: 'Plain English.', enabled: true, createdAt: T0 + 2000, updatedAt: T0 + 2000 }
    ],
    webhooks: [
      { id: 'wh-1', name: 'New bug report', secret: 's', enabled: false, mode: 'strict', schema: '{}', createdAt: T0 + 1000 }
    ],
    history: [],
    ...over
  };
}

test('assembleAutomations folds every source into one list, built-ins first then by age', () => {
  const items = assembleAutomations(sources(), T0 + DAY);
  assert.deepEqual(items.map((i) => i.key), [
    'schedule:ops-standup', // built-ins: kind order, then the order config holds them
    'schedule:heartbeat',
    'context:compact', // compact before the off-by-default, destructive clear
    'context:clear',
    'webhook:wh-1', // then by age
    'rule:cr-a-aaaaaa',
    `schedule:${mid(T0 + 3000)}`
  ]);
  const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.equal(byKey['schedule:ops-standup'].builtIn, true);
  assert.equal(byKey['context:compact'].builtIn, true);
  assert.equal(byKey['rule:cr-a-aaaaaa'].builtIn, false);
  assert.equal(byKey['context:compact'].enabled, true, 'compaction ships on');
  assert.equal(byKey['context:clear'].enabled, false, 'clearing ships off');
});

test('order is stable under a switch flip and an arriving held delivery', () => {
  const before = assembleAutomations(sources(), T0 + DAY).map((i) => i.key);
  const flipped = sources({
    webhooks: [{ id: 'wh-1', name: 'New bug report', secret: 's', enabled: true, mode: 'strict', schema: '{}', createdAt: T0 + 1000 }],
    history: [{ id: 'h1', source: 'webhook', sourceId: 'wh-1', sourceName: 'x', direction: 'inbound', peer: 'gh', body: 'hi', kind: 'directive', decision: 'pending', at: T0 + 5000 }]
  });
  const after = assembleAutomations(flipped, T0 + DAY);
  assert.deepEqual(after.map((i) => i.key), before);
  assert.equal(after.find((i) => i.key === 'webhook:wh-1').held, 1);
});

test('a retired compact-maintenance mission is not listed beside the context rule', () => {
  const s = sources();
  s.missions = [...s.missions, { id: 'compact-maintenance', label: 'Auto-compact', intervalMs: HOUR, to: '', body: '', enabled: true, kind: 'compact' }];
  assert.equal(assembleAutomations(s).some((i) => i.key === 'schedule:compact-maintenance'), false);
});

test('missionCreatedAt reads the age out of minted ids only', () => {
  assert.equal(missionCreatedAt(mid(T0), T0 + DAY), T0);
  assert.equal(missionCreatedAt(`${mid(T0)}_2`, T0 + DAY), T0, 'collision suffix');
  assert.equal(missionCreatedAt('ops-standup'), 0);
  assert.equal(missionCreatedAt('m_zz'), 0, 'too small to be a timestamp');
  assert.equal(missionCreatedAt(mid(T0 + 10 * DAY), T0), 0, 'from the future');
});

test('countOn, countByKind and filterAutomations', () => {
  const items = assembleAutomations(sources(), T0 + DAY);
  // ops standup, Friday summary, compact, house style
  assert.equal(countOn(items), 4);
  assert.deepEqual(countByKind(items), { schedule: 3, context: 3, webhook: 1 });
  assert.equal(filterAutomations(items, 'all').length, items.length);
  assert.deepEqual(filterAutomations(items, 'webhook').map((i) => i.key), ['webhook:wh-1']);
});

/* ──────────────────────────────── webhooks ──────────────────────────────── */

const entry = (id, over) => ({
  id, source: 'webhook', sourceId: 'wh-1', sourceName: 'x', direction: 'inbound', peer: 'p',
  body: id, kind: 'directive', decision: 'auto-allowed', at: 0, ...over
});

test('webhookDeliveries splits held (oldest first) from recent (newest first)', () => {
  const history = [
    entry('a', { at: 1 }),
    entry('b', { at: 5, decision: 'pending' }),
    entry('c', { at: 3, decision: 'pending' }),
    entry('d', { at: 4, decision: 'rejected' }),
    entry('e', { at: 6, direction: 'outbound' }),
    entry('f', { at: 7, sourceId: 'wh-2' }),
    entry('g', { at: 8, source: 'org' })
  ];
  const d = webhookDeliveries(history, 'wh-1', 1);
  assert.deepEqual(d.held.map((e) => e.id), ['c', 'b']);
  assert.deepEqual(d.recent.map((e) => e.id), ['d'], 'limited, newest first, outbound and others excluded');
  assert.equal(d.total, 4);
  assert.deepEqual([...heldCountByWebhook(history)], [['wh-1', 2]]);
});

test('webhookGate names what a mode lets through', () => {
  assert.equal(webhookGate('strict'), 'holdAll');
  assert.equal(webhookGate('allow-all'), 'passAll');
  assert.equal(webhookGate('communication-only'), 'holdWork');
});

/* ──────────────────────────────── schedules ─────────────────────────────── */

test('newMission is off, Classic-shaped, and never collides', () => {
  const now = T0 + 123;
  const a = newMission({ label: 'Morning triage', to: 'god' }, [], now);
  assert.equal(a.id, mid(now));
  assert.equal(a.enabled, false, 'switched on by the operator, not by creation');
  assert.equal(a.intervalMs, HOUR);
  assert.equal(a.body, '');
  assert.equal('weekly' in a, false);
  const b = newMission({ label: 'Again', to: 'god', weekly: { days: [1, 2, 3, 4, 5], minute: 540 } }, [a], now);
  assert.equal(b.id, `${mid(now)}_2`);
  assert.deepEqual(b.weekly, { days: [1, 2, 3, 4, 5], minute: 540 });
  assert.equal(missionCreatedAt(b.id, now + 1), now);
});

test('patchMission keeps an explicit weekly: undefined so the backend clears it', () => {
  const list = [{ id: 'a', weekly: { days: [1], minute: 0 } }, { id: 'b' }];
  const next = patchMission(list, 'a', { weekly: undefined });
  assert.ok('weekly' in next[0]);
  assert.equal(next[0].weekly, undefined);
  assert.equal(next[1], list[1], 'other missions are the same objects');
  assert.deepEqual(removeMission(list, 'a').map((m) => m.id), ['b']);
});

test('missionBlocker names what stops a schedule from being switched on', () => {
  const ok = { id: 'a', label: 'a', to: 'god', body: 'do it', enabled: false, intervalMs: HOUR };
  assert.equal(missionBlocker(ok), null);
  assert.equal(missionBlocker({ ...ok, body: '  ' }), 'noPrompt');
  assert.equal(missionBlocker({ ...ok, to: '' }), 'noTarget');
  assert.equal(missionBlocker({ ...ok, weekly: { days: [], minute: 0 } }), 'noWhen');
  assert.equal(missionBlocker({ ...ok, intervalMs: 0 }), 'noWhen');
  assert.equal(missionBlocker({ ...ok, body: '', kind: 'heartbeat' }), null, 'the heartbeat carries its own');
});

/* ──────────────────────────── blur-save diffing ─────────────────────────── */

test('blurDecision writes only when the meaning changed', () => {
  assert.deepEqual(blurDecision('Morning triage', 'Morning triage  '), { action: 'none' }, 'trailing space is not an edit');
  assert.deepEqual(blurDecision('a\r\nb', 'a\nb'), { action: 'none' }, 'line endings are not an edit');
  assert.deepEqual(blurDecision('Old', ' New '), { action: 'save', value: 'New' });
});

test('blurDecision refuses a blank required field and restores the stored value', () => {
  assert.deepEqual(
    blurDecision('Morning triage', '   ', { required: true }),
    { action: 'reject', reason: 'required', restore: 'Morning triage' }
  );
  assert.deepEqual(blurDecision('prompt', '', {}), { action: 'save', value: '' }, 'optional fields may be cleared');
  assert.deepEqual(
    blurDecision('x', 'abcdef', { maxLength: 5 }),
    { action: 'reject', reason: 'tooLong', restore: 'x' }
  );
});

test('single-line fields fold pasted newlines into spaces', () => {
  assert.equal(normalizeFieldText('House\n\tstyle   rules', { singleLine: true }), 'House style rules');
  assert.deepEqual(blurDecision('House style', 'House\nstyle', { singleLine: true }), { action: 'none' });
  assert.equal(normalizeFieldText('a\n\nb'), 'a\n\nb', 'multi-line keeps paragraphs');
});

test('changedKeys compares values, deeply for arrays', () => {
  const a = { label: 'x', weekly: { days: [1, 2], minute: 0 }, to: 'god' };
  assert.deepEqual(changedKeys(a, { ...a, weekly: { days: [1, 2], minute: 0 } }), []);
  assert.deepEqual(changedKeys(a, { ...a, to: 'dwight' }), ['to']);
  assert.deepEqual(changedKeys(a, { ...a, weekly: undefined }), ['weekly']);
});
