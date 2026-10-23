'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { patternToRegExp, parseCodeowners, ownersFor, evaluate } = require('./policy.js');
const config = require('../review-policy.json');

const HEAD = 'head-sha';
const codeowners = parseCodeowners(`
# comment
/backend/ @JacobiCamunda
/client/  @venetrius
/shared/  @venetrius @JacobiCamunda
/teams/   @acme/platform
/nobody/
`);

const pr = (author = 'someone') => ({ head: { sha: HEAD }, user: { login: author }, changed_files: 0 });
const files = (...names) => names.map((filename) => ({ filename }));
let t = 0;
const review = (login, state, extra = {}) => ({
  user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' },
  state,
  commit_id: HEAD,
  author_association: 'COLLABORATOR',
  submitted_at: new Date(Date.UTC(2026, 9, 23, 10, 0, t++)).toISOString(),
  ...extra,
});
const copilotOk = () => review('copilot-pull-request-reviewer[bot]', 'APPROVED', { author_association: 'NONE' });
const run = ({ author, paths, reviews, teamMembers }) =>
  evaluate({ config, pr: { ...pr(author), changed_files: paths.length }, files: files(...paths), reviews, codeowners, teamMembers });

test('pattern semantics follow CODEOWNERS', () => {
  const m = (p, path) => patternToRegExp(p).test(path);
  assert.ok(m('/backend/', 'backend/src/A.java'));
  assert.ok(!m('/backend/', 'x/backend/A.java'));
  assert.ok(m('apps/', 'x/apps/a.js'));
  assert.ok(m('*.md', 'README.md'));
  assert.ok(m('*.md', 'client/docs/x.md'));
  assert.ok(m('pom.xml', 'backend/pom.xml'));
  assert.ok(m('docs/*', 'docs/a.md'));
  assert.ok(!m('docs/*', 'docs/sub/a.md'));
  assert.ok(m('docs/**', 'docs/sub/a.md'));
  assert.ok(m('**/logs', 'a/b/logs/x.log'));
  assert.ok(m('/.github/', '.github/workflows/ci.yml'));
  assert.ok(!m('/backend/', 'backend'));
});

test('CODEOWNERS: last match wins, owner-less rule un-owns', () => {
  const rules = parseCodeowners('* @all\n/docs/ @docs\n/docs/public/');
  assert.deepEqual(ownersFor('src/a.js', rules), ['@all']);
  assert.deepEqual(ownersFor('docs/a.md', rules), ['@docs']);
  assert.deepEqual(ownersFor('docs/public/a.md', rules), []);
});

test('Copilot approval covers allowlisted paths', () => {
  const r = run({ paths: ['backend/src/main/A.java', 'client/src/App.tsx'], reviews: [copilotOk()] });
  assert.equal(r.state, 'success');
  assert.match(r.description, /Copilot \(2 files\)/);
});

test('no approval → pending, naming owner and Copilot', () => {
  const r = run({ paths: ['backend/src/main/A.java'], reviews: [] });
  assert.equal(r.state, 'pending');
  assert.equal(r.description, 'Needs @JacobiCamunda or Copilot (1 file)');
});

test('blocklist overrides allowlist: Copilot alone is not enough', () => {
  const r = run({ paths: ['backend/pom.xml', 'backend/src/A.java'], reviews: [copilotOk()] });
  assert.equal(r.state, 'pending');
  assert.equal(r.description, 'Needs @JacobiCamunda (1 file)');
});

test('path outside allowlist needs its code owner', () => {
  const r = run({ paths: ['backend/README.txt'], reviews: [copilotOk()] });
  assert.equal(r.state, 'pending');
  const ok = run({ paths: ['backend/README.txt'], reviews: [copilotOk(), review('JacobiCamunda', 'APPROVED')] });
  assert.equal(ok.state, 'success');
});

test('code owner approval covers blocklisted path', () => {
  const r = run({ paths: ['backend/pom.xml'], reviews: [review('jacobicamunda', 'APPROVED')] });
  assert.equal(r.state, 'success');
  assert.equal(r.description, 'Approved by @jacobicamunda (1 file)');
});

test('mixed coverage: Copilot for allowlisted, owner for the rest', () => {
  const r = run({ paths: ['client/src/a.ts', 'backend/pom.xml'], reviews: [copilotOk(), review('JacobiCamunda', 'APPROVED')] });
  assert.equal(r.state, 'success');
  assert.match(r.description, /Copilot \(1 file\), @jacobicamunda \(1 file\)/);
});

test('approval from a non-owner does not cover an owned path', () => {
  const r = run({ paths: ['backend/pom.xml'], reviews: [review('venetrius', 'APPROVED')] });
  assert.equal(r.state, 'pending');
});

test('any owner of a multi-owner path is enough', () => {
  assert.equal(run({ paths: ['shared/x.ts'], reviews: [review('venetrius', 'APPROVED')] }).state, 'success');
});

