# Review gate: design, current state, learnings, limitations

Status: **proof of concept, not yet enforced.** Last updated 2026-10-23.

This document records what we built, what we found out, and what is still open, so that anyone can continue.

## 1. Goal

Today a PR to `main` needs an approval from its code owners. We want a second way to merge: an AI review agent
approves, and deterministic rules say that the agent may approve those files.

| | Before | Target |
|---|---|---|
| CODEOWNERS | `backend/` → backend team, `client/` → frontend team | unchanged |
| Ruleset | requires code owner approval | requires the `review-gate` status, **no** code owner approval |
| Review | code owners are requested automatically | unchanged; only the gate blocks the merge |
| Gate | – | green if `code owners approved` **OR** (`agent approved` **AND** `rules pass`), yellow otherwise |

The review agent is GitHub Copilot code review for now. Later it can also be our own review bot.

## 2. How it works

| File | Purpose |
|---|---|
| [`gate.js`](gate.js) | Decision logic (`decide`, pure function) and API glue (`run`) for `actions/github-script`. No npm dependencies. |
| [`gate.test.js`](gate.test.js) | Unit tests: `node --test .github/review-gate/gate.test.js`. CI runs them as the `review-gate-tests` job. |
| [`../AGENTOWNERS`](../AGENTOWNERS) | The deterministic rules: which paths an agent may approve. |
| [`../workflows/review-gate.yml`](../workflows/review-gate.yml) | Evaluates open PRs and posts the `review-gate` commit status as the GitHub App. |
| [`../workflows/review-gate-trigger.yml`](../workflows/review-gate-trigger.yml) | Relay for review events (see 4.2). No permissions, no secrets. |

### Decision rule (whole PR, not per file)

- **Draft PR** → pending.
- **Changes requested** by a human (latest non-comment review) → pending.
- **Code owners approved** → success. Every changed file that has an owner in CODEOWNERS has an approval on the
  head commit from one of its owners: a user, or a member of the owning `@org/team`. At least one human approval
  is necessary in total, so files without an owner behave as before (one approval).
- **Agent approved** → success when the agent's latest review is `APPROVED` on the head commit **and** AGENTOWNERS allows
  that agent for every changed file, including the old path of a renamed file.
- Otherwise → pending. The status description says what is missing (max. 140 characters).
- The gate never posts `failure` or `error`. An exception gives `pending` with "Evaluation error: …".

The PR is evaluated as a whole. Example: a PR changes `backend/` and `client/`, and only the backend team approves.
The gate stays yellow, also when Copilot approved, unless AGENTOWNERS allows Copilot for every file.

### AGENTOWNERS format

Same syntax as CODEOWNERS, with agent IDs instead of users:

```
/backend/   copilot
/client/    copilot
/client/package-lock.json        # no agent: no agent may approve this path
```

- The last matching line wins. A line without an agent removes approval rights.
- A path that no line matches is **not** agent-approvable.
- `.github/**` and `CODEOWNERS` are never agent-approvable. This is hard-coded in `gate.js`.
- Supported globs: `*`, `**`, `?`, leading `/` (anchor at root), trailing `/` (directory). No `[]` classes.
- Agent IDs map to GitHub logins in `AGENTS` in `gate.js` (`copilot` → `copilot-pull-request-reviewer[bot]`).

Why this format: it is "similar to CODEOWNERS", as agreed in the design meeting. We rejected two alternatives.
Annotations inside CODEOWNERS do not work, because GitHub marks unknown owners as errors. A JSON allow/deny list
adds new precedence rules that people must learn. Palantir policy-bot is the reference if the logic grows beyond
one OR.

### Security model

- All triggers of `review-gate.yml` (`pull_request_target`, `workflow_run`, `schedule`, `workflow_dispatch`) run the
  workflow file and `gate.js` from `main`. The job checks out only `main`, never PR code.
- CODEOWNERS and AGENTOWNERS are read from the base branch, so a PR cannot loosen its own rules.
- The app private key is in the `review-gate` **environment**. Only the `main` branch can use that environment, so a
  workflow on a PR branch cannot read the key. `deployment: false` keeps this branch policy and does not create
  deployment entries on the PR.
- When the ruleset pins `review-gate` to the app ID, no other workflow can post a status that counts.

## 3. Current setup

Repository: `review-gate-test-org/copilot-review-harness-playground`. It was transferred from
`venetrius/copilot-review-harness-playground`, and the old URL redirects.

