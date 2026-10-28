// Review gate: posts the `review-gate` commit status on open PRs to the default branch.
//
//   success  <=  code owners approved
//                OR (a review agent approved AND every changed file is agent-approvable)
//   pending  otherwise (never `failure`)
//
// CODEOWNERS and .github/AGENTOWNERS are read from the base branch, so a PR cannot loosen its own rules.

const CONTEXT = 'review-gate';

// Agent ID (as used in AGENTOWNERS) -> GitHub login of the agent's reviews.
const AGENTS = { copilot: 'copilot-pull-request-reviewer[bot]' };

// Paths no agent may ever approve, whatever AGENTOWNERS says. Copilot code review reads instructions
// and skills from the PR head, so a PR could otherwise use them to steer its own review. Only root
// locations are listed: in tests, Copilot ignored nested copies (see #97).
const HARD_DENY = [
  /^\.github\//,
  /^(docs\/)?CODEOWNERS$/,
  /^(AGENTS|CLAUDE|GEMINI|REVIEW)\.md$/i,
  /^\.(claude|agents)\/skills\//i,
];

// CODEOWNERS glob -> RegExp. Supports *, **, ?, leading / (anchor) and trailing / (directory).
const toRegex = (pattern) => {
  const anchored = pattern.replace(/\/$/, '').includes('/');
  let p = pattern.replace(/^\//, '');
  if (!anchored) p = '**/' + p;
  if (p.endsWith('/')) p += '**';
  const re = p
    .split(/(\*\*\/|\/\*\*|\*|\?)/)
    .map((t) =>
      t === '**/' ? '(?:.*/)?'
        : t === '/**' ? '/.*'
          : t === '*' ? '[^/]*'
            : t === '?' ? '[^/]'
              : t.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${re}(?:/.*)?$`);
};

// Parses CODEOWNERS-syntax text into [{ re, owners }].
const parseOwners = (text = '') =>
  text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [pattern, ...owners] = l.split(/\s+/);
      return { re: toRegex(pattern), owners };
    });

// Owners of the last matching line, or [] if no line matches. Last match wins.
const ownersOf = (rules, file) => {
  let hit;
  for (const r of rules) if (r.re.test(file)) hit = r;
  return hit ? hit.owners : [];
};

const agentMayApprove = (agentRules, file, agent) =>
  !HARD_DENY.some((r) => r.test(file)) && ownersOf(agentRules, file).includes(agent);

// Latest review per login. For humans, COMMENTED reviews don't change the decision (same as GitHub).
const latestByLogin = (reviews, { skipComments }) => {
  const latest = new Map();
  for (const r of reviews) {
    if (skipComments && r.state === 'COMMENTED') continue;
    latest.set(r.user.login, r);
  }
  return latest;
};

/**
 * Pure decision.
 * @param pr          { draft, head: { sha }, user: { login } }
 * @param files       changed paths, including old paths of renames
 * @param reviews     REST review objects, oldest first
 * @param codeowners  CODEOWNERS text at base
 * @param agentowners AGENTOWNERS text at base
 * @param teams       { '@org/team': Set(logins) } for teams named in CODEOWNERS
 * @returns { state: 'success' | 'pending', description, awaiting? }
 *          awaiting: agents whose review of the head commit is missing and could still make it `success`
 */
const decide = ({ pr, files, reviews, codeowners, agentowners, teams = {} }) => {
  if (pr.draft) return { state: 'pending', description: 'Draft PR' };

  const sha = pr.head.sha;
  const human = reviews.filter((r) => r.user.type !== 'Bot' && r.user.login !== pr.user.login);
  const latestHuman = [...latestByLogin(human, { skipComments: true }).values()];

  const blockers = latestHuman.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => '@' + r.user.login);
  if (blockers.length) return { state: 'pending', description: `Changes requested by ${blockers.join(', ')}` };

  const approvers = latestHuman.filter((r) => r.state === 'APPROVED' && r.commit_id === sha).map((r) => r.user.login);
  const isOwner = (owner, login) =>
    owner.toLowerCase() === '@' + login.toLowerCase() || !!teams[owner.toLowerCase()]?.has(login.toLowerCase());

  // Branch 1: code owners. Every owned file needs one of its owners; any file needs at least one human approval.
  const ownerRules = parseOwners(codeowners);
  const missingOwners = new Set();
  for (const f of files) {
    const owners = ownersOf(ownerRules, f);
    if (owners.length && !approvers.some((a) => owners.some((o) => isOwner(o, a)))) owners.forEach((o) => missingOwners.add(o));
  }
  if (approvers.length && !missingOwners.size) return { state: 'success', description: 'Approved by code owners' };

  // Branch 2: an agent approved the head commit and AGENTOWNERS allows it for every file.
  const agentRules = parseOwners(agentowners);
  const latestBot = latestByLogin(reviews.filter((r) => r.user.type === 'Bot'), { skipComments: false });
  const agentNotes = [];
  const awaiting = [];
  for (const [agent, login] of Object.entries(AGENTS)) {
    const review = latestBot.get(login);
    const approved = review?.state === 'APPROVED' && review.commit_id === sha;
    const blocked = files.filter((f) => !agentMayApprove(agentRules, f, agent));
    if (approved && !blocked.length) return { state: 'success', description: `Approved by ${agent} (all files agent-approvable)` };
    // The agent's verdict on this commit could still turn the gate green.
    if (!blocked.length && !reviews.some((r) => r.user.login === login && r.commit_id === sha)) awaiting.push(agent);
    agentNotes.push(blocked.length ? `${agent} may not approve ${blocked.length} file(s)` : `${agent} has not approved`);
  }

  const need = missingOwners.size ? `code owner approval (${[...missingOwners].join(', ')})` : 'one approval';
  return { state: 'pending', description: `Needs ${need}; ${agentNotes.join('; ')}`.slice(0, 140), awaiting };
};

// Reads a file at a ref; returns '' if it doesn't exist.
const readFile = async (github, repo, path, ref) => {
  try {
    const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (e) {
    if (e.status === 404) return '';
    throw e;
  }
};

const readCodeowners = async (github, repo, ref) => {
  for (const path of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    const text = await readFile(github, repo, path, ref);
    if (text) return text;
  }
  return '';
};

// Members of every @org/team named in CODEOWNERS (needs the app's org "Members: read" permission).
const loadTeams = async (github, codeowners) => {
  const teams = {};
  for (const name of new Set(parseOwners(codeowners).flatMap((r) => r.owners).filter((o) => o.includes('/')))) {
    const [org, team_slug] = name.slice(1).toLowerCase().split('/');
    const members = await github.paginate(github.rest.teams.listMembersInOrg, { org, team_slug, per_page: 100 });
    teams[name.toLowerCase()] = new Set(members.map((m) => m.login.toLowerCase()));
  }
  return teams;
};

// Rules are always read from the default branch: only PRs targeting it are gated.
const evaluate = async (github, repo, pr, ref) => {
  const [changed, reviews, codeowners, agentowners] = await Promise.all([
    github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: pr.number, per_page: 100 }),
    github.paginate(github.rest.pulls.listReviews, { ...repo, pull_number: pr.number, per_page: 100 }),
    readCodeowners(github, repo, ref),
    readFile(github, repo, '.github/AGENTOWNERS', ref),
  ]);
  const files = [...new Set(changed.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))];
  const teams = await loadTeams(github, codeowners);
  return decide({ pr, files, reviews, codeowners, agentowners, teams });
};

// How long a single-PR run waits for an agent review that could still turn the gate green.
// Workflows triggered by an agent's review are held for approval, so the run started by the
// human's push waits for the agent instead of relying on the review event.
const WAIT_MS = 15 * 60_000;
const POLL_MS = 30_000;

// Entry point for actions/github-script.
const run = async ({ github, context, core }, { waitMs = WAIT_MS, pollMs = POLL_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) => {
  const repo = context.repo;
  const { data: meta } = await github.rest.repos.get(repo);
  const open = await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base: meta.default_branch, per_page: 100 });

  const p = context.payload;
  const singlePr = !!(p.pull_request || p.workflow_run);
  // A relay for an older commit must still re-evaluate the PR's current head (it may have cancelled its waiter).
  const number = p.pull_request?.number ?? p.workflow_run?.pull_requests?.[0]?.number;
  const prs =
    number ? open.filter((pr) => pr.number === number)
      : p.workflow_run ? open.filter((pr) => pr.head.sha === p.workflow_run.head_sha) // fork PRs: pull_requests is empty
        : open; // schedule / workflow_dispatch: never waits

  const target_url = `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  const post = (sha, { state, description }) =>
    github.rest.repos.createCommitStatus({ ...repo, sha, context: CONTEXT, target_url, state, description });
  const safeEvaluate = async (pr) => {
    try {
      return await evaluate(github, repo, pr, meta.default_branch);
    } catch (e) {
      core.warning(`#${pr.number}: ${e.message}`);
      return { state: 'pending', description: `Evaluation error: ${e.message}`.slice(0, 140) };
    }
  };

  for (let pr of prs) {
    const sha = pr.head.sha;
    let result = await safeEvaluate(pr);
    if (singlePr && result.awaiting?.length) {
      await post(sha, { state: 'pending', description: `Waiting for ${result.awaiting.join(', ')} to review ${sha.slice(0, 7)}` });
      const deadline = Date.now() + waitMs;
      while (result?.awaiting?.length && Date.now() < deadline) {
        await sleep(pollMs);
        const { data: fresh } = await github.rest.pulls.get({ ...repo, pull_number: pr.number });
        if (fresh.state !== 'open' || fresh.head.sha !== sha || fresh.base.ref !== meta.default_branch) {
          core.info(`#${pr.number}: head moved, base changed or PR closed; stop waiting`);
          result = undefined;
          break;
        }
        pr = fresh;
        result = await safeEvaluate(pr);
      }
    }
    if (!result) continue;
    core.info(`#${pr.number} ${sha.slice(0, 7)} -> ${result.state}: ${result.description}`);
    await post(sha, result);
  }
};

module.exports = { run, decide, parseOwners, ownersOf, agentMayApprove, toRegex };
