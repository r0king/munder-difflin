'use strict';

// The transcript parser behind the Workspace agent cards and rooms: an agent's
// own words, its current tool call with the argument, and that call's result,
// read off a Claude Code session .jsonl (usually a TAIL of it).

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  parseTranscript,
  transcriptActivity,
  summarizeToolInput,
  resultSummaryLine,
  classifyPromptText,
  toolDisplayName
} = loadTs('src/shared/workspace/agentsTranscript.ts');

const line = (o) => JSON.stringify(o);
const at = (s) => `2026-10-12T10:00:${String(s).padStart(2, '0')}.000Z`;

function sample() {
  return [
    // A tail read cuts the first record in half — it must be skipped, not fatal.
    '"type":"assistant","message":{"content":[{"type":"text","text":"cut',
    line({ type: 'user', uuid: 'u1', timestamp: at(1), message: { role: 'user', content: 'Fix the flaky login test' } }),
    line({ type: 'assistant', uuid: 'a1', timestamp: at(2), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Let me run the tests.' }] } }),
    line({ type: 'assistant', uuid: 'a2', timestamp: at(3), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test auth/login\nsecond line', description: 'run' } }] } }),
    line({ type: 'user', uuid: 'u2', timestamp: at(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '\u001b[32mPASS\u001b[0m a\nTests: 14 passed, 1 failed, 15 total\nTime: 3s' }] } }),
    line({ type: 'assistant', uuid: 'a3', timestamp: at(5), isSidechain: true, message: { id: 'm9', content: [{ type: 'text', text: 'subagent chatter' }] } }),
    line({ type: 'user', uuid: 'u3', timestamp: at(6), isMeta: true, message: { content: 'Caveat: meta' } }),
    line({ type: 'assistant', uuid: 'a4', timestamp: at(7), message: { id: 'm2', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Running the login tests again after the fix to the session cookie.' }] } }),
    line({ type: 'system', uuid: 's1', subtype: 'compact_boundary', timestamp: at(8) })
  ].join('\n');
}

test('parses prompts, merged replies, tools and results, skipping cut, meta and sidechain records', () => {
  const ev = parseTranscript(sample());
  assert.deepEqual(ev.map((e) => e.kind), ['prompt', 'reply', 'tool', 'result', 'reply', 'compact']);
  assert.equal(ev[0].text, 'Fix the flaky login test');
  assert.equal(ev[2].text, 'npm test auth/login');
  assert.equal(ev[2].tool, 'Bash');
  assert.equal(ev[3].text, 'Tests: 14 passed, 1 failed, 15 total');
  assert.equal(ev[3].tool, 'Bash', 'a result knows the tool it answers');
  assert.ok(!ev.some((e) => e.text.includes('subagent')));
});

test('text blocks of one assistant message become one reply', () => {
  const text = [
    line({ type: 'assistant', uuid: 'x1', timestamp: at(1), message: { id: 'mm', content: [{ type: 'text', text: 'First.' }] } }),
    line({ type: 'assistant', uuid: 'x2', timestamp: at(2), message: { id: 'mm', content: [{ type: 'text', text: 'Second.' }] } })
  ].join('\n');
  const ev = parseTranscript(text);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].text, 'First.\n\nSecond.');
  assert.equal(ev[0].ts, Date.parse(at(1)));
});

test('activity: newest reply, newest tool, and that tool\'s result', () => {
  const act = transcriptActivity(parseTranscript(sample()));
  assert.equal(act.lastReply.text, 'Running the login tests again after the fix to the session cookie.');
  assert.equal(act.lastTool.text, 'npm test auth/login');
  assert.equal(act.lastResult.text, 'Tests: 14 passed, 1 failed, 15 total');
  assert.equal(act.lastResult.isError, false);
});

test('activity: a tool still running has no result yet', () => {
  const text = [
    line({ type: 'assistant', uuid: 'a', timestamp: at(1), message: { id: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/Users/me/My Repo/src/auth/login.ts' } }] } })
  ].join('\n');
  const act = transcriptActivity(parseTranscript(text));
  assert.equal(act.lastTool.text, 'src/auth/login.ts');
  assert.equal(act.lastResult, undefined);
});

test('empty and garbage input never throws', () => {
  assert.deepEqual(parseTranscript(''), []);
  assert.deepEqual(parseTranscript('not json\n{broken\n[]\n"str"'), []);
  assert.deepEqual(transcriptActivity([]), {});
});

test('summarizeToolInput says the argument the way a person would', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(summarizeToolInput('Edit', { file_path: 'C:\\Users\\me\\repo\\src\\a.ts' }), 'repo/src/a.ts');
  assert.equal(summarizeToolInput('Grep', { pattern: 'TODO', path: '/x/y/src' }), 'TODO in y/src');
  assert.equal(summarizeToolInput('WebFetch', { url: 'https://example.com/a' }), 'example.com/a');
  assert.equal(summarizeToolInput('mcp__github__create_issue', { title: 'Bug', body: 'x'.repeat(1000) }), 'Bug');
  assert.ok(summarizeToolInput('Bash', { command: 'x'.repeat(500) }).length <= 160);
  assert.equal(summarizeToolInput('Bash', null), '');
});

test('resultSummaryLine prefers a test summary, else the last line', () => {
  assert.equal(resultSummaryLine('a\nb\nlast one\n\n'), 'last one');
  assert.equal(resultSummaryLine([{ type: 'text', text: 'ok\n  3 passing\n  1 failing\ndone' }]), '1 failing');
  assert.equal(resultSummaryLine(''), '');
  assert.equal(resultSummaryLine({}), '');
});

test('classifyPromptText: commands, interruptions, wrappers', () => {
  assert.deepEqual(classifyPromptText('<command-name>/compact</command-name><command-message>compact</command-message><command-args></command-args>'), { kind: 'command', text: '/compact' });
  assert.deepEqual(classifyPromptText('<command-name>model</command-name><command-args>opus</command-args>'), { kind: 'command', text: '/model opus' });
  assert.deepEqual(classifyPromptText('[Request interrupted by user]'), { kind: 'interrupt' });
  assert.equal(classifyPromptText('<local-command-stdout>x</local-command-stdout>'), null);
  assert.equal(classifyPromptText('<system-reminder>ctx</system-reminder>'), null);
  assert.deepEqual(classifyPromptText('<system-reminder>ctx</system-reminder>\nhello'), { kind: 'prompt', text: 'hello' });
});

test('toolDisplayName reads MCP tools as server + tool', () => {
  assert.equal(toolDisplayName('mcp__github__create_issue'), 'github create_issue');
  assert.equal(toolDisplayName('Bash'), 'Bash');
});
