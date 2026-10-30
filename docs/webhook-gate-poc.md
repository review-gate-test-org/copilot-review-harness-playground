# Webhook-driven review gate (GitHub App): decision doc and POC

> **Status: on hold (2026-10-30). The POC was not run.** Facts, assumptions, design and POC plan are complete;
> every ⏳ result is still open. The approval paths that were built are compared in
> [approval-overview](https://github.com/review-gate-test-org/approval-overview).
>
> Legend: ✅ verified (evidence linked) · ❓ assumption, not verified · ⏳ POC pending · ❌ refuted

## 1. TL;DR

- **Question:** can the review gate be driven by a GitHub App webhook, instead of Actions workflows, so the
  "Approve workflows to run" prompt disappears from every PR? Is that safe, and is it good UX?
- **Provisional verdict (⏳ until POC results land):** *worth considering, with conditions.* A webhook
  service removes the root cause of the prompt (a workflow listening to `pull_request_review`), and reacts
  in seconds instead of polling for 15 min. The price is real: the App's private key leaves GitHub, and
  merges in every gated repo depend on a service we must run, monitor and secure. Section 10 has the final verdict.

## 2. Goal of the harness

A PR to the default branch can merge when **either**

1. the owning code-owner team approves it, **or**
2. Copilot code review approves it (🟢) **and** `.github/AGENTOWNERS` lets an agent approve every changed file.

The gate logic is deterministic. Copilot is the only AI in the loop. Constraints: nothing that trusts PR
authors, and no weakening of repo security.

## 3. Problem this POC targets

Today ([`review-gate.yml`](../.github/workflows/review-gate.yml), [`gate.js`](../.github/review-gate/gate.js)) the
gate runs in GitHub Actions. Human reviews reach it through a relay workflow
([`review-gate-trigger.yml`](../.github/workflows/review-gate-trigger.yml)) on `pull_request_review`.

- **UX:** every Copilot review starts the relay with triggering actor `Copilot`, and GitHub holds that run as
  `action_required` ("Approve workflows to run"). The hold happens before any `if:` is evaluated, so the
  workflow cannot opt out. Merging no longer depends on that run, but the prompt still shows on every PR.
- **Gate weaknesses:**
  - The push-triggered run waits up to 15 min for Copilot, so a later 🟢 is missed until the next sweep.
  - `schedule` and `workflow_dispatch` runs share the concurrency group `'all'`. They can cancel each other and post a stale result.
  - `*/15` schedules fire every 2–5 h in practice.

## 4. Facts (verified)

| # | Fact | Evidence |
|---|------|----------|
| F1 | Copilot 🟢 = review state `APPROVED`. 🟡/🔵 = `COMMENTED`. The body starts with `<!-- ccr-overview-v2 -->`. | ✅ Earlier sessions, reviews on playground PRs |
| F2 | Copilot's `APPROVED` counts toward the ruleset's required approvals. Copilot cannot be a code owner. | ✅ Earlier sessions |
| F3 | Copilot reviews fire `pull_request_review`. The relay run is held with conclusion `action_required` and triggering actor `Copilot`. | ✅ 93 held runs in the playground on 2026-10-28, e.g. run [40674594622](https://github.com/review-gate-test-org/copilot-review-harness-playground/actions/runs/40674594622) (`pull_request_review`, `Copilot`). `workflow_run` chains from them are held too, e.g. [40674334543](https://github.com/review-gate-test-org/copilot-review-harness-playground/actions/runs/40674334543). |
| F4 | Webhook deliveries are not retried automatically. They can be redelivered for 3 days. A response slower than 10 s counts as failed. | ✅ [Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries) |
| F5 | Deliveries can be duplicated or arrive out of order. Each carries a unique `X-GitHub-Delivery` GUID and an HMAC-SHA256 `X-Hub-Signature-256`. | ✅ [Best practices for using webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks), [Validating deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) |
| F6 | `workflow_dispatch` needs `Actions: write`. `repository_dispatch` needs `Contents: write`, which also allows pushing code. | ✅ REST docs: [workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), [repository dispatch](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event) |
| F7 | Gate App `review-gate-test-org-gate` (id 5441748): contents, members, metadata and pull_requests read, statuses write. No webhook events today. Installed on **all** repos of the org (installation 174480244). | ✅ `gh api orgs/review-gate-test-org/installations` |
| F8 | Ruleset 25708463 on the playground's `main` requires checks `backend`, `client` and `review-gate`. `review-gate` is pinned to app 5441748. It also requires 1 approval and Copilot review on push. Code-owner review is off. | ✅ `gh api repos/…/rulesets/25708463` |
| F9 | The gate App's key exists only in the environment secret `review-gate` (default branch only). It cannot be used locally. | ✅ Earlier sessions |
| F10 | `gh webhook forward` (GitHub-native) forwards **repo or org** webhooks to localhost. It is for testing only, and only one forwarder per repo can run at a time. It cannot forward **GitHub App** webhooks. | ✅ [Using the GitHub CLI to forward webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing) |
| F11 | A repo setting can skip approval for workflows triggered by the Copilot **coding agent**. | ✅ [Changelog 2026-03-13](https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/). Whether it also covers Copilot **code review** is ❓ (A7). |

## 5. Assumptions (not verified; the POC tests most of them)

| # | Assumption | Status | How it is tested |
|---|-----------|--------|------------------|
| A1 | With no workflow listening to `pull_request_review` (and no `workflow_run` chain from it), Copilot reviews start **no** held runs, so the prompt disappears. | ⏳ Supported, outside this POC: [approval-machine-user](https://github.com/review-gate-test-org/approval-machine-user) has no workflow on review events, and 0 of its 42 runs were held (2026-10-30). Not yet shown with a webhook. | E2 |
| A2 | A `workflow_dispatch` run created with an App installation token is **not** held. This decides whether variant B works. | ⏳ | E6 |
| A3 | A webhook takes seconds from review submission to a `review-gate` status. Today a push-triggered run can wait up to 15 min. | ⏳ | E3 |
| A4 | Fail-closed: with the service down, no PR turns green. A push leaves the new head without the required status. | ⏳ | E4 |
| A5 | Only the pinned App can satisfy the required `review-gate` check. A status with the same context from a user token does not unblock merge. | ⏳ | E5 |
| A6 | A forged or replayed delivery cannot produce a false green, because the service treats the payload only as a hint and re-reads live state. | ⏳ | E7 (+ unit tests) |
| A7 | The F11 setting does not cover code-review-triggered runs. Even if it did, turning it off weakens a security control repo-wide. | ❓ | Not tested (option O0 is out of scope) |
| A8 | App webhook payloads equal repo webhook payloads plus an `installation` object. So a repo-webhook POC is representative of App-webhook ingress. | ❓ | Docs say so. The POC uses repo-webhook forwarding (F10). |
| A9 | GitHub blocks merge natively while a reviewer with write access has `CHANGES_REQUESTED`. This limits the damage of a missed "changes requested" event. | ❓ | Not tested |

## 6. Options

| ID | Option | Prompt gone? | Key custody | Verdict |
|----|--------|--------------|-------------|---------|
| O0 | Keep Actions and turn off "require approval" for Copilot (F11) | ❓ | unchanged | Rejected: weakens a security control and may not apply to code review (A7) |
| O1 | Status quo: Actions gate, relay, 15-min wait | ❌ (F3) | Key stays in GitHub | Baseline |
| O2 | Actions gate **without** the relay. Push run waits, plus schedule sweep. | ✅ by A1 | Key stays in GitHub | Simple, but human approvals and late 🟢 wait for the next sweep (2–5 h in practice) |
| **S** | **App webhook → service** verifies HMAC, dedupes, answers 2xx fast, re-reads live PR state, runs `gate.js` `evaluate()`, posts status on the current head. | ✅ by A1 | **Key leaves GitHub** (in the service) | **POC target** |
| **B** | **App webhook → bridge** that only calls `workflow_dispatch` on the gate workflow with an `Actions: write` token. The gate key stays in the Actions environment. | ✅ by A1, if A2 holds | Gate key stays in GitHub. The bridge holds a weaker dispatch-only key. | **POC target (A2)** |

**Why S and B are both kept.** S is the simplest and fastest. B keeps the green-posting key inside GitHub.
B still needs a hosted receiver, and it adds Actions queue time and Actions minutes to every event.

## 7. POC

### 7.1 Goal

Produce evidence for A1–A6. Specifically:

- Does the prompt disappear?
- How fast is the gate?
- Does it fail closed?
- Who can post green?
- Is the bridge variant viable?

Out of scope:

- Production hosting
- Multi-repo rollout
- Prompt injection through Copilot custom instructions (tested in a separate session)

### 7.2 Setup (isolation)

- **Separate repo** `review-gate-test-org/review-gate-webhook-poc`. It has the same layout (`backend/`, `client/`,
  `CODEOWNERS`, `AGENTOWNERS`) and **no** review-gate workflows. Its ruleset requires the `review-gate` status pinned to
  app 5441748, and Copilot review on push. The playground's `main`, ruleset, workflows and open PRs stay untouched.
- **Same App** (5441748), with an **extra private key** created for the POC and **revoked afterwards**.
  - Risk: while that key exists, a laptop holds a key that can post a green `review-gate` on the playground too (F7, F8).
    That is acceptable for a sandbox org, and it shows the key-custody problem of option S (§8.1).
  - The receiver **allowlists the POC repo**, so it never races the playground's Actions gate. The App is installed org-wide.
- **Ingress:** `gh webhook forward` from a repo webhook on the POC repo to a local Node receiver. This is GitHub-native, with no
  third-party relay. App webhooks cannot be forwarded this way (F10), so App ingress is approximated (A8).
- **Receiver:** [`poc/webhook-gate/`](../poc/webhook-gate/). It reuses `evaluate()` from `gate.js` unchanged.

### 7.3 Experiments

| ID | Experiment | Pass criterion |
|----|-----------|----------------|
| E1 | PR touching only `client/`. Copilot reviews 🟢. | `review-gate` turns `success` with no human action |
| E2 | After E1 and the other PRs, list `action_required` runs in the POC repo. Check the PR page. | 0 held runs, no prompt on the PR |
| E3 | Latency: Copilot review `submitted_at` → `review-gate` status `created_at`. Same for a push → `pending`. | Report p50 and max over the runs |
| E4 | Stop the receiver. Push a commit, let Copilot review it. Then start the receiver and run the reconciler (sweep of open PRs). | Merge stays `BLOCKED` while down, and turns green after reconciling |
| E5 | Post `review-gate`=`success` on the head with a **user** token. | Merge still `BLOCKED` (status from the wrong app) |
| E6 | Bridge: call `workflow_dispatch` with an App installation token. Check whether the run is held. | Run starts without approval → B viable |
| E7 | Send deliveries with no signature or a bad one. Replay a valid one. Send a valid-signature payload that claims `APPROVED` on a PR without approvals. | 401 for bad signatures, replay deduped, forged claim → still `pending` |
| E8 | PR touching `.github/` (not agent-approvable). Copilot 🟢. | Stays `pending`: "copilot may not approve 1 file(s)" |

## 8. Results ⏳

### 8.1 Safety

| Topic | Finding | Status |
|-------|---------|--------|
| Key custody (S) | Whoever holds the App key can mint installation tokens and post a green `review-gate` on **every installed repo**. The ruleset pins the App, not the workflow. Today the key is only reachable from default-branch workflows in the `review-gate` environment. With S it lives in the service host: its secrets store, its operators and its deploy pipeline all become part of the gate's trust base. Mitigations: an App per purpose with minimal permissions, a non-exportable key (KMS/HSM signing of the JWT), installation on selected repos only, rotation, audit-log alerts on `review-gate` statuses. | ✅ by design (F7, F8). Mitigations ❓ |
| Key custody (B) | The bridge key only needs `Actions: write`. If it leaks, an attacker can dispatch, cancel or disable workflows: a DoS, which fails closed. It cannot post green. `repository_dispatch` is not an option, because it needs `Contents: write` (F6). | ⏳ A2 |
| HMAC | Verify `X-Hub-Signature-256` over the raw body with a constant-time compare. Reject missing or invalid signatures before parsing. | ⏳ E7 |
| Payload as hint only | The service reads only the repo and PR number from the payload. It re-reads reviews, files, CODEOWNERS and AGENTOWNERS (from the default branch) with its own token. A forged payload can at most trigger a re-evaluation. | ⏳ E7 |
| Who can post green | Only the pinned App (A5). | ⏳ E5 |
| Fail-closed | Statuses are per SHA. A new push has no status until the service posts one. Service down → nothing turns green. | ⏳ E4 |
| Stale green | A lost `dismissed` or `CHANGES_REQUESTED` delivery leaves an old green on the **same** head. The reconciler bounds the window. A9 may cover the `CHANGES_REQUESTED` case. Today's Actions gate has the same gap. | ❓ |
| Out of order / duplicates | Dedupe by delivery GUID. Serialise evaluations per PR (a newer event re-runs after the current one), and always evaluate the **live** head. | ⏳ unit tests + E7 |

### 8.2 UX

| Topic | Finding | Status |
|-------|---------|--------|
| Held prompt | ⏳ | E2 |
| Latency (Copilot 🟢 → green) | ⏳ | E3 |
| Latency (push → pending) | ⏳ | E3 |
| What authors and reviewers see | One `review-gate` status with a reason ("Needs code owner approval (@org/backend); copilot has not approved"). No "Approve workflows to run" banner. No 15-min "Waiting for copilot" job burning Actions minutes. | ⏳ |
| When the service is down | PRs stay yellow, or have no `review-gate` status on new commits, until it recovers and the reconciler runs. Merges are blocked org-wide, not unsafe. | ⏳ E4 |

## 9. Limitations and what production would need

- **Hosting and ingress:** an always-on HTTPS endpoint on company infrastructure. Optionally allowlist
  [GitHub's hook IPs](https://api.github.com/meta). `gh webhook forward` is for testing only (F10).
- **Reconciler for lost deliveries** (F4): sweep open PRs every few minutes, and/or redeliver failed deliveries via the
  App's [deliveries API](https://docs.github.com/en/rest/apps/webhooks).
- **Per-PR serialisation across instances:** a single instance, or a lock or queue keyed by repo#PR.
- **Key management:** non-exportable key, rotation, separate Apps for the gate and the bridge.
- **On-call and SLO:** service availability equals merge availability for every gated repo.
- **Org install approval and security review** for an App with `statuses: write` installed across repos.
- **Rate limits:** each evaluation costs about 5–8 REST calls (more with team lookups). Fine per repo, but needs care org-wide.
- **POC-only gaps:** repo-webhook ingress instead of App webhook (A8), one repo, one laptop, no persistence of
  delivery IDs (deduping is in memory).

## 10. Verdict ⏳

*Provisional:* a direction worth considering **if** the org accepts running and securing one more service
(S), or accepts Actions queue time per event (B). Final verdict follows the results in §8.
