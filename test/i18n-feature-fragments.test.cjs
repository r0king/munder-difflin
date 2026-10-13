'use strict';

// Feature i18n fragments: src/renderer/src/i18n/features/<ns>.<lng>.json, one
// namespace per Workspace/Stapler unit, merged into the `translation` resource
// by i18n/index.ts. They exist so eleven units can add strings in parallel
// without all editing the three big locale files — which only works if every
// fragment holds the same line the locales do (test/arabic-ui.test.cjs):
// identical key trees, real translations, placeholders intact.
//
// As with the locales, this checks coverage and shape, never whether the
// Arabic or Chinese reads well.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'src/renderer/src/i18n/features');
const LANGS = ['en', 'zh-CN', 'ar'];

/** Every namespace a unit owns (docs/WORKSPACE_UNITS.md). */
const NAMESPACES = [
  'ws', 'wsSidebar', 'wsAgents', 'wsOrchestrator', 'wsTasks', 'wsInbox', 'wsAutomations',
  'wsMemory', 'wsCapabilities', 'stapler', 'transcribe', 'dictate'
];

/** English strings that are the same in every language on purpose: product
 *  names that are never translated. Keep this tiny — a copied English string
 *  looks translated and is not. */
const BRAND_SAME = new Set(['Whisper', 'Groq', 'Apple', 'Hugging Face', 'Slack', 'GitHub', 'MCP']);

const read = (ns, lng) => JSON.parse(fs.readFileSync(path.join(dir, `${ns}.${lng}.json`), 'utf8'));

/** Leaves as [dotted path, value]; arrays by index. */
function leaves(node, prefix = '') {
  if (Array.isArray(node)) return node.flatMap((v, i) => leaves(v, `${prefix}.${i}`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, node]];
}
const vars = (s) => [...String(s).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');
/** Letters left once placeholders are removed — "{{count}} · {{state}}" has none. */
const hasLetters = (s) => /\p{L}/u.test(String(s).replace(/\{\{[^}]*\}\}/g, ''));

test('every namespace has all three languages, and nothing else is in the folder', () => {
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  for (const ns of NAMESPACES) {
    for (const lng of LANGS) {
      assert.ok(files.includes(`${ns}.${lng}.json`), `missing ${ns}.${lng}.json`);
    }
  }
  const pattern = /^([A-Za-z][A-Za-z0-9]*)\.(en|zh-CN|ar)\.json$/;
  for (const f of files) {
    const m = pattern.exec(f);
    assert.ok(m, `${f} is not named <namespace>.<en|zh-CN|ar>.json`);
    assert.ok(NAMESPACES.includes(m[1]), `${f}: namespace "${m[1]}" is not registered in this test or the units doc`);
  }
});

test('no namespace shadows a top-level key of the locale files', () => {
  for (const lng of LANGS) {
    const locale = JSON.parse(fs.readFileSync(path.join(root, `src/renderer/src/i18n/locales/${lng}.json`), 'utf8'));
    for (const ns of NAMESPACES) {
      assert.ok(!(ns in locale), `${ns} collides with locales/${lng}.json — it would be ignored`);
    }
  }
});

test('each fragment is an object of non-empty strings', () => {
  for (const ns of NAMESPACES) {
    for (const lng of LANGS) {
      const data = read(ns, lng);
      assert.ok(data && typeof data === 'object' && !Array.isArray(data), `${ns}.${lng} is not an object`);
      for (const [k, v] of leaves(data)) {
        assert.equal(typeof v, 'string', `${ns}.${lng}: ${k} is not a string`);
        assert.ok(v.trim().length > 0, `${ns}.${lng}: ${k} is empty`);
      }
    }
  }
});

test('the three languages carry identical key trees', () => {
  for (const ns of NAMESPACES) {
    const en = new Map(leaves(read(ns, 'en')));
    for (const lng of ['zh-CN', 'ar']) {
      const other = new Map(leaves(read(ns, lng)));
      const missing = [...en.keys()].filter((k) => !other.has(k));
      const extra = [...other.keys()].filter((k) => !en.has(k));
      assert.deepEqual(missing, [], `${ns}.${lng} is missing keys (they would fall back to English)`);
      assert.deepEqual(extra, [], `${ns}.${lng} has keys English does not (dead strings)`);
    }
  }
});

test('interpolation placeholders survive translation', () => {
  const bad = [];
  for (const ns of NAMESPACES) {
    const en = new Map(leaves(read(ns, 'en')));
    for (const lng of ['zh-CN', 'ar']) {
      const other = new Map(leaves(read(ns, lng)));
      for (const [k, v] of en) {
        if (vars(v) !== vars(other.get(k))) bad.push(`${ns}.${lng} ${k}: [${vars(v)}] -> [${vars(other.get(k))}]`);
      }
    }
  }
  assert.deepEqual(bad, []);
  // Positive control: the comparison can fail.
  assert.notEqual(vars('a {{x}}'), vars('a'));
});

test('no translated string is left as its English source', () => {
  const untranslated = [];
  for (const ns of NAMESPACES) {
    const en = new Map(leaves(read(ns, 'en')));
    for (const lng of ['zh-CN', 'ar']) {
      const other = new Map(leaves(read(ns, lng)));
      for (const [k, v] of en) {
        if (!hasLetters(v) || BRAND_SAME.has(v)) continue;
        if (other.get(k) === v) untranslated.push(`${ns}.${lng} ${k}`);
      }
    }
  }
  assert.deepEqual(untranslated, [], `${untranslated.length} strings are still English`);
  // The letter check ignores placeholders, so a pure format string passes...
  assert.equal(hasLetters('{{count}} · {{state}}'), false);
  // ...and a real word does not.
  assert.equal(hasLetters('{{count}} agents'), true);
});

test('the orchestrator is never named literally (it can be renamed)', () => {
  for (const ns of NAMESPACES) {
    for (const lng of LANGS) {
      for (const [k, v] of leaves(read(ns, lng))) {
        assert.doesNotMatch(v, /Michael/, `${ns}.${lng} ${k} hardcodes the orchestrator's name — use {{godName}}`);
      }
    }
  }
});

test('i18n/index.ts merges the fragments, with the locale rules intact', () => {
  const src = fs.readFileSync(path.join(root, 'src/renderer/src/i18n/index.ts'), 'utf8');
  assert.match(src, /import\.meta\.glob\('\.\/features\/\*\.json', \{ eager: true, import: 'default' \}\)/);
  assert.match(src, /const en = withFeatureFragments\('en', enBase\)/);
  assert.match(src, /const zhCN = withFeatureFragments\('zh-CN', zhCNBase\)/);
  assert.match(src, /const ar = withFeatureFragments\('ar', arBase\)/);
  // A fragment may not replace a block of the classic UI's strings.
  assert.match(src, /if \(ns in base\)/);
});