test('author is sole owner → any trusted collaborator or Copilot covers it', () => {
  const pending = run({ author: 'venetrius', paths: ['client/package.json'], reviews: [] });
  assert.equal(pending.description, 'Needs a maintainer (1 file)');
  const external = review('rando', 'APPROVED', { author_association: 'CONTRIBUTOR' });
  assert.equal(run({ author: 'venetrius', paths: ['client/package.json'], reviews: [external] }).state, 'pending');
  assert.equal(run({ author: 'venetrius', paths: ['client/package.json'], reviews: [review('JacobiCamunda', 'APPROVED')] }).state, 'success');
  assert.equal(run({ author: 'venetrius', paths: ['client/src/a.ts'], reviews: [copilotOk()] }).state, 'success');
});

test('author on a multi-owner path still needs another owner', () => {
  const r = run({ author: 'venetrius', paths: ['shared/x.ts'], reviews: [] });
  assert.equal(r.description, 'Needs @JacobiCamunda (1 file)');
});

test('unowned blocklisted path needs a trusted human', () => {
  assert.equal(run({ paths: ['.github/workflows/ci.yml'], reviews: [copilotOk()] }).state, 'pending');
  assert.equal(run({ paths: ['.github/workflows/ci.yml'], reviews: [review('JacobiCamunda', 'APPROVED')] }).state, 'success');
});

test('owner-less rule makes a path unowned', () => {
  const r = run({ paths: ['nobody/x.txt'], reviews: [review('JacobiCamunda', 'APPROVED')] });
  assert.equal(r.state, 'success');
});

test('stale approvals (older commit) do not count', () => {
  const stale = { ...copilotOk(), commit_id: 'old' };
  assert.equal(run({ paths: ['client/src/a.ts'], reviews: [stale] }).state, 'pending');
  const staleHuman = review('venetrius', 'APPROVED', { commit_id: 'old' });
  assert.equal(run({ paths: ['client/package.json'], reviews: [staleHuman] }).state, 'pending');
});

test('latest decisive review wins; COMMENTED does not reset it', () => {
  const approveThenChanges = [review('venetrius', 'APPROVED'), review('venetrius', 'CHANGES_REQUESTED')];
  assert.equal(run({ paths: ['client/package.json'], reviews: approveThenChanges }).state, 'pending');
  const approveThenComment = [review('venetrius', 'APPROVED'), review('venetrius', 'COMMENTED')];
  assert.equal(run({ paths: ['client/package.json'], reviews: approveThenComment }).state, 'success');
  const dismissed = [copilotOk(), review('copilot-pull-request-reviewer[bot]', 'DISMISSED')];
  assert.equal(run({ paths: ['client/src/a.ts'], reviews: dismissed }).state, 'pending');
});

test('Copilot non-approval verdicts (COMMENTED) never cover', () => {
  const commented = review('copilot-pull-request-reviewer[bot]', 'COMMENTED');
  assert.equal(run({ paths: ['client/src/a.ts'], reviews: [commented] }).state, 'pending');
});

test('a later non-green Copilot review revokes its earlier approval', () => {
  const approvedThenYellow = [copilotOk(), review('copilot-pull-request-reviewer[bot]', 'COMMENTED', { author_association: 'NONE' })];
  assert.equal(run({ paths: ['client/src/a.ts'], reviews: approvedThenYellow }).state, 'pending');
  const yellowThenApproved = [review('copilot-pull-request-reviewer[bot]', 'COMMENTED', { author_association: 'NONE' }), copilotOk()];
  assert.equal(run({ paths: ['client/src/a.ts'], reviews: yellowThenApproved }).state, 'success');
});

test('other bots cannot act as approvers', () => {
  const bot = review('evil[bot]', 'APPROVED');
  assert.equal(run({ paths: ['client/package.json'], reviews: [bot] }).state, 'pending');
});

test('rename checks both old and new path', () => {
  const renamed = [{ filename: 'client/src/a.ts', previous_filename: '.github/a.ts' }];
  const r = evaluate({ config, pr: { ...pr(), changed_files: 1 }, files: renamed, reviews: [copilotOk()], codeowners });
  assert.equal(r.state, 'pending');
});

test('team owners resolved via teamMembers; unresolved teams are reported', () => {
  const reviews = [review('alice', 'APPROVED')];
  assert.equal(run({ paths: ['teams/x'], reviews, teamMembers: { '@acme/platform': ['alice'] } }).state, 'success');
  const unresolved = run({ paths: ['teams/x'], reviews });
  assert.equal(unresolved.state, 'pending');
  assert.match(unresolved.notes[0], /@acme\/platform/);
});

test('truncated file list stays pending', () => {
  const r = evaluate({ config, pr: { ...pr(), changed_files: 5000 }, files: files('client/src/a.ts'), reviews: [copilotOk()], codeowners });
  assert.equal(r.state, 'pending');
});

test('description fits the 140-char status limit', () => {
  const many = Array.from({ length: 30 }, (_, i) => `dir${i}/x`);
  const rules = parseCodeowners(many.map((p, i) => `/${p.split('/')[0]}/ @owner-with-a-long-name-${i}`).join('\n'));
  const r = evaluate({ config, pr: { ...pr(), changed_files: many.length }, files: files(...many), reviews: [], codeowners: rules });
  assert.ok(r.description.length <= 140);
});
