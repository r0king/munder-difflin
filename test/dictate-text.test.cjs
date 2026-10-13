'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { cleanTranscript, fitToContext, MAX_DICTATION_TEXT } = loadTs('src/shared/features/dictate.ts');

test('clean-up: whitespace collapses, sound tags go, the words stay', () => {
  assert.equal(cleanTranscript('  Hello   there.\n How are you? '), 'Hello there. How are you?');
  assert.equal(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.equal(cleanTranscript('[ Silence ] Ship it. [Music]'), 'Ship it.');
  assert.equal(cleanTranscript('(upbeat music)'), '');
  assert.equal(cleanTranscript('Call it (roughly) done.'), 'Call it (roughly) done.');
  assert.equal(cleanTranscript('... and then we merged'), 'and then we merged');
  assert.equal(cleanTranscript(''), '');
  assert.equal(cleanTranscript(null), '');
});

test('clean-up caps the length', () => {
  assert.equal(cleanTranscript('a'.repeat(MAX_DICTATION_TEXT + 50)).length, MAX_DICTATION_TEXT);
});

test('an empty field gets the sentence as spoken', () => {
  assert.equal(fitToContext('Ship it today.', '', ''), 'Ship it today.');
  assert.equal(fitToContext('ship it today.', '', ''), 'Ship it today.');
});

test('after a word: a space goes in front and the capital drops', () => {
  assert.equal(fitToContext('Maybe tomorrow.', 'I think', ''), ' maybe tomorrow.');
  assert.equal(fitToContext('Maybe tomorrow.', 'I think ', ''), 'maybe tomorrow.');
  assert.equal(fitToContext('Maybe tomorrow.', 'Done,', ''), ' maybe tomorrow.');
});

test('after a full stop: a space, and the sentence keeps its capital', () => {
  assert.equal(fitToContext('next one.', 'First one.', ''), ' Next one.');
  assert.equal(fitToContext('Next one.', 'First one. ', ''), 'Next one.');
  assert.equal(fitToContext('next one.', 'Line one\n', ''), 'Next one.');
});

test('names, acronyms, CamelCase and "I" keep their case mid-sentence', () => {
  assert.equal(fitToContext("I'll do it.", 'Fine,', ''), " I'll do it.");
  assert.equal(fitToContext('ARR grew.', 'and', ''), ' ARR grew.');
  assert.equal(fitToContext('GitHub is down.', 'and', ''), ' GitHub is down.');
  const keepCase = (w) => ['Claude', 'Kubernetes'].includes(w);
  assert.equal(fitToContext('Claude wrote it.', 'and', '', { keepCase }), ' Claude wrote it.');
  assert.equal(fitToContext('Claude, wrote it.', 'and', '', { keepCase }), ' Claude, wrote it.');
});

test('no space after an opening bracket or quote, none before punctuation', () => {
  assert.equal(fitToContext('Like this.', 'see (', ''), 'like this.');
  assert.equal(fitToContext('Quoted.', 'he said "', ''), 'quoted.');
  assert.equal(fitToContext(', and more.', 'one', ''), ', and more.');
});

test('mid-line: the full stop goes when the line carries on, and a space joins the next word', () => {
  assert.equal(fitToContext('Really quickly.', 'We', 'shipped it'), ' really quickly ');
  assert.equal(fitToContext('Really quickly.', 'We ', ' shipped it'), 'really quickly');
  assert.equal(fitToContext('Is it done?', 'Hey', 'then'), ' is it done? ');
  // Capitalised text after the caret: keep the stop.
  assert.equal(fitToContext('All done.', 'Ok.', ' Next'), ' All done.');
});

test('nothing to insert stays nothing', () => {
  assert.equal(fitToContext('[BLANK_AUDIO]', 'abc', 'def'), '');
});
