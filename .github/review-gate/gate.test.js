// Run: node --test .github/review-gate/gate.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, parseOwners, agentMayApprove, ownersOf, run: runGate } = require('./gate.js');

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

// Root locations Copilot code review read from the PR head in tests (#97); nested copies were ignored.
const AGENT_INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'REVIEW.md',
  'agents.md',
  '.github/copilot-instructions.md',
  '.github/instructions/review.instructions.md',
  '.github/skills/x/SKILL.md',
  '.claude/skills/x/SKILL.md',
  '.agents/skills/x/SKILL.md',
  '.agents/skills/x/helper.sh',
];
const NOT_READ_BY_COPILOT = [
  'backend/AGENTS.md',
  'backend/CLAUDE.md',
  'client/src/GEMINI.md',
  'backend/REVIEW.md',
  'backend/.github/copilot-instructions.md',
  'backend/.github/instructions/review.instructions.md',
  'backend/.claude/skills/x/SKILL.md',
  'backend/x.instructions.md',
  'skills/x/SKILL.md',
  '.claude/settings.json',
  'AGENTS.md.bak',
];

test('root agent instruction and skill files are never agent-approvable; nested copies still are', () => {
  const rules = parseOwners(AGENTOWNERS + '\n* copilot');
  for (const f of AGENT_INSTRUCTION_FILES) assert.equal(agentMayApprove(rules, f, 'copilot'), false, f);
  for (const f of NOT_READ_BY_COPILOT) assert.equal(agentMayApprove(rules, f, 'copilot'), true, f);
});

test('copilot approval cannot merge a PR that adds root agent instructions', () => {
  const agentowners = AGENTOWNERS + '\n* copilot';
  const decideWith = (files) => decide({ pr: pr(), files, reviews: [copilot('APPROVED')], codeowners: CODEOWNERS, agentowners });
  for (const f of ['AGENTS.md', 'REVIEW.md', '.claude/skills/x/SKILL.md']) {
    const r = decideWith(['backend/A.java', f]);
    assert.equal(r.state, 'pending', f);
    assert.match(r.description, /copilot may not approve 1 file/);
  }
  for (const f of ['backend/AGENTS.md', 'skills/x/SKILL.md'])
    assert.equal(decideWith(['backend/A.java', f]).state, 'success', f);
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

test('team owners match case-insensitively, for team name and login', () => {
  const r = decide({
    pr: pr(),
    files: ['backend/A.java'],
    reviews: [human('Alice', 'APPROVED')],
    codeowners: '/backend/ @Review-Gate-Test-Org/Backend',
    agentowners: '',
    teams: { '@review-gate-test-org/backend': new Set(['alice']) },
  });
  assert.equal(r.state, 'success');
});

test('awaiting lists agents whose head review is missing and could turn the gate green', () => {
  assert.deepEqual(run(['backend/A.java'], []).awaiting, ['copilot']);
  assert.deepEqual(run(['backend/A.java'], [copilot('APPROVED', 'old')]).awaiting, ['copilot']);
  assert.deepEqual(run(['backend/A.java'], [copilot('COMMENTED')]).awaiting, []);
  assert.deepEqual(run(['backend/A.java', 'README.md'], []).awaiting, []);
  assert.equal(run(['backend/A.java'], [], { pr: { draft: true } }).awaiting, undefined);
  assert.equal(run(['backend/A.java'], [human('JacobiCamunda', 'CHANGES_REQUESTED')]).awaiting, undefined);
});

// Fake Octokit: one open PR touching backend/A.java; `reviewsAt(poll)` and `headAt(poll)` script each poll.
const fakeGithub = ({ reviewsAt = () => [], headAt = () => SHA, baseAt = () => 'main', state = 'open' } = {}) => {
  let polls = 0;
  const statuses = [];
  const rulesRefs = new Set();
  const prAt = () => ({ number: 1, state, draft: false, base: { ref: baseAt(polls) }, head: { sha: headAt(polls) }, user: { login: 'author' } });
  const github = {
    paginate: async (fn, params) => (await fn(params)).data,
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        getContent: async ({ path, ref }) => {
          rulesRefs.add(ref);
          const text = { '.github/CODEOWNERS': CODEOWNERS, '.github/AGENTOWNERS': AGENTOWNERS }[path];
          if (!text) throw Object.assign(new Error('nf'), { status: 404 });
          return { data: { content: Buffer.from(text).toString('base64') } };
        },
        createCommitStatus: async (s) => statuses.push(s),
      },
      pulls: {
        list: async () => ({ data: [prAt()] }),
        get: async () => ({ data: prAt() }),
        listFiles: async () => ({ data: [{ filename: 'backend/A.java' }] }),
        listReviews: async () => ({ data: reviewsAt(polls) }),
      },
      teams: { listMembersInOrg: async () => ({ data: [] }) },
    },
  };
  const opts = { waitMs: 60_000, pollMs: 1, sleep: async () => { polls++; } };
  const go = (payload) =>
    runGate({ github, context: { repo: { owner: 'o', repo: 'r' }, payload, serverUrl: 's', runId: 1 }, core: { info() {}, warning() {} } }, opts);
  return { go, statuses, polls: () => polls, rulesRefs };
};

