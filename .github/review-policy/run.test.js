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