| Item | Value |
|---|---|
| Teams | `backend`: @JacobiCamunda. `frontend`: @venetrius. Both have write access. |
| CODEOWNERS | `/backend/ @review-gate-test-org/backend`, `/client/ @review-gate-test-org/frontend` |
| GitHub App | `review-gate-test-org-gate`, App ID **5441748**, owned by the org, installed on all org repos, no webhook |
| App permissions | Commit statuses: write. Contents, Pull requests, Metadata, org Members: read. |
| Environment | `review-gate`, deployment branch `main` only. Variable `REVIEW_GATE_CLIENT_ID`, secret `REVIEW_GATE_PRIVATE_KEY`. |
| Copilot | Auto-review on push (ruleset). "Allow Copilot to approve pull requests" is on. "Count toward merge requirements" is off. |
| Ruleset `main: reviewed merges` (25708463) | **Unchanged**: code owner review required, 1 approval, checks `backend` and `client`. `review-gate` is **not** required yet. No bypass actors. |
| Test PRs | #9 client only, #10 README only, #11 client + README. Keep them open for the next tests. |

## 4. Learnings

### 4.1 Copilot code review

- Each Copilot review starts with a verdict heading, for example `### 🟢 Approved`, `### 🟢 Approval recommended`,
  `### 🟡 Changes recommended`, `### 🔵 Needs a closer look`.
- Copilot submits a real `APPROVED` review **only** when the opt-in setting "Allow Copilot to approve pull requests" is on
  (Repo → Settings → Copilot → Code review → Auto-approval; the org policy must allow it). Without it, Copilot writes
  "🟢 Approval recommended" and submits `COMMENTED`. The gate reads only the review state, not the text.
