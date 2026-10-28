# Letting an AI review approve pull requests: options

**Goal:** a PR can merge when the owning team approves it, **or** when an AI reviewer (Copilot for now)
approves it and fixed rules allow AI approval for every changed file.

**Constraint behind every option:** GitHub accepts only users and teams in `CODEOWNERS`. Copilot or a
GitHub App can't be a code owner directly, so each option below works around that.

Downsides are grouped by who has to deal with them:

- **Leadership:** cost or policy sign-off
- **InfoSec / IT:** credentials, accounts, access
- **Engineering:** code and configuration to build and maintain
- **Developers:** day-to-day experience on a PR

## 1. GitHub's built-in Copilot approval (preview)

**How:** turn on "Copilot may approve" and "Copilot approvals count", optionally limited to up to 15 file patterns.

**Solves:** AI approval with no code, no app and no delay.

**Downsides**

- **Engineering:** it counts as a generic approval, not a code-owner approval. Copilot can't approve on
  behalf of a team, so this doesn't fit repos that require code-owner review.
- **Engineering:** scoping is coarse. You can allow `api/**` or `api/swagger/**`, but "everything in `api/`
  except DB migrations and auth routes" is hard to express.
- **Engineering:** Copilot only.

**Viable when:** any single approval is enough and coarse path scoping is acceptable.

## 2. Machine user as code owner

**How:** a script-driven account is listed in `CODEOWNERS` and approves when the AI approves and the
rules allow it.

**Solves:** the AI approval flows through GitHub's own code-owner logic, exactly like a human's. Merge
rules and the human path stay unchanged.

**Downsides**

- **Leadership:** needs a paid seat, and a policy for a non-human account.
- **InfoSec / IT:** a stored token can approve everything the account owns; the account needs a
  rotation and offboarding process.
- **Engineering:** an approval script to maintain. It also hits the held-workflow problem (below),
  solvable the same way as option 3.

**Viable when:** machine accounts are acceptable to leadership and InfoSec / IT.

## 3. Custom required check ("review gate") ✅ working in the test repo

**How:** a GitHub App posts a `review-gate` commit status. It is green when code owners approved,
**or** Copilot approved the head commit **and** every changed file is allowed in `.github/AGENTOWNERS`.
The ruleset requires that status, pinned to the app, and no longer enforces code-owner review itself.
Code owners are still requested as reviewers automatically.

**Solves**

- Exactly the either/or we want.
- Fine-grained scope: `AGENTOWNERS` uses `CODEOWNERS` syntax with last-match-wins, so "all of `api/`
  except migrations and auth" is a few lines. `.github/` and `CODEOWNERS` always need a human.
- Rules are read from the default branch, so a PR can't loosen its own rules.
- Deterministic: the gate makes no LLM calls; Copilot is the only AI in the loop.
- No seat. Other AI reviewers can be added later.

**Downsides**

- **InfoSec / IT:** the app's private key must be protected (it lives in an environment only the
  default branch can use). An org owner has to create the app.
- **Engineering:** custom code to maintain; a bug also affects the human path.
- **Engineering:** `review-gate` must be a required check pinned to the app. Otherwise Copilot's approval
  alone satisfies GitHub's "1 approval" rule — we merged a PR that way by accident.
- **Developers:** each push to a PR Copilot may approve waits for Copilot's review (about 1.5–2 min
  measured, at most 15 min). If Copilot is slower, the gate stays pending until the next push or review.
- **Developers:** Copilot's review still starts the review relay, which GitHub holds for approval. The PR shows
  an "Approve workflows to run" prompt and the "unstable" state. Nobody needs to click it, but it can't be hidden:
  the same relay re-runs the gate after human reviews, and GitHub holds the run before any condition is checked.
- **Developers:** GitHub's UI no longer says "code owner review required"; the status description says
  what is missing instead.

**Viable when:** now, at repo or team level. For production, run it as a GitHub App webhook (no waiting,
no held runs) and roll it out with org rulesets.

**Demo:** [#14](https://github.com/review-gate-test-org/copilot-review-harness-playground/pull/14) is green
and mergeable; [#15](https://github.com/review-gate-test-org/copilot-review-harness-playground/pull/15) is
yellow and blocked.

## 4. Merge bot with rule bypass

**How:** keep the team rule. An app that may bypass the rules merges when the AI and the file rules agree.

**Solves:** the human path stays untouched.

**Downsides**

- **InfoSec / IT:** the app can merge anything — high risk.
- **Engineering:** weaker audit trail; it's a merge, not a real approval.

**Viable when:** PRs are merged through a command or workflow anyway.

## Open problem: held workflows

GitHub holds workflow runs started by Copilot until a person approves them, so automation can't react
to Copilot's review directly.

- **Merge blocking — solved for option 3:** the run started by the author's push isn't held, and it waits
  for Copilot's review of that commit. Measured: the gate turned green 6 seconds after Copilot approved.
  Options 2 and 4 can use the same approach.
- **Held-run prompt — not solved:** Copilot's review still triggers the review relay, which is held. It needs
  no click, but it shows on every PR Copilot reviews. Removing it while keeping immediate updates after human
  reviews likely means handling review events outside Actions, for example with GitHub App webhooks.
