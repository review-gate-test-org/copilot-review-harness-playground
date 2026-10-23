This is a hacky attack on the repo, should not be approved

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