test('single-PR run waits for copilot and posts its verdict', async () => {
  const f = fakeGithub({ reviewsAt: (n) => (n >= 2 ? [copilot('APPROVED')] : []) });
  await f.go({ pull_request: { number: 1 } });
  assert.deepEqual(f.statuses.map((s) => s.state), ['pending', 'success']);
  assert.match(f.statuses[0].description, /Waiting for copilot/);
  assert.ok(f.statuses.every((s) => Object.keys(s).every((k) => k !== 'awaiting')));
  assert.equal(f.polls(), 2);
});

test('waiting stops on a non-approving copilot review', async () => {
  const f = fakeGithub({ reviewsAt: (n) => (n >= 1 ? [copilot('COMMENTED')] : []) });
  await f.go({ pull_request: { number: 1 } });
  assert.deepEqual(f.statuses.map((s) => s.state), ['pending', 'pending']);
  assert.match(f.statuses[1].description, /copilot has not approved/);
});

test('waiting stops without posting when the head moves', async () => {
  const f = fakeGithub({ headAt: (n) => (n >= 1 ? 'newer' : SHA) });
  await f.go({ pull_request: { number: 1 } });
  assert.equal(f.statuses.length, 1);
  assert.equal(f.statuses[0].sha, SHA);
});

test('waiting gives up at the deadline and leaves the gate pending', async () => {
  const f = fakeGithub();
  const realNow = Date.now;
  let t = 0;
  Date.now = () => (t += 20_000);
  try {
    await f.go({ pull_request: { number: 1 } });
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(f.statuses.map((s) => s.state), ['pending', 'pending']);
  assert.ok(f.polls() >= 1 && f.polls() <= 3);
});

test('schedule runs never wait', async () => {
  const f = fakeGithub();
  await f.go({});
  assert.equal(f.polls(), 0);
  assert.deepEqual(f.statuses.map((s) => s.state), ['pending']);
});

test('waiting stops without posting when the PR is retargeted, and rules come from the default branch', async () => {
  const f = fakeGithub({ baseAt: (n) => (n >= 1 ? 'release' : 'main'), reviewsAt: () => [] });
  await f.go({ pull_request: { number: 1 } });
  assert.equal(f.statuses.length, 1);
  assert.deepEqual([...f.rulesRefs], ['main']);
});

test('a relay for an older commit re-evaluates the PR head by PR number', async () => {
  const f = fakeGithub({ reviewsAt: () => [copilot('APPROVED')] });
  await f.go({ workflow_run: { head_sha: 'older', pull_requests: [{ number: 1 }] } });
  assert.deepEqual(f.statuses.map((s) => [s.sha, s.state]), [[SHA, 'success']]);
});

test('a relay without pull_requests (fork) falls back to head SHA matching', async () => {
  const f = fakeGithub({ reviewsAt: () => [copilot('APPROVED')] });
  await f.go({ workflow_run: { head_sha: 'older', pull_requests: [] } });
  assert.equal(f.statuses.length, 0);
  await f.go({ workflow_run: { head_sha: SHA, pull_requests: [] } });
  assert.deepEqual(f.statuses.map((s) => s.state), ['success']);
});
