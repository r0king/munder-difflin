'use strict';

// Workspace sidebar: which project (repository) an agent is grouped under.
// The cases that matter are the ones that used to go wrong elsewhere: an
// isolated agent whose cwd is its own worktree, two repos that share a folder
// name, Windows paths that arrive in two spellings, and paths with spaces.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  normalizePath,
  pathBasename,
  isPathInside,
  isIsolatedWorktree,
  projectIdentity,
  groupAgentsByProject
} = loadTs('src/shared/workspace/sidebarProjects.ts');

test('normalizePath: one spelling per folder on every platform', () => {
  assert.equal(normalizePath('/Users/pam/work/app/'), '/Users/pam/work/app');
  assert.equal(normalizePath('/Users/pam//work/./app'), '/Users/pam/work/app');
  assert.equal(normalizePath('/Users/pam/work/x/../app'), '/Users/pam/work/app');
  // Windows: separators unified and case folded, so a dialog's C:\Work and a
  // shell's c:/work are the same folder.
  assert.equal(normalizePath('C:\\Work\\App\\'), 'c:/work/app');
  assert.equal(normalizePath('c:/work/app'), 'c:/work/app');
  // UNC shares too.
  assert.equal(normalizePath('\\\\Server\\Share\\Repo'), '//server/share/repo');
  // POSIX keeps case: Linux is case-sensitive.
  assert.notEqual(normalizePath('/home/a/App'), normalizePath('/home/a/app'));
  // Spaces survive untouched.
  assert.equal(normalizePath('/Users/Pam Beesly/My Repo/'), '/Users/Pam Beesly/My Repo');
  assert.equal(normalizePath(''), '');
  assert.equal(normalizePath('/..'), '/');
});

test('pathBasename splits on both separators', () => {
  assert.equal(pathBasename('C:\\work\\my app'), 'my app');
  assert.equal(pathBasename('/srv/repos/api/'), 'api');
  assert.equal(pathBasename(''), '');
});

test('isPathInside is segment-aware, not a string prefix', () => {
  assert.equal(isPathInside('/a/hive/worktrees/x', '/a/hive/worktrees'), true);
  assert.equal(isPathInside('/a/hive/worktrees-old/x', '/a/hive/worktrees'), false);
  assert.equal(isPathInside('C:\\Hive\\worktrees\\x', 'c:/hive/worktrees'), true);
});

test('an isolated agent is recognised by worktreePath or by living under <home>/worktrees', () => {
  assert.equal(isIsolatedWorktree({ id: 'a', cwd: '/x', worktreePath: '/h/worktrees/a' }), true);
  assert.equal(isIsolatedWorktree({ id: 'a', cwd: '/h/worktrees/a' }, '/h'), true);
  assert.equal(isIsolatedWorktree({ id: 'a', cwd: '/h/worktrees' }, '/h'), false);
  assert.equal(isIsolatedWorktree({ id: 'a', cwd: '/src/app' }, '/h'), false);
});

test('the resolved repository root is the identity when we have it', () => {
  const id = projectIdentity(
    { id: 'jim', cwd: '/h/worktrees/jim', worktreePath: '/h/worktrees/jim', project: 'app' },
    { repoRoot: '/Users/pam/client-a/app', harnessHome: '/h' }
  );
  assert.deepEqual(id, { key: 'path:/Users/pam/client-a/app', name: 'app', path: '/Users/pam/client-a/app' });
});

test('an unresolved worktree agent falls back to the folder the user picked', () => {
  const id = projectIdentity(
    { id: 'jim', cwd: '/h/worktrees/jim', worktreePath: '/h/worktrees/jim', project: 'App' },
    { repoRoot: null, harnessHome: '/h' }
  );
  // Never the worktree's basename (that is the agent id).
  assert.equal(id.name, 'App');
  assert.equal(id.key, 'name:app');
});

test('a plain folder groups by its own path, named after its basename', () => {
  const id = projectIdentity({ id: 'd', cwd: 'C:\\Users\\Dwight\\Beet Farm\\', project: 'Beet Farm' }, { repoRoot: null });
  assert.equal(id.key, 'path:c:/users/dwight/beet farm');
  assert.equal(id.name, 'Beet Farm');
});

test('no folder at all still yields a key', () => {
  assert.deepEqual(projectIdentity({ id: 'x' }), { key: 'none', name: '', path: null });
});

test('agents sharing a repo are one group; a subfolder resolves into its repo', () => {
  const roots = {
    '/r/app': '/r/app',
    '/r/app/packages/web': '/r/app',
    '/h/worktrees/jim': '/r/app',
    '/r/api': '/r/api'
  };
  const agents = [
    { id: 'dwight', cwd: '/r/app', project: 'app' },
    { id: 'angela', cwd: '/r/api', project: 'api' },
    { id: 'pam', cwd: '/r/app/packages/web', project: 'web' },
    { id: 'jim', cwd: '/h/worktrees/jim', worktreePath: '/h/worktrees/jim', project: 'app' }
  ];
  const groups = groupAgentsByProject(agents, (a) => projectIdentity(a, { repoRoot: roots[a.cwd], harnessHome: '/h' }));
  assert.deepEqual(groups.map((g) => [g.name, g.members.map((m) => m.id)]), [
    ['app', ['dwight', 'pam', 'jim']],
    ['api', ['angela']]
  ]);
});

test('a worktree agent whose lookup failed folds into the one repo with its name', () => {
  const agents = [
    { id: 'dwight', cwd: '/r/app', project: 'app' },
    { id: 'jim', cwd: '/h/worktrees/jim', worktreePath: '/h/worktrees/jim', project: 'app' }
  ];
  const roots = { '/r/app': '/r/app', '/h/worktrees/jim': null };
  const groups = groupAgentsByProject(agents, (a) => projectIdentity(a, { repoRoot: roots[a.cwd], harnessHome: '/h' }));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members.map((m) => m.id), ['dwight', 'jim']);
});

test('…but is not guessed into one of two same-named repos', () => {
  const agents = [
    { id: 'a', cwd: '/client-a/app', project: 'app' },
    { id: 'b', cwd: '/client-b/app', project: 'app' },
    { id: 'jim', cwd: '/h/worktrees/jim', worktreePath: '/h/worktrees/jim', project: 'app' }
  ];
  const groups = groupAgentsByProject(agents, (a) => projectIdentity(a, { repoRoot: null, harnessHome: '/h' }));
  assert.equal(groups.length, 3);
  // The two path groups say which client they are.
  const details = groups.filter((g) => g.path).map((g) => g.detail).sort();
  assert.deepEqual(details, ['client-a', 'client-b']);
});

test('same-named repos stay separate and get a parent-folder detail', () => {
  const agents = [
    { id: 'a', cwd: '/client-a/app' },
    { id: 'b', cwd: '/client-b/app' }
  ];
  const groups = groupAgentsByProject(agents, (a) => projectIdentity(a, { repoRoot: a.cwd }));
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.detail), ['client-a', 'client-b']);
});
