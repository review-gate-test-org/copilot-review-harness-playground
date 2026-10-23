# copilot-review-harness-playground

Sandbox for testing whether GitHub Copilot code review can approve pull requests
and enable merging, while still requiring a human code owner review where needed.

| Path | Stack | Code owner |
|------|-------|------------|
| `backend/` | Java 21, Maven | @JacobiCamunda |
| `client/` | TypeScript, React (Vite) | @venetrius |

## Build

```bash
cd backend && mvn verify
cd client && npm ci && npm run lint && npm run build
```
## Review gate

Merging to `main` requires the `review-gate` commit status, posted by a GitHub App from
[`.github/workflows/review-gate.yml`](.github/workflows/review-gate.yml). It is green when:

- **code owners approved** (every file owned in `CODEOWNERS` has an approval from one of its owners), or
- **Copilot approved** the head commit **and** every changed file is agent-approvable in
  [`.github/AGENTOWNERS`](.github/AGENTOWNERS) (CODEOWNERS syntax, agent IDs instead of users).

Otherwise it stays yellow (`pending`) and says what is missing. `.github/**` and `CODEOWNERS` always need a human.

```bash
node --test .github/review-gate/gate.test.js
```
