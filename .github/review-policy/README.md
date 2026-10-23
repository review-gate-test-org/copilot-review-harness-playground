# Review policy

A required commit status, `review-policy`, that lets **Copilot code review's approval
count toward merging**, but only for paths you allow, while code owners remain the
gate for everything else.

GitHub can't express this natively: Copilot can't be listed in `CODEOWNERS`, and its
approval never counts as a code-owner approval. So this check takes over the
"Require review from Code Owners" job and adds the Copilot rule on top.

## Rule

Every changed path (for renames, both the old and the new path) must be covered by
**one** of the following:

| # | Covered by | Condition |
|---|------------|-----------|
| 1 | **Copilot** | Copilot's latest review on the head commit is `APPROVED` (🟢), **and** the path matches `copilotAllowlist` and does not match `copilotBlocklist`. 🔵 / 🟡 / 🔴 reviews are `COMMENTED` and never count. |
| 2 | **A code owner** | A code owner of the path (last matching `CODEOWNERS` rule) approved the head commit. The PR author doesn't count for their own PR. |
| 3 | **A maintainer** | The path has no code owner other than the author, and someone whose association is in `trustedAssociations` approved. |

- Only each reviewer's latest decisive review counts (`APPROVED`, `CHANGES_REQUESTED`, `DISMISSED`).
- Bots other than Copilot never count.
- With `requireApprovalOnHead: true`, approvals of older commits are ignored.

If every path is covered, the status is ✅ `success`. Otherwise it's 🟡 `pending` with
what's missing, e.g. *Needs @JacobiCamunda or Copilot (2 files)*. It never posts
`failure`: a missing review isn't a broken PR. The run's job summary has a
per-file table.

## Configuration: `.github/review-policy.json`

```jsonc
{
  "copilotAllowlist": ["/backend/src/", "/client/src/", "*.md"],   // empty = Copilot can't approve anything
  "copilotBlocklist": ["/.github/", "pom.xml", "package.json"],    // wins over the allowlist
  "requireApprovalOnHead": true,
  "trustedAssociations": ["OWNER", "MEMBER", "COLLABORATOR"],
  "copilotLogin": "copilot-pull-request-reviewer[bot]"
}
```

Patterns use `CODEOWNERS` syntax:

- A leading or middle `/` anchors the pattern to the root.
- A trailing `/` means the directory's contents.
- `*` and `?` match within one segment, and `**` matches across segments.
- A pattern without wildcards in its last segment also matches everything below it.

The policy and `CODEOWNERS` are read from the PR's **base commit**, so a PR can't
loosen its own rules. A change to them only takes effect once it's merged, and it's
reviewed under the old rules.

## How it runs

| Workflow | Event | Purpose |
|----------|-------|---------|
| `review-policy.yml` | `pull_request_target` (open, push, base change) | Evaluate the PR. |
| | `workflow_run` of *Review policy trigger* / *Copilot* | Re-evaluate after a review. |
| | `schedule` (every 15 min) | Sweep all open PRs, in case an event was missed. |
| | `workflow_dispatch` (`pr` input) | Manual run. |
| `review-policy-trigger.yml` | `pull_request_review` | Does nothing privileged. Its completion fires `workflow_run`. |
| `ci.yml` → `review-policy` | `pull_request` | Unit tests, plus a **dry run** using the PR's own policy (job summary only, no status). |

Every run recomputes from API state, so duplicate or out-of-order events are harmless.
The evaluator checks out only `.github/review-policy` from the default branch and
never runs PR code.

Why the indirection: a `pull_request_review` run uses the PR's workflow files and
gets a read-only token on fork PRs. Runs triggered by Copilot's review also end up
`action_required` (waiting for approval to run).

## Setup

1. **Merge this workflow first.** The PR that adds it can't get the status before
   then, so don't require the check yet.
2. **Create a GitHub App**, for example *review-policy*, with no webhook.
   - Repository permissions: *Commit statuses: write*, *Pull requests: read*, *Contents: read*.
   - Organization permissions: *Members: read*. This is only needed for team code owners.
   - Install it on the repo.
3. **Create the `review-policy` environment** with deployment branches limited to the
   default branch. Add:
   - variable `REVIEW_POLICY_APP_ID`
   - secret `REVIEW_POLICY_APP_PRIVATE_KEY`

   Without these, the workflow falls back to `GITHUB_TOKEN`; see the security notes below.
4. **Update the branch ruleset** on the default branch:
   - *Require a pull request*: keep 1 approval and dismissal of stale approvals, but
     **turn off "Require review from Code Owners"**. Keep `CODEOWNERS`, since it still
     auto-requests reviewers.
   - *Require status checks*: add `review-policy`, **pinned to the app**. Select it as
     the source, or use `integration_id` in the API.
   - Check that no org-level ruleset still requires code-owner review.

## Security notes

- **Fallback mode (no app) is spoofable.** The status is posted as *GitHub Actions*.
  Any workflow in a PR from this repo that requests `statuses: write` can post a fake
  `review-policy: success`. Use it only for trying things out.
- **App mode:**
  - The ruleset accepts the status only from the app.
  - The key lives in an environment limited to the default branch.
  - Remaining risk: whoever can push to the default branch, or edit the
    environment, controls the check, as with any CI.
- Protect `.github/` (blocklist it and give it a code owner) so changes to the
  policy itself need a human.
- `pull_request_target` runs with secrets; that's safe here only because no PR content
  is checked out or executed.

## Development

```bash
node --test .github/review-policy/policy.test.js
```

- `policy.js`: the pure decision logic.
- `run.js`: the GitHub API glue for `actions/github-script`.

## Known gaps

- It's unverified whether `workflow_run` fires for trigger runs held as
  `action_required`, and for the dynamic *Copilot* workflow. The schedule covers
  both, with up to ~15 min latency.
- Team code owners are only resolved with the app token (*Members: read*).
  Otherwise they show up as unresolved.
- PRs with more than 3000 files, which is the API limit, stay pending.
