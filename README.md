# copilot-review-harness-playground

Sandbox for testing whether GitHub Copilot code review can approve pull requests
and enable merging, while still requiring a human code owner review where needed.

| Path | Stack | Code owner |
|------|-------|------------|
| `backend/` | Java 21, Maven | @review-gate-test-org/backend |
| `client/` | TypeScript, React (Vite) | @review-gate-test-org/frontend |

## Build

```bash
cd backend && mvn verify
cd client && npm ci && npm run lint && npm run build
```

## Review gate

Merging to `main` requires the `review-gate` commit status, posted by a GitHub App from
[`.github/workflows/review-gate.yml`](.github/workflows/review-gate.yml). It is green when:

- **code owners approved** (every file owned in `CODEOWNERS` has an approval from one of its owners or a member of its owning team), or
- **Copilot approved** the head commit **and** every changed file is agent-approvable in
  [`.github/AGENTOWNERS`](.github/AGENTOWNERS) (CODEOWNERS syntax, agent IDs instead of users).

Otherwise it stays yellow (`pending`) and says what is missing. These root paths always need a human,
whatever `AGENTOWNERS` says. Copilot code review reads instructions and skills from the PR's head
branch, so a PR could otherwise use them to steer its own review:

- `.github/` (includes `copilot-instructions.md`, `instructions/`, `skills/` and workflows)
- `CODEOWNERS` and `docs/CODEOWNERS`
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `REVIEW.md`
- `.claude/skills/` and `.agents/skills/`

Copies in subdirectories (for example `backend/AGENTS.md`) stay agent-approvable: in testing, Copilot
did not read them ([#97](https://github.com/review-gate-test-org/copilot-review-harness-playground/issues/97)).

GitHub holds workflow runs triggered by Copilot (its review events, and `workflow_run` chains from them)
for manual approval, so the gate can't react to Copilot's review directly. Instead, the run started by
the author's push waits up to 15 minutes for Copilot to review that commit. It waits only when Copilot's
verdict could still turn the gate green: the PR isn't a draft, no human requested changes, and every file is
agent-approvable. A newer push or review cancels a waiting run, and the new run re-evaluates.

Design, current setup, learnings, limitations and next steps: [`.github/review-gate/README.md`](.github/review-gate/README.md).

```bash
node --test .github/review-gate/gate.test.js
```
