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

const truncate = (text, max = 140) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** Evaluate one PR (object from pulls.get / pulls.list). Never posts anything. */
async function evaluatePr({ github, context, core, pr, policySource }) {
  const { owner, repo } = context.repo;
  const number = pr.number;

  // 'workspace' is only for dry runs (e.g. CI on a PR that adds or changes the policy).
  const read = policySource === 'workspace'
    ? async (path) => readWorkspaceFile(path)
    : (path) => readFile(github, { owner, repo, ref: pr.base.sha, path });

  const [reviews, files, configText, codeownersText] = await Promise.all([
    github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }),
    github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 }),
    // Policy and CODEOWNERS come from the base commit, so a PR cannot loosen the rules it is judged by.
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

  // pulls.list omits changed_files; evaluate() uses it to detect truncated file lists.
  const full = pr.changed_files === undefined
    ? (await github.rest.pulls.get({ owner, repo, pull_number: number })).data
    : pr;
  const result = evaluate({ config, pr: full, files, reviews, codeowners, teamMembers });
  core.info(`PR #${number} @ ${pr.head.sha}: ${result.state} — ${result.description}`);
  return result;
}

/** Latest status for `statusContext` on `sha` created by `creator` (newest first in the API). */
async function latestOwnStatus({ github, owner, repo, sha, statusContext, creator }) {
  for await (const { data } of github.paginate.iterator(github.rest.repos.listCommitStatusesForRef, { owner, repo, ref: sha, per_page: 100 })) {
    const hit = data.find((st) => st.context === statusContext && (!creator || (st.creator && st.creator.login === creator)));
    if (hit) return hit;
  }
  return null;
}

/**
 * Combine the decisions of every open PR that shares a head SHA: a commit status is per
 * SHA, so it may only be `success` when all of them pass.
 */
function combine(entries) {
  const pending = entries.filter((e) => !e.result || e.result.state !== 'success');
  if (!pending.length) {
    const description = entries.length === 1 ? entries[0].result.description : `Approved (${entries.length} PRs share this commit)`;
    return { state: 'success', description: truncate(description) };
  }
  const describe = (e) => (e.result ? e.result.description : 'Evaluation error; see the workflow run');
  const description = entries.length === 1 ? describe(pending[0]) : pending.map((e) => `#${e.pr.number}: ${describe(e)}`).join('; ');
  return { state: 'pending', description: truncate(description) };
}

/**
 * Entry point for actions/github-script.
 *
 * Posting mode (default): re-evaluates every open PR that targets the default branch and
 * publishes one combined status per head SHA, skipping unchanged ones. Run it serialized
 * (one global concurrency group) so a slow run cannot overwrite a newer decision.
 *
 * Dry-run mode (`policySource: 'workspace'` or `dryRun`): evaluates `inputPr` only and writes
 * the job summary.
 *
 * @param {object} args
 * @param {boolean} [args.dryRun]
 * @param {string|number} [args.inputPr] PR to evaluate in dry-run mode
 * @param {'base'|'workspace'} [args.policySource] where to read policy + CODEOWNERS; 'workspace' forces a dry run
 * @param {string} [args.statusCreator] login that posts the status (e.g. 'my-app[bot]'); only its statuses are compared for dedup
 */
async function run({ github, context, core, dryRun = false, inputPr, statusContext = 'review-policy', policySource = 'base', statusCreator }) {
  const { owner, repo } = context.repo;
  if (policySource === 'workspace') dryRun = true;

  if (dryRun) {
    if (!inputPr) throw new Error('Dry run needs inputPr');
    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: Number(inputPr) });
    const result = await evaluatePr({ github, context, core, pr, policySource });
    summarize(core, pr.number, result, false);
    await core.summary.write();
    return { [pr.number]: result };
  }

  const defaultBranch = context.payload.repository.default_branch;
  const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', base: defaultBranch, per_page: 100 });
  const bySha = new Map();
  for (const pr of open) {
    if (!bySha.has(pr.head.sha)) bySha.set(pr.head.sha, []);
    bySha.get(pr.head.sha).push({ pr });
  }

  const results = {};
  let failed = false;
  for (const [sha, entries] of bySha) {
    for (const e of entries) {
      try {
        e.result = await evaluatePr({ github, context, core, pr: e.pr, policySource });
        results[e.pr.number] = e.result;
        summarize(core, e.pr.number, e.result, true);
      } catch (err) {
        failed = true;
        core.error(`PR #${e.pr.number}: ${err.stack || err.message}`);
      }
    }

    // An error still publishes `pending`, so a stale `success` can never outlive a failed evaluation.
    const { state, description } = combine(entries);
    try {
      const previous = await latestOwnStatus({ github, owner, repo, sha, statusContext, creator: statusCreator });
      if (previous && previous.state === state && previous.description === description) {
        core.info(`${sha.slice(0, 7)}: unchanged (${state}), not re-posting.`);
        continue;
      }
      await github.rest.repos.createCommitStatus({
        owner,
        repo,
        sha,
        state,
        context: statusContext,
        description,
        target_url: `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`,
      });
      core.info(`${sha.slice(0, 7)}: posted ${state} — ${description}`);
    } catch (err) {
      failed = true;
      core.error(`Posting status for ${sha}: ${err.stack || err.message}`);
    }
  }

  if (!bySha.size) core.summary.addRaw(`No open PRs target ${defaultBranch}.\n`);
  await core.summary.write();
  if (failed) core.setFailed('Review policy failed for at least one PR; see the errors above.');
  return results;
}

module.exports = { run, evaluatePr, combine };
