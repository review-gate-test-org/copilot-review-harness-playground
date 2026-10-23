'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { combine } = require('./run.js');

const entry = (number, state, description = `${state} ${number}`) => ({ pr: { number }, result: state && { state, description } });

test('single PR: its own decision', () => {
  assert.deepEqual(combine([entry(1, 'success', 'Approved by Copilot (1 file)')]), { state: 'success', description: 'Approved by Copilot (1 file)' });
  assert.equal(combine([entry(1, 'pending')]).state, 'pending');
});

test('shared head SHA: success only if every PR passes', () => {
  const both = combine([entry(1, 'success'), entry(2, 'pending', 'Needs @x (1 file)')]);
  assert.equal(both.state, 'pending');
  assert.equal(both.description, '#2: Needs @x (1 file)');
  assert.equal(combine([entry(1, 'success'), entry(2, 'success')]).state, 'success');
});

test('evaluation error → pending', () => {
  const r = combine([{ pr: { number: 3 } }]);
  assert.deepEqual(r, { state: 'pending', description: 'Evaluation error; see the workflow run' });
});

test('description is capped at 140 chars', () => {
  const many = Array.from({ length: 20 }, (_, i) => entry(i, 'pending', 'Needs @someone (3 files)'));
  assert.ok(combine(many).description.length <= 140);
});

test('evaluatePr rejects a PR whose head moved during evaluation', async () => {
  const { evaluatePr } = require('./run.js');
  const listed = { number: 7, head: { sha: 'A' }, base: { sha: 'base', ref: 'main' }, user: { login: 'someone' } };
  const refreshed = { ...listed, head: { sha: 'B' }, changed_files: 1 };
  const approvalForB = { user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' }, state: 'APPROVED', commit_id: 'B', submitted_at: '2026-10-23T10:00:00Z' };
  const responses = new Map([
    ['listReviews', [approvalForB]],
    ['listFiles', [{ filename: 'client/src/a.ts' }]],
  ]);
  const github = {
    paginate: async (fn) => responses.get(fn.name),
    rest: {
      pulls: { listReviews: function listReviews() {}, listFiles: function listFiles() {}, get: async () => ({ data: refreshed }) },
      repos: {
        getContent: async ({ path }) => {
          if (path !== '.github/review-policy.json') throw Object.assign(new Error('nf'), { status: 404 });
          const config = JSON.stringify({ copilotAllowlist: ['/client/'] });
          return { data: { content: Buffer.from(config).toString('base64'), encoding: 'base64' } };
        },
      },
    },
  };
  const context = { repo: { owner: 'o', repo: 'r' } };
  const core = { info() {}, warning() {} };
  await assert.rejects(evaluatePr({ github, context, core, pr: listed, policySource: 'base' }), /changed during evaluation/);
  // Unchanged head B: the approval of B counts.
  const same = { ...listed, head: { sha: 'B' } };
  const ok = await evaluatePr({ github, context, core, pr: same, policySource: 'base' });
  assert.equal(ok.state, 'success');
});
