// Run: node --test .github/review-gate/gate.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, parseOwners, agentMayApprove, ownersOf } = require('./gate.js');

const CODEOWNERS = `
/backend/ @JacobiCamunda
/client/  @venetrius @acme/frontend
`;
const AGENTOWNERS = `
/backend/ copilot
/client/  copilot
/client/package-lock.json
`;
const SHA = 'head';
const pr = (extra = {}) => ({ draft: false, head: { sha: SHA }, user: { login: 'author' }, ...extra });
const human = (login, state, commit_id = SHA) => ({ user: { login, type: 'User' }, state, commit_id });
const copilot = (state, commit_id = SHA) => ({ user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' }, state, commit_id });
const run = (files, reviews, extra = {}) =>
  decide({ pr: pr(extra.pr), files, reviews, codeowners: CODEOWNERS, agentowners: AGENTOWNERS, teams: extra.teams });

test('glob matching follows CODEOWNERS semantics', () => {
  const rules = parseOwners('*.md docs\n/backend/ be\n/client/src/*.ts fe\nlock?.json x');
  assert.deepEqual(ownersOf(rules, 'README.md'), ['docs']);
  assert.deepEqual(ownersOf(rules, 'a/b/c.md'), ['docs']);
  assert.deepEqual(ownersOf(rules, 'backend/src/A.java'), ['be']);
  assert.deepEqual(ownersOf(rules, 'backendx/A.java'), []);
  assert.deepEqual(ownersOf(rules, 'x/backend/A.java'), []);
  assert.deepEqual(ownersOf(rules, 'client/src/a.ts'), ['fe']);
  assert.deepEqual(ownersOf(rules, 'client/src/deep/a.ts'), []);
  assert.deepEqual(ownersOf(rules, 'lock1.json'), ['x']);
  assert.deepEqual(ownersOf(rules, 'backend/.env'), ['be']);
});

test('AGENTOWNERS: last match wins, unmatched and hard-denied paths are not approvable', () => {
  const rules = parseOwners(AGENTOWNERS + '\n/.github/ copilot\n/CODEOWNERS copilot');
  assert.equal(agentMayApprove(rules, 'client/src/App.tsx', 'copilot'), true);
  assert.equal(agentMayApprove(rules, 'client/package-lock.json', 'copilot'), false);
  assert.equal(agentMayApprove(rules, 'README.md', 'copilot'), false);
  assert.equal(agentMayApprove(rules, 'client/src/App.tsx', 'otherbot'), false);
  assert.equal(agentMayApprove(rules, '.github/workflows/ci.yml', 'copilot'), false);
  assert.equal(agentMayApprove(rules, 'CODEOWNERS', 'copilot'), false);
});

test('draft stays pending', () => {
  assert.equal(run(['backend/A.java'], [human('JacobiCamunda', 'APPROVED')], { pr: { draft: true } }).state, 'pending');
});

test('code owner approval passes', () => {
  assert.deepEqual(run(['backend/A.java'], [human('JacobiCamunda', 'APPROVED')]), {
    state: 'success',
    description: 'Approved by code owners',
  });
});

test('code owners of every area must approve', () => {
  const files = ['backend/A.java', 'client/src/App.tsx'];
  const r = run(files, [human('JacobiCamunda', 'APPROVED')]);
  assert.equal(r.state, 'pending');
  assert.match(r.description, /@venetrius/);
  assert.equal(run(files, [human('JacobiCamunda', 'APPROVED'), human('venetrius', 'APPROVED')]).state, 'success');
});

test('team membership counts as code owner', () => {
  const teams = { '@acme/frontend': new Set(['alice']) };
  assert.equal(run(['client/src/App.tsx'], [human('alice', 'APPROVED')], { teams }).state, 'success');
  assert.equal(run(['client/src/App.tsx'], [human('bob', 'APPROVED')], { teams }).state, 'pending');
});

test('approval on an old commit does not count', () => {
  assert.equal(run(['backend/A.java'], [human('JacobiCamunda', 'APPROVED', 'old')]).state, 'pending');
  assert.equal(run(['backend/A.java'], [copilot('APPROVED', 'old')]).state, 'pending');
});

test('a later comment does not revoke a human approval', () => {
  assert.equal(run(['backend/A.java'], [human('JacobiCamunda', 'APPROVED'), human('JacobiCamunda', 'COMMENTED')]).state, 'success');
});

test('author and non-owners cannot satisfy code owners', () => {
  assert.equal(run(['backend/A.java'], [human('author', 'APPROVED')]).state, 'pending');
  assert.equal(run(['backend/A.java'], [human('random', 'APPROVED')]).state, 'pending');
});

test('unowned files need one human approval', () => {
  assert.equal(run(['README.md'], []).state, 'pending');
  assert.equal(run(['README.md'], [human('random', 'APPROVED')]).state, 'success');
});

test('copilot approval passes when all files are agent-approvable', () => {
  assert.deepEqual(run(['backend/A.java', 'client/src/App.tsx'], [copilot('APPROVED')]), {
    state: 'success',
    description: 'Approved by copilot (all files agent-approvable)',
  });
});

test('copilot approval is not enough when one file is not agent-approvable', () => {
  for (const f of ['README.md', 'client/package-lock.json', '.github/workflows/ci.yml']) {
    const r = run(['backend/A.java', f], [copilot('APPROVED')]);
    assert.equal(r.state, 'pending', f);
    assert.match(r.description, /copilot may not approve 1 file/);
  }
});

test('a later copilot comment on the head revokes its approval', () => {
  assert.equal(run(['backend/A.java'], [copilot('APPROVED'), copilot('COMMENTED')]).state, 'pending');
});

test('copilot comment without approval stays pending', () => {
  const r = run(['backend/A.java'], [copilot('COMMENTED')]);
  assert.equal(r.state, 'pending');
  assert.match(r.description, /copilot has not approved/);
});

test('outstanding change request blocks both branches', () => {
  const r = run(['backend/A.java'], [copilot('APPROVED'), human('JacobiCamunda', 'CHANGES_REQUESTED')]);
  assert.deepEqual(r, { state: 'pending', description: 'Changes requested by @JacobiCamunda' });
});

test('description fits the 140 char status limit', () => {
  const files = Array.from({ length: 50 }, (_, i) => `x${i}/f`);
  const owners = files.map((f, i) => `/${f} @someone-with-a-long-name-${i}`).join('\n');
  const r = decide({ pr: pr(), files, reviews: [], codeowners: owners, agentowners: '' });
  assert.ok(r.description.length <= 140);
});
