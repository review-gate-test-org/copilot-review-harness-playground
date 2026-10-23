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

// Paths no agent may ever approve, whatever AGENTOWNERS says.
const HARD_DENY = [/^\.github\//, /^(docs\/)?CODEOWNERS$/];

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
 * @returns { state: 'success' | 'pending', description }
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
  for (const [agent, login] of Object.entries(AGENTS)) {
    const review = latestBot.get(login);
    const approved = review?.state === 'APPROVED' && review.commit_id === sha;
    const blocked = files.filter((f) => !agentMayApprove(agentRules, f, agent));
    if (approved && !blocked.length) return { state: 'success', description: `Approved by ${agent} (all files agent-approvable)` };
    agentNotes.push(blocked.length ? `${agent} may not approve ${blocked.length} file(s)` : `${agent} has not approved`);
  }

  const need = missingOwners.size ? `code owner approval (${[...missingOwners].join(', ')})` : 'one approval';
  return { state: 'pending', description: `Needs ${need}; ${agentNotes.join('; ')}`.slice(0, 140) };
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

// Members of every @org/team named in CODEOWNERS. GITHUB_TOKEN can't read teams, so team owners
// need a token with org "Members: read" (e.g. a GitHub App); until then they give an evaluation error.
const loadTeams = async (github, codeowners) => {
  const teams = {};
  for (const name of new Set(parseOwners(codeowners).flatMap((r) => r.owners).filter((o) => o.includes('/')))) {
    const [org, team_slug] = name.slice(1).split('/');
    const members = await github.paginate(github.rest.teams.listMembersInOrg, { org, team_slug, per_page: 100 });
    teams[name.toLowerCase()] = new Set(members.map((m) => m.login.toLowerCase()));
  }
  return teams;
};

const evaluate = async (github, repo, pr) => {
  const ref = pr.base.ref;
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

// Entry point for actions/github-script.
const run = async ({ github, context, core }) => {
  const repo = context.repo;
  const { data: meta } = await github.rest.repos.get(repo);
  const open = await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base: meta.default_branch, per_page: 100 });

  const p = context.payload;
  const prs =
    p.pull_request ? open.filter((pr) => pr.number === p.pull_request.number)
      : p.workflow_run ? open.filter((pr) => pr.head.sha === p.workflow_run.head_sha)
        : open; // schedule / workflow_dispatch

  const target_url = `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  for (const pr of prs) {
    let result;
    try {
      result = await evaluate(github, repo, pr);
    } catch (e) {
      core.warning(`#${pr.number}: ${e.message}`);
      result = { state: 'pending', description: `Evaluation error: ${e.message}`.slice(0, 140) };
    }
    core.info(`#${pr.number} ${pr.head.sha.slice(0, 7)} -> ${result.state}: ${result.description}`);
    await github.rest.repos.createCommitStatus({ ...repo, sha: pr.head.sha, context: CONTEXT, target_url, ...result });
  }
};

module.exports = { run, decide, parseOwners, ownersOf, agentMayApprove, toRegex };
