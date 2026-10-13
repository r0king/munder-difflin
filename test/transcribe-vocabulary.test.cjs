'use strict';

// Transcription vocabulary (src/shared/features/vocabulary.ts): the 126
// built-in names, the engine prompt built from them, and the casing pass that
// must fix whole words and never touch the inside of another word.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { BUILTIN_VOCABULARY, mergeVocabulary, buildVocabularyPrompt, estimateTokens, applyVocabularyCasing, compileVocabulary } =
  loadTs('src/shared/features/vocabulary.ts');

test('126 built-in names, unique, including the ones the README promises', () => {
  assert.equal(BUILTIN_VOCABULARY.length, 126);
  assert.equal(new Set(BUILTIN_VOCABULARY.map((w) => w.toLowerCase())).size, 126);
  for (const w of ['Anthropic', 'Claude', 'Kubernetes', 'ARR', 'MRR', 'PostgreSQL', 'GitHub', 'TypeScript']) {
    assert.ok(BUILTIN_VOCABULARY.includes(w), w);
  }
});

test('no built-in name is an everyday English word the casing pass would wreck', () => {
  const everyday = ['rust', 'swift', 'react', 'slack', 'notion', 'cursor', 'linear', 'whisper', 'opus', 'grok', 'go', 'spark', 'helm', 'yarn', 'jest', 'stripe', 'segment', 'windows', 'apple', 'meta', 'lambda', 'rest', 'rag', 'mom', 'cogs'];
  const lower = new Set(BUILTIN_VOCABULARY.map((w) => w.toLowerCase()));
  for (const w of everyday) assert.ok(!lower.has(w), `${w} is a common word`);
});

test('user words come first and win over a built-in spelling', () => {
  const merged = mergeVocabulary(['Zensible', 'postgresql', '  ', 'Zensible']);
  assert.equal(merged[0], 'Zensible');
  assert.equal(merged[1], 'postgresql');
  assert.ok(!merged.includes('PostgreSQL'));
  assert.equal(merged.length, 1 + BUILTIN_VOCABULARY.length);
});

test('the prompt fits its token budget and keeps priority order', () => {
  const words = mergeVocabulary(['Zensible']);
  for (const max of [20, 60, 120, 224]) {
    const p = buildVocabularyPrompt(words, { maxTokens: max });
    assert.ok(estimateTokens(p) <= max, `budget ${max}: ${estimateTokens(p)}`);
    assert.ok(p.startsWith('Zensible, Anthropic'), p);
    assert.ok(p.endsWith('.'));
  }
  // An exact counter is honoured.
  const byWords = buildVocabularyPrompt(['a', 'b', 'c', 'd'], { maxTokens: 3, countTokens: (s) => s.split(/\s+/).length });
  assert.equal(byWords, 'a, b, c.');
  assert.equal(buildVocabularyPrompt([], { maxTokens: 100 }), '');
  assert.equal(buildVocabularyPrompt(['Anthropic'], { maxTokens: 0 }), '');
  // Caller text leads and counts against the budget.
  assert.ok(buildVocabularyPrompt(['Claude'], { lead: 'Weekly sync', maxTokens: 50 }).startsWith('Weekly sync. Claude'));
});

test('casing: whole words, case-insensitive, canonical spelling', () => {
  const v = mergeVocabulary([]);
  assert.equal(
    applyVocabularyCasing('we moved postgresql to kubernetes and our arr and mrr grew on github', v),
    'we moved PostgreSQL to Kubernetes and our ARR and MRR grew on GitHub'
  );
  assert.equal(applyVocabularyCasing("anthropic's claude code release", v), "Anthropic's Claude Code release");
});

test('casing never touches substrings or neighbouring words', () => {
  const v = mergeVocabulary([]);
  assert.equal(applyVocabularyCasing('the apiary nodes', v), 'the apiary nodes');
  assert.equal(applyVocabularyCasing('carry the arrow', v), 'carry the arrow');
  assert.equal(applyVocabularyCasing('awsome typescripts', v), 'awsome typescripts');
  assert.equal(applyVocabularyCasing('my_api and api2', v), 'my_api and api2');
});

test('terms with punctuation and spaces match as units', () => {
  const v = mergeVocabulary([]);
  assert.equal(applyVocabularyCasing('we use node.js and next.js.', v), 'we use Node.js and Next.js.');
  assert.equal(applyVocabularyCasing('ci/cd and soc 2, also soc  2', v), 'CI/CD and SOC 2, also SOC 2');
  assert.equal(applyVocabularyCasing('claude code beats claude', v), 'Claude Code beats Claude');
  assert.equal(applyVocabularyCasing('dall-e and grpc', v), 'DALL-E and gRPC');
});

test('a precompiled vocabulary gives the same result; empty input is safe', () => {
  const v = mergeVocabulary(['Zensible']);
  const c = compileVocabulary(v);
  assert.equal(applyVocabularyCasing('zensible on aws', c), 'Zensible on AWS');
  assert.equal(applyVocabularyCasing('', c), '');
  assert.equal(applyVocabularyCasing('text', []), 'text');
  assert.equal(compileVocabulary([]), null);
  // Regex metacharacters in a user word are literal.
  assert.equal(applyVocabularyCasing('c++ and c+', ['C++']), 'C++ and c+');
});
