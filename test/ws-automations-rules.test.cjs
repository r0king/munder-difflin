/**
 * House rules — the context rules every agent reads before it starts
 * (src/shared/workspace/automationsRules.ts).
 *
 * Main validates what the renderer sends with these functions and folds the
 * enabled rules into the hook-channel briefing, so the contract worth pinning
 * is: junk never persists, an empty rule can never be "on", and the injected
 * block is bounded, ordered, and names what it had to leave out.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  newHouseRule, newHouseRuleId, isHouseRuleId, sanitizeHouseRule, sanitizeHouseRules,
  houseRulesBlock, withHouseRules,
  HOUSE_RULE_NAME_MAX, HOUSE_RULE_TEXT_MAX, HOUSE_RULES_MAX, HOUSE_RULES_INJECT_MAX
} = loadTs('src/shared/workspace/automationsRules.ts');

const NOW = Date.UTC(2026, 9, 12);
const rule = (over) => ({
  id: 'cr-abc-def123', name: 'House style', text: 'Plain English.', enabled: true,
  createdAt: NOW, updatedAt: NOW, ...over
});

test('newHouseRule mints a valid id and starts OFF and empty', () => {
  const r = newHouseRule('  House style  ', NOW, () => 0.5);
  assert.ok(isHouseRuleId(r.id), r.id);
  assert.equal(r.name, 'House style');
  assert.equal(r.text, '');
  assert.equal(r.enabled, false);
  assert.equal(r.createdAt, NOW);
  assert.notEqual(newHouseRuleId(NOW, () => 0.1), newHouseRuleId(NOW, () => 0.2));
});

test('isHouseRuleId accepts only the minted shape', () => {
  assert.equal(isHouseRuleId('cr-abc-def123'), true);
  assert.equal(isHouseRuleId('cr-../../x-y'), false);
  assert.equal(isHouseRuleId('wh-1'), false);
  assert.equal(isHouseRuleId(42), false);
});

test('sanitizeHouseRule clips, one-lines the name, and refuses junk', () => {
  assert.equal(sanitizeHouseRule(null, NOW), null);
  assert.equal(sanitizeHouseRule({ id: 'nope' }, NOW), null);
  const long = sanitizeHouseRule(rule({ name: `a\nb${'x'.repeat(200)}`, text: 'y'.repeat(HOUSE_RULE_TEXT_MAX + 50) }), NOW);
  assert.equal(long.name.length, HOUSE_RULE_NAME_MAX);
  assert.ok(long.name.startsWith('a b'), 'newline folded to a space');
  assert.equal(long.text.length, HOUSE_RULE_TEXT_MAX);
  const crlf = sanitizeHouseRule(rule({ text: 'a\r\nb' }), NOW);
  assert.equal(crlf.text, 'a\nb');
  const fallback = sanitizeHouseRule({ id: 'cr-a-b', name: 1, text: 2, enabled: 'yes' }, NOW);
  assert.deepEqual(fallback, { id: 'cr-a-b', name: '', text: '', enabled: false, createdAt: NOW, updatedAt: NOW });
});

test('an empty rule can never be on', () => {
  assert.equal(sanitizeHouseRule(rule({ text: '   ' }), NOW).enabled, false);
  assert.equal(sanitizeHouseRule(rule({ text: 'x' }), NOW).enabled, true);
});

test('sanitizeHouseRules drops duplicates and caps the list', () => {
  const list = sanitizeHouseRules([rule({}), rule({ name: 'dup' }), 'junk', rule({ id: 'cr-b-c' })], NOW);
  assert.deepEqual(list.map((r) => r.id), ['cr-abc-def123', 'cr-b-c']);
  assert.equal(list[0].name, 'House style', 'first one wins');
  const many = Array.from({ length: HOUSE_RULES_MAX + 5 }, (_, i) => rule({ id: `cr-a-${i.toString(36)}` }));
  assert.equal(sanitizeHouseRules(many, NOW).length, HOUSE_RULES_MAX);
  assert.deepEqual(sanitizeHouseRules('nope', NOW), []);
});

test('houseRulesBlock lists enabled rules oldest first under their names', () => {
  assert.equal(houseRulesBlock([]), null);
  assert.equal(houseRulesBlock([rule({ enabled: false })]), null);
  const block = houseRulesBlock([
    rule({ id: 'cr-b-b', name: 'Commits', text: 'Imperative mood.', createdAt: NOW + 5 }),
    rule({ id: 'cr-a-a', name: 'House style', text: '  Plain English.  ', createdAt: NOW }),
    rule({ id: 'cr-c-c', name: 'Off', text: 'never shown', enabled: false })
  ]);
  assert.ok(block.startsWith('<context-rules>\n'));
  assert.ok(block.endsWith('\n</context-rules>'));
  assert.ok(block.indexOf('## House style\nPlain English.') < block.indexOf('## Commits\nImperative mood.'));
  assert.equal(block.includes('never shown'), false);
});

test('houseRulesBlock stays under the ceiling and names what it omitted', () => {
  const big = 'z'.repeat(HOUSE_RULE_TEXT_MAX);
  const rules = Array.from({ length: 4 }, (_, i) => rule({ id: `cr-a-${i}`, name: `Rule ${i}`, text: big, createdAt: NOW + i }));
  const block = houseRulesBlock(rules);
  assert.ok(block.length <= HOUSE_RULES_INJECT_MAX + 200, `block is ${block.length} chars`);
  assert.ok(block.includes('## Rule 0'));
  assert.ok(block.includes('Omitted for length: Rule 2, Rule 3'));
});

test('withHouseRules folds into the standing goal, either half optional', () => {
  const rules = [rule({})];
  assert.equal(withHouseRules(null, []), null);
  assert.equal(withHouseRules('  Ship the login page.  ', []), 'Ship the login page.');
  assert.equal(withHouseRules(null, rules), houseRulesBlock(rules));
  const both = withHouseRules('Ship the login page.', rules);
  assert.ok(both.startsWith('Ship the login page.\n\n<context-rules>'));
  // The hook server re-delivers only when the text changes: same input, same text.
  assert.equal(withHouseRules('Ship the login page.', rules), both);
});
