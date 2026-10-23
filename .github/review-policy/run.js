'use strict';

const fs = require('fs');
const nodePath = require('path');
const { parseCodeowners, ownersFor, evaluate } = require('./policy.js');

const CONFIG_PATH = '.github/review-policy.json';
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

async function readFile(github, { owner, repo, ref, path }) {
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, ref, path });
    return Buffer.from(data.content, data.encoding).toString('utf8');
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function prNumbersForEvent({ github, context, core, inputPr }) {
  const { owner, repo } = context.repo;
  const p = context.payload;

  if (p.pull_request) return [p.pull_request.number];
  if (inputPr) return [Number(inputPr)];

  if (p.workflow_run) {
    const fromPayload = (p.workflow_run.pull_requests || []).map((pr) => pr.number);
    if (fromPayload.length) return fromPayload;
    // Fork PRs are not listed in workflow_run.pull_requests; match on head SHA instead.
    const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
    const matches = open.filter((pr) => pr.head.sha === p.workflow_run.head_sha).map((pr) => pr.number);
    if (!matches.length) core.info(`No open PR has head ${p.workflow_run.head_sha}.`);
    return matches;
  }

  const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
  return open.map((pr) => pr.number);
}

async function resolveTeams({ github, core, teams, logins }) {
  const members = {};
  for (const team of teams) {
    const [org, slug] = team.slice(1).split('/');
    try {
      const list = [];
      for (const username of logins) {
        try {
          const { data } = await github.rest.teams.getMembershipForUserInOrg({ org, team_slug: slug, username });
          if (data.state === 'active') list.push(username.toLowerCase());
        } catch (e) {
          if (e.status !== 404) throw e;
        }
      }
      members[team.toLowerCase()] = list;
    } catch (e) {
      core.warning(`Cannot resolve team ${team} (${e.status || e.message}). Team owners need a GitHub App with Members: read.`);
    }
  }
  return members;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function summarize(core, prNumber, result, posted) {
  const rows = result.paths.map((r) => [
    `<code>${escapeHtml(r.path)}</code>`,
    r.owners.join(' ') || '—',
    r.copilotEligible ? 'yes' : 'no',
    r.coveredBy || `⏳ ${r.needs.join(' or ')}`,
  ]);
  core.summary
    .addHeading(`PR #${prNumber}: ${result.state === 'success' ? '✅' : '🟡'} ${result.description}`, 3)
    .addRaw(`Copilot approved head: ${result.copilotApproved ? 'yes' : 'no'} · Human approvers: ${result.approvers.map((a) => `@${a}`).join(', ') || 'none'}${posted ? '' : ' · _dry run, status not posted_'}\n\n`);
  if (rows.length) {
    core.summary.addTable([
      [{ data: 'Path', header: true }, { data: 'Code owners', header: true }, { data: 'Copilot may approve', header: true }, { data: 'Covered by', header: true }],
      ...rows,
    ]);
  }
  for (const n of result.notes) core.summary.addRaw(`> ${n}\n\n`);
}

function readWorkspaceFile(path) {
  const full = nodePath.join(process.env.GITHUB_WORKSPACE || process.cwd(), path);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

async function evaluatePr({ github, context, core, number, dryRun, statusContext, policySource }) {
  const { owner, repo } = context.repo;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  if (pr.state !== 'open') {
    core.info(`PR #${number} is ${pr.state}; skipping.`);
    return null;
  }

  // 'workspace' is only for dry runs (e.g. CI on a PR that adds or changes the policy).
  const read = policySource === 'workspace'
    ? async (path) => readWorkspaceFile(path)
    : (path) => readFile(github, { owner, repo, ref: pr.base.sha, path });

  const [reviews, files, configText, codeownersText] = await Promise.all([
    github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }),
    github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 }),
    // Policy and CODEOWNERS come from the base branch, so a PR cannot loosen the rules it is judged by.
    read(CONFIG_PATH),
    (async () => {
      for (const path of CODEOWNERS_PATHS) {
        const text = await read(path);
        if (text !== null) return text;
      }
      return '';
    })(),
  ]);

  if (configText === null) throw new Error(`${CONFIG_PATH} not found (${policySource === 'workspace' ? 'workspace' : `base ${pr.base.ref}`})`);
  const config = JSON.parse(configText);
  const codeowners = parseCodeowners(codeownersText);

  const teams = new Set();
  for (const f of files) {
    for (const path of [f.filename, f.previous_filename].filter(Boolean)) {
      for (const o of ownersFor(path, codeowners)) if (o.startsWith('@') && o.includes('/')) teams.add(o);
    }
  }
  const approverLogins = [...new Set(reviews.filter((r) => r.state === 'APPROVED' && r.user).map((r) => r.user.login))];
  const teamMembers = teams.size ? await resolveTeams({ github, core, teams, logins: approverLogins }) : {};

  const result = evaluate({ config, pr, files, reviews, codeowners, teamMembers });
  core.info(`PR #${number} @ ${pr.head.sha}: ${result.state} — ${result.description}`);

  if (!dryRun) {
    await github.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: pr.head.sha,
      state: result.state,
      context: statusContext,
      description: result.description,
      target_url: `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`,
    });
  }
  summarize(core, number, result, !dryRun);
  return result;
}

/**
 * Entry point for actions/github-script.
 * @param {object} args
 * @param {boolean} [args.dryRun] evaluate and write the job summary without posting a status
 * @param {string|number} [args.inputPr] PR number to evaluate (workflow_dispatch / CI dry run)
 * @param {'base'|'workspace'} [args.policySource] where to read the policy and CODEOWNERS; 'workspace' forces a dry run
 */
async function run({ github, context, core, dryRun = false, inputPr, statusContext = 'review-policy', policySource = 'base' }) {
  if (policySource === 'workspace') dryRun = true;
  const numbers = await prNumbersForEvent({ github, context, core, inputPr });
  const results = {};
  let failed = false;
  for (const number of numbers) {
    try {
      results[number] = await evaluatePr({ github, context, core, number, dryRun, statusContext, policySource });
    } catch (e) {
      failed = true;
      core.error(`PR #${number}: ${e.stack || e.message}`);
    }
  }
  await core.summary.write();
  if (failed) core.setFailed('Review policy evaluation failed for at least one PR.');
  return results;
}

module.exports = { run, evaluatePr, prNumbersForEvent };
