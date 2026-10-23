'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { matchesAny, evaluate } = require('./copilot-review-harness.js');
const config = require('../copilot-review-harness.json');

const head = 'abc123';
const pr = { state: 'open', draft: false, head: { sha: head } };
const copilot = (body, commit_id = head, submitted_at = '2026-10-23T10:00:00Z') => ({
  user: { login: config.copilotLogin }, body, commit_id, submitted_at, html_url: 'https://example/review',
});
const green = copilot('<!-- ccr-overview-v2 -->\n\n### 🟢 Approved\n\nLooks good.');
const files = (...names) => names.map((filename) => ({ filename }));

test('glob matching', () => {
  assert.ok(matchesAny('backend/src/main/java/A.java', ['backend/src/**']));
  assert.ok(matchesAny('README.md', ['**/*.md']));
  assert.ok(matchesAny('client/README.md', ['**/*.md']));
  assert.ok(matchesAny('backend/pom.xml', ['**/pom.xml']));
  assert.ok(!matchesAny('backend/pom.xml', ['backend/src/**']));
  assert.ok(!matchesAny('client/src/a.ts', ['client/*.ts']));
});

test('approves green review on approvable paths', () => {
  assert.equal(evaluate({ config, pr, reviews: [green], files: files('client/src/App.tsx') }).approve, true);
});

test('skips non-green verdicts', () => {
  for (const v of ['🟡 Changes recommended', '🔵 Comments', '🔴 Changes required']) {
    const r = evaluate({ config, pr, reviews: [copilot(`### ${v}`)], files: files('client/src/App.tsx') });
    assert.equal(r.approve, false, v);
  }
});

test('uses the latest Copilot review only', () => {
  const later = copilot('### 🟡 Changes recommended', head, '2026-10-23T11:00:00Z');
  assert.equal(evaluate({ config, pr, reviews: [green, later], files: files('client/src/App.tsx') }).approve, false);
});

test('skips stale review for an older commit', () => {
  const stale = copilot('### 🟢 Approved', 'old');
  assert.equal(evaluate({ config, pr, reviews: [stale], files: files('client/src/App.tsx') }).approve, false);
});

test('skips human-only and unlisted paths', () => {
  assert.equal(evaluate({ config, pr, reviews: [green], files: files('client/src/a.ts', '.github/workflows/ci.yml') }).approve, false);
  assert.equal(evaluate({ config, pr, reviews: [green], files: files('backend/pom.xml') }).approve, false);
  assert.equal(evaluate({ config, pr, reviews: [green], files: files('.gitignore') }).approve, false);
});

test('checks the old path of a rename', () => {
  const renamed = [{ filename: 'client/src/a.ts', previous_filename: '.github/a.ts' }];
  assert.equal(evaluate({ config, pr, reviews: [green], files: renamed }).approve, false);
});

test('ignores reviews from other users that mimic the verdict', () => {
  const fake = { ...green, user: { login: 'mallory' } };
  assert.equal(evaluate({ config, pr, reviews: [fake], files: files('client/src/a.ts') }).approve, false);
});

test('skips drafts and closed PRs', () => {
  assert.equal(evaluate({ config, pr: { ...pr, draft: true }, reviews: [green], files: files('client/src/a.ts') }).approve, false);
  assert.equal(evaluate({ config, pr: { ...pr, state: 'closed' }, reviews: [green], files: files('client/src/a.ts') }).approve, false);
});