- Since 2026-09, GitHub has native Copilot approvals
  ([changelog](https://github.blog/changelog/2026-09-01-copilot-code-review-can-now-approve-pull-requests/),
  [docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review)):
  - "Count toward merge requirements" lets a Copilot approval satisfy the required approval count.
  - "File paths" (max. 15 globs) counts the approval only if **every** changed file matches. This is nearly the same as AGENTOWNERS.
  - GitHub has **no** "code owners OR Copilot" rule. That OR is the reason why the gate is still necessary.
  - Copilot approvals are in public preview.

### 4.2 Workflows started by Copilot need manual approval (open blocker)

- A Copilot review raises `pull_request_review` with the actor `Copilot`. GitHub does **not** run workflows that
  Copilot started automatically. A maintainer must click "Approve and run". If nobody does, the run expires and ends
  as `failure` ("This workflow run required approval but was not approved before it expired").
- This applies to `Review gate trigger`, and also to the `workflow_run` runs of `Review gate` that follow it.
  Those runs keep the actor `Copilot` and wait as `action_required`.
- Reviews by people do not have this problem.
- Effect: after a Copilot review, only the `schedule` fallback updates the status. It runs every 15 minutes, and
  GitHub often starts scheduled runs later than planned.
- We need the relay because `pull_request_review` has no `_target` version. A workflow started by a review runs the
  workflow file from the PR branch, so it must never have access to the app key.
- A setting "skip approval" exists for the Copilot **coding agent**
  ([changelog](https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/)).
  We did not test if it also covers code review.

### 4.3 Tokens, teams and statuses

- **GitHub Actions jobs cannot be yellow.** A job is green or red, and yellow only while it runs. So the gate posts its
  own commit status: `pending` = yellow, `success` = green.
- **Commit status, not check run.** For required checks, `neutral` and `skipped` check runs count as passed, so a bug
  could let a PR through. A check run that is `in_progress` becomes stale after 14 days.
- **`GITHUB_TOKEN` cannot read team members.** There is no "Members" permission for it. With `GITHUB_TOKEN`, a
  single `@org/team` in CODEOWNERS makes **every** PR show "Evaluation error". This applies to all PRs, because
  `loadTeams` reads all teams in CODEOWNERS. The app with org "Members: read" fixes this. We tested it on #9 and #11.
- **Statuses posted with `GITHUB_TOKEN` can be faked.** Any workflow with `statuses: write`, also one added in a PR
  branch, can post `review-gate: success`. Pinning the ruleset to the app ID prevents this.
- **No GitHub signal replaces the team check:**
  - GraphQL `reviewDecision` covers code owners only while the ruleset requires code owner review. We remove
    that requirement.
  - `PullRequestReview.onBehalfOf` ("approved on behalf of @team") is set only when the review fulfils an open team
    review request. In the last 15 merged PRs of `camunda/web-modeler`, only 2 of the approvals had it.
- **Teams need repo access.** A team without access to the repo is not listed as a reviewer, and its CODEOWNERS entry
  is not valid.

### 4.4 Tooling

- Node `path.matchesGlob` is not usable for CODEOWNERS patterns. `*` and `**` skip dotfiles, so `backend/**` does
  not match `backend/.env`. Its anchoring is not the same as gitignore. `gate.js` has its own small glob-to-regex function.
- actionlint 1.7.8 reports `environment.deployment` as an unknown key. That is wrong, because GitHub supports the key.
- `actions/github-script@v9`: `require('@actions/github')` no longer works in scripts. `gate.js` does not use it.
- `actions/create-github-app-token@v3`: use `client-id`. `app-id` is deprecated.
- A GitHub organization can only be created in the web UI. `gh` needs `gh auth refresh -s admin:org` to manage teams.
  The user who creates a team through the API becomes a maintainer of that team automatically.
- An org owner is not a ruleset bypass actor automatically. For PR #8 we added `OrganizationAdmin` temporarily and
  removed it again.

## 5. Limitations

1. **Copilot reviews update the status only with a delay** (4.2). Until this is fixed, the Copilot path takes up to
   15 minutes or more.
2. **Whole-PR evaluation.** You cannot combine a backend team approval with a Copilot approval for the client files.
3. **Concurrent runs.** Two runs for the same commit (for example a push and a review) can post out of order. The
   schedule corrects a stale status.
4. **Many statuses.** The gate posts a status on every run, also when nothing changed. GitHub allows 1000 statuses per
   commit and context.
5. **Several PRs with the same head commit** share one commit status. The last evaluated PR wins.
6. **Prompt injection.** A PR author can try to make Copilot approve. AGENTOWNERS limits the paths where this matters.
7. **One agent only.** `AGENTS` in `gate.js` only knows Copilot. Our own review bot needs an entry, and the gate must
   be able to read its review state.
8. **Team lookups** use one API call per team named in CODEOWNERS, on every evaluation. That is fine for a few teams.
9. **Ruleset not switched.** Until step 6.4 is done, the gate has no effect on merging.

## 6. Next steps

1. **Re-request Copilot's review on #9.** Expected: an `APPROVED` review, and `review-gate` = success after the next
   gate run.
2. **Try the "skip approval" setting** (Repo → Settings → Copilot → Cloud agent). Then re-request a Copilot review and
   check if `Review gate trigger` runs without approval. Note: Copilot coding agent PRs then also run workflows
   without approval. The app key stays safe because of the environment branch policy.
3. If step 2 does not work: shorten the schedule to `*/5`. For Camunda: give the app a real webhook (a small service
   that receives `pull_request_review`), because no Actions run means no approval.
4. **Switch the ruleset:** code owner review off, **0** required approvals (otherwise the Copilot path can never merge),
   and `review-gate` required and pinned to the app:
   ```bash
   R=review-gate-test-org/copilot-review-harness-playground
   gh api repos/$R/rulesets/25708463 | jq '{name, target, enforcement, conditions,
     bypass_actors: (.bypass_actors // []),
     rules: (.rules | map(
       if .type == "pull_request" then
         .parameters.require_code_owner_review = false | .parameters.required_approving_review_count = 0
       elif .type == "required_status_checks" then
         .parameters.required_status_checks += [{"context": "review-gate", "integration_id": 5441748}]
       else . end))}' > ruleset.json
   gh api -X PUT repos/$R/rulesets/25708463 --input ruleset.json
   ```
5. **Run the scenarios:**

   | PR | Action | Expected |
   |---|---|---|
   | #9 client only | Copilot approves | green, mergeable |
   | #10 README only | Copilot cannot approve | yellow, then @venetrius approves → green |
   | #11 client + README | Copilot approves | yellow (README), then @venetrius (frontend) approves → green |
   | new: backend + client | the backend team approves | yellow until the frontend team approves too |

6. **Decisions for a Camunda rollout:**
   - Webhook service or Actions with schedule?
   - Whole PR or per file?
   - Use GitHub's native "File paths" or keep AGENTOWNERS?
   - Support for our own review bot.
