'use strict';

// Patterns are anchored at the repo root. `**` matches across directories, `*` and `?` stay within one segment.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

/**
 * Pure decision function: should the harness approve on Copilot's behalf?
 * @returns {{approve: boolean, reason: string}}
 */
function evaluate({ config, pr, reviews, files }) {
  if (pr.state !== 'open') return { approve: false, reason: `PR is ${pr.state}` };
  if (pr.draft) return { approve: false, reason: 'PR is a draft' };

  const copilotReviews = reviews
    .filter((r) => r.user && r.user.login === config.copilotLogin)
    .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
  const latest = copilotReviews[copilotReviews.length - 1];
  if (!latest) return { approve: false, reason: 'No Copilot review found' };
  if (latest.commit_id !== pr.head.sha) {
    return { approve: false, reason: `Latest Copilot review is for ${latest.commit_id}, PR head is ${pr.head.sha}` };
  }
  const verdict = (latest.body || '').split('\n').find((l) => l.startsWith('### ')) || '(no verdict heading)';
  if (verdict.trim() !== config.approvedHeading) {
    return { approve: false, reason: `Copilot verdict is "${verdict.trim()}", not "${config.approvedHeading}"` };
  }

  const paths = files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
  const humanOnly = paths.filter((p) => matchesAny(p, config.humanOnlyPaths));
  if (humanOnly.length) return { approve: false, reason: `Human-only paths changed: ${humanOnly.join(', ')}` };
  const notApprovable = paths.filter((p) => !matchesAny(p, config.approvablePaths));
  if (notApprovable.length) return { approve: false, reason: `Paths outside the approvable list: ${notApprovable.join(', ')}` };

  return { approve: true, reason: `Copilot verdict ${config.approvedHeading} on ${pr.head.sha}; all ${paths.length} paths approvable`, copilotReview: latest };
}

async function run({ github, context, core, config, headSha, dryRun }) {
  const { owner, repo } = context.repo;
  const { data: prs } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: headSha });
  const candidates = prs.filter((p) => p.state === 'open' && p.head.sha === headSha);
  if (!candidates.length) {
    core.notice(`No open PR has head ${headSha}; nothing to do.`);
    return;
  }

  let botLogin = null;
  if (!dryRun) botLogin = (await github.rest.users.getAuthenticated()).data.login;

  for (const { number } of candidates) {
    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
    const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 });
    const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 });

    const decision = evaluate({ config, pr, reviews, files });
    core.info(`PR #${number}: approve=${decision.approve} — ${decision.reason}`);
    await core.summary.addRaw(`PR #${number}: **${decision.approve ? 'approve' : 'skip'}** — ${decision.reason}\n\n`).write();
    if (!decision.approve) continue;

    if (dryRun) {
      core.notice(`Dry run: would approve PR #${number}. Set the REVIEW_BOT_TOKEN secret to enable approvals.`);
      continue;
    }
    const alreadyApproved = reviews.some((r) => r.user.login === botLogin && r.state === 'APPROVED' && r.commit_id === pr.head.sha);
    if (alreadyApproved) {
      core.info(`PR #${number}: ${botLogin} already approved ${pr.head.sha}.`);
      continue;
    }
    await github.rest.pulls.createReview({
      owner,
      repo,
      pull_number: number,
      commit_id: pr.head.sha,
      event: 'APPROVE',
      body: `Approved on behalf of Copilot code review ([review](${decision.copilotReview.html_url})).\n\n${decision.reason}.`,
    });
    core.notice(`PR #${number}: approved as ${botLogin}.`);
  }
}

module.exports = { globToRegExp, matchesAny, evaluate, run };
