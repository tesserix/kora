# Multi-product AI platform implementation plan

<!-- markdownlint-disable MD013 -->

- Status: proposed delivery plan
- Date: 2026-08-23
- Architecture: [multi-product AI platform RFC](multi-product-ai-platform-rfc.md)
- Kora pilot execution: [Kora governed AI platform pilot plan](kora-ai-platform-pilot-execution-plan.md)
- Pilot selection: Kora approved on 2026-08-23; DevAI deferred

## Outcome

Deliver one governed path from a product request to a reviewed agent, product
MCP tool, and approved provider/model. The path must be authenticated,
tenant-scoped, budgeted, observable, durable where necessary, and unable to
silently bypass policy.

The implementation is intentionally phased. The repositories that own the
shared runtime and infrastructure contain active unrelated work, so this plan
does not propose a large cross-repository patch or an imperative production
change. Each workstream lands in its owning repository with its own tests and
GitOps rollout.

## Baseline and gap matrix

| ID | Capability | Current evidence | Gap to close | Target owner |
| --- | --- | --- | --- | --- |
| G-01 | Kora private model gateway | Live Vertex route and 7,400/7,480 successful reviewed requests | Prove fallback, reconcile desired docs/config, add HA and conformance dashboard | `tesserix-k8s`, `kora` |
| G-02 | Kora reviewed A2A | 15 successful runs across two pre-deployed agents | Deploy fail-closed Registry resolution and no-bypass behavior; add more agents only through gates | `kora`, `ai-agents` |
| G-03 | Shared provider gateway | Solo `ai-gateway` is programmed and 2/2; public listener has strict ZITADEL role policy; Vertex uses GCP auth while most other provider backends use credential passthrough; legacy DevAI NGINX remains 1/1 | Define platform-managed versus brokered-BYOK modes, prohibit arbitrary runtime passthrough, prove every alias with authenticated canaries, then retire legacy NGINX only after traffic ownership evidence | `tesserix-k8s` |
| G-04 | Public MCP gateway | Solo `agentgateway-mcp` is programmed and 2/2; 11 `HTTPRoute` objects are accepted/resolved; public listener checks generic role `agentgateway.mcp`; machine OAuth metadata/challenge is not conformant | Add RFC-compliant protected-resource discovery and challenge, product/tenant/server/tool grants, upstream re-authorization, canonical URLs, timeouts, and protocol canaries | `tesserix-k8s`, MCP server owners |
| G-05 | Generic agent provisioning | kagent controller is crash-looping with 267 observed restarts; ATE API is not ready; no accepted dynamic-agent identity/sandbox path exists | Diagnose dependencies read-only first; keep dynamic execution disabled until identity, provenance, isolation, cleanup, capacity, and recovery acceptance | `tesserix-k8s`, `devai` |
| G-06 | Registry correctness | Registry clients and bundle concepts exist; Kora fail-closed PR #370 is not deployed | Reject unresolved refs, verify signatures/digests/closure, define stale-cache risk policy | `agentic-registry`, consumers |
| G-07 | Runtime source of truth | Kora reviewed runtime works; DevAI has both Registry artifact and local specialization shapes | Hydrate one pinned, evaluated bundle into each accepted runtime; Registry publication alone must not execute | `devai`, `ai-agents`, ADK |
| G-08 | Gateway request contract | Kora and DevAI send useful capability/context headers | Version a shared server-derived envelope and decision record; never trust client routing fields | product repos, ADK |
| G-09 | Identity/delegation | Kora API verifies Firebase, then forwards the raw token through Solo to A2A; the agent returns it on gateway model calls; ADK narrowing primitives exist | Terminate login tokens at product APIs; exchange for audience-bound, short-lived, replay-controlled A2A/MCP grants plus workload identity and product-boundary object re-authorization | Platform Security, ADK, gateways |
| G-10 | Model selection | Kora private priority groups and DevAI routing adapters exist | Logical aliases, hard eligibility filters, quality/cost/latency ranking, recorded policy version | `tesserix-k8s`, product repos |
| G-11 | Usage/cost | Kora durable usage events and DevAI usage ledger exist | Link action and attempt ledgers, count failed/fallback/judge calls, provider reconciliation | product repos, gateway telemetry |
| G-12 | Token optimization | Kora ExtProc path and optimizer policy exist | Golden quality/schema tests, representative latency/cost evidence, prompt-cache metrics | `token-optimizer`, `tesserix-k8s` |
| G-13 | Temporal durability | DevAI adapter/worker exists; most HA services run, but one frontend is pending and Argo application `temporal-platform` is progressing; production durability acceptance is incomplete | Make the HA platform healthy, isolate product namespaces/queues, keep event history handle-only/encrypted, and pass replay/versioning/cancellation/worker-kill/idempotency tests | `tesserix-k8s`, `devai` |
| G-14 | Sandbox | DevAI sandbox/evaluation code is extensive; ADK has sandbox seam | Harden Job path, keep kagent/Substrate NO-GO until tokenless isolation/network/capacity gates pass | `devai`, `tesserix-k8s`, ADK |
| G-15 | Product MCP learning | MCP Hub/Registry artifacts and several product routes exist | Per-product resources/tools, provenance, risk classes, tenant retrieval filters, freshness/deletion | product repos, `agentic-registry` |
| G-16 | Agent evaluation/promotion | DevAI has versioned datasets/evals and publication ADRs; Kora agents have evals | Make conformance evidence mandatory for every routable agent/skill/tool bundle | `devai`, `ai-agents`, Registry |
| G-17 | Model training | Raw support JSONL export exists as a prerequisite only | Consent/redaction/versioning/splits, isolated trainer, evals, model registry, shadow/canary alias promotion | AI Platform, Security, Data Governance |
| G-18 | Availability | Kora API and Agentic Registry are 1/1; Solo controller and three data planes, rate-limit service, token optimizer, and Kora agents are 2/2 | Capacity-check API/Registry dependencies, then add safe replicas, disruption budgets, topology spread, connection-pool limits, and one-pod-loss/recovery evidence | product owners, `tesserix-k8s` |
| G-19 | Documentation truth | Several design documents describe earlier models/routes or proposed state as current | Add generated readiness inventory and date-stamped verification; fail CI on broken internal links/config drift | all owners |

## Delivery rules

1. Start every cloud or cluster change with read-only account, project, context,
   namespace, resource, condition, logs, events, and RBAC discovery.
2. Prefer the owning GitOps repository. Do not patch a live resource that Argo
   CD will revert.
3. Treat rollout, rollback, deletion, replacement, credential rotation,
   database migration, and production scaling as separately approved actions.
4. One pull request should prove one boundary. Avoid a release that changes
   identity, provider routing, runtime, and model at once.
5. Every provider, model, agent, skill, MCP server/tool, and product must pass a
   conformance gate before becoming routable.
6. Keep a definite rollback that does not delete state or CRDs.
7. Never claim readiness from a healthy pod or accepted resource alone; execute
   the authenticated product-level request and inspect durable evidence.

## Workstream 0: Establish a truthful and fail-closed baseline

### 0.1 Deploy Kora fail-closed behavior

Owning repository: `kora`.

Use the existing `fix/ai-gateway-registry-fail-closed` work as the starting
point. Before merge/deploy:

- repair CI so jobs execute rather than fail before steps;
- retain the targeted passing race test for `internal/agents`,
  `internal/config`, and `internal/coach`;
- run the complete documented API verification suite;
- prove unresolved Registry references are rejected;
- prove A2A failure cannot silently call a provider directly;
- prove production configuration requires Gateway and Registry;
- canary one Kora API replica and observe request, error, latency, and usage.

Acceptance:

- no arbitrary Registry URL reaches network I/O;
- both reviewed Kora agents still complete through Gateway;
- Registry outage follows the documented stale-cache/fail-closed policy;
- rollback is the previous Kora image/feature configuration, with no data
  deletion.

### 0.2 Publish a machine-readable readiness matrix

Owning repositories: `tesserix-k8s` plus a read-only platform canary image.

Create a scheduled read-only conformance job that records, without secret or
prompt bodies:

- Registry health, signed bundle resolution, and staleness;
- each product Gateway authentication rejection and valid request;
- every enabled provider/model alias using a minimal safe prompt;
- every MCP server `initialize`, `tools/list`, and one read-only canary tool;
- each reviewed A2A agent `message/send` with a synthetic fixture;
- Temporal namespace/task-queue and worker poller health;
- sandbox create/invoke/destroy only after runtime acceptance.

The output is a dashboard and durable test result, not a public unauthenticated
health endpoint that reveals providers or tenants.

Acceptance: readiness can say `ready`, `configured-not-proven`, `degraded`, or
`disabled`, with last success, policy/artifact digest, and owner.

### 0.3 Restore high availability basics

Owning repositories: product charts and `tesserix-k8s`.

- raise Kora API and Agentic Registry from one replica only after resource and
  connection-pool headroom is verified;
- add/readiness-check disruption budgets and anti-affinity/topology spread;
- run one-pod-loss tests;
- confirm database/Valkey connection limits before scaling;
- keep product Gateway policy isolated by workload identity.

This is a production scale change and requires explicit rollout approval.

## Workstream 1: Version the shared contracts

### 1.1 Capability request and decision schemas

Owners: ADK for portable types; Kora and DevAI for adapters.

Add versioned, vendor-neutral types for:

- `CapabilityRequest` and `CapabilityResult`;
- `PrincipalContext` with server-derived product/tenant/subject;
- `RiskClass`, `IntentClass`, and data classifications;
- `ExecutionConstraints` and resolved budget sources;
- `RouteDecision` and rejected-route reasons;
- `AttemptOutcome`, including `uncertain`;
- context claim-check references and output-schema references.

Keep provider SDK types and Kubernetes types outside the contract. Reject an
unknown major schema version. Add serialization fixtures shared by Go/Python
consumers.

Acceptance:

- a Kora fixture and a DevAI fixture round-trip without loss;
- client-supplied identity/routing fields are ignored or rejected at the HTTP
  boundary;
- provider/model names are absent from product-facing request types.

### 1.2 Resolved agent bundle

Owners: Agentic Registry, ADK, DevAI, AI Agents.

Define one immutable runtime bundle containing:

- agent, prompt, skill, output schema, MCP tool/server, and runtime refs;
- transitive member digests and one canonical `bundleDigest`;
- declared scopes, capabilities, budgets, risk, and model requirements;
- evaluation suite/run evidence;
- image digest or trusted runtime implementation;
- signature/provenance and revocation state.

Registry remains the catalog. ADK validates/hydrates the bundle. DevAI, Kora,
and agent runtimes admit it against their product allowlists.

Acceptance:

- changing a transitive tool schema or prompt changes the bundle digest;
- an unknown/missing member fails resolution;
- a revoked or unsigned artifact cannot start a new production run;
- another tenant cannot infer or fetch a private bundle;
- cached bundles are keyed by scope and digest.

### 1.3 Product policy manifest

Owner: `tesserix-k8s`, with schema review by product/platform owners.

Implement the RFC’s `AIProduct` shape by extending an existing GitOps/Registry
configuration model. Do not create a second standalone control-plane database.
Validate identity, capabilities, model aliases, agent/tool allowlists, budgets,
data classes, residency, evaluation suites, and SLO owner in CI.

## Workstream 2: Make provider routing governed and efficient

### 2.1 Product gateway isolation

Owner: `tesserix-k8s`.

- retain Kora’s private data plane as the reference pattern;
- create equivalent DevAI policy isolation;
- use separate service identities, secrets, routes, rate/token budgets, and
  telemetry dimensions;
- prohibit cross-product backend references in admission tests;
- require Gateway use in production application configuration;
- remove credential passthrough from production shared provider backends.

### 2.2 Model aliases and policy

Owner: gateway GitOps configuration.

Start with a small alias set per product. Each alias defines:

- eligible providers/models/regions;
- required modality, tool, JSON, and safety behavior;
- maximum context/output/cost/latency;
- evaluation suite and minimum quality/safety floor;
- fallback equivalence set;
- cache and optimizer policy.

Do not begin with automatic reinforcement or continuously changing weights.
Use deterministic, versioned ranking based on measured route evidence. Emit a
decision record for every attempt.

### 2.3 Provider conformance

For every route, run:

- auth success and invalid-auth rejection;
- text, structured JSON, tool-call, streaming, image, audio, and embedding tests
  only where declared supported;
- deadline/cancellation and usage mapping;
- 429/5xx failover and both-providers-down behavior;
- data-region and egress verification;
- prompt-cache and token-accounting verification;
- output-schema and safety golden sets.

Kora Anthropic fallback is not ready until a controlled primary failure reaches
Anthropic, returns a valid result, records both attempts, and stays inside Kora’s
deadline and budget.

### 2.4 Token and context optimization

Owners: `token-optimizer`, gateway policy, product prompt owners.

Implement/verify in this order:

1. deterministic product cache and no-model paths;
2. Registry progressive disclosure and compiled bundle cache;
3. tenant-filtered retrieval and conversation compaction;
4. deterministic prompt prefixes and provider cache metrics;
5. ExtProc compression on eligible context only;
6. cheap-first escalation backed by capability evaluation.

Release gates:

- no schema or critical-fact loss on golden cases;
- no meaningful safety/quality regression;
- representative p50/p95/p99 optimizer latency;
- actual cache-read tokens and reconciled cost, not a theoretical saving;
- original request used when optimization fails; hard budget remains enforced.

## Workstream 3: Repair and standardize MCP

### 3.1 Public protocol and OAuth

Owners: public MCP gateway and identity configuration in `tesserix-k8s`.

- publish exact server-specific machine URLs;
- provide protected-resource metadata at the standards-defined location;
- return an OAuth challenge usable by non-browser clients;
- validate issuer, audience, expiry, scopes, tenant, and token binding;
- bound initialize/session timeouts and propagate cancellation;
- preserve protocol version and capability negotiation;
- make `/mcp` a documented landing/discovery response or clearly direct clients
  to a server-specific path;
- add synthetic canaries for `initialize`, `tools/list`, `resources/list`, and a
  read-only call.

Acceptance: two independent standards-compliant MCP clients can discover auth,
initialize, list, and call Kora/DevAI read-only tools without manual token
injection or a browser redirect in the machine path.

### 3.2 Product MCP servers

Initial Kora surface:

- product help/resources with source digests and freshness;
- nutrition/food schema resources safe for the authenticated product user;
- read-only context tools that remain user-scoped;
- propose-only meal/coach tools;
- diary mutation only after explicit Kora confirmation, trusted food-row reload,
  and idempotency.

Initial DevAI surface:

- repository tree/code-index and target-repository conventions;
- run/trace/evaluation status;
- propose plan/patch/remediation;
- branch/PR mutation through a short-lived repository grant;
- protected-branch merge and production action behind approval.

Every tool has an immutable schema/digest, risk class, scopes, rate/cost limit,
idempotency behavior, data classification, retention, and owner.

### 3.3 Gateway route synchronization

Replace “route accepted” as the completion criterion with:

- resolved Registry server/tool digest;
- accepted Gateway route and policy attachment;
- reachable and authenticated upstream;
- protocol conformance;
- tenant/tool allowlist enforcement;
- end-to-end audit/usage result.

Deleted/revoked server routes need deterministic reconciliation. Route sync
must not leave an old backend reachable indefinitely.

## Workstream 4: Make durable execution real

### 4.1 Deploy the HA Temporal platform

Owner: `tesserix-k8s`.

Use the staged `temporal-system` design as the starting point, but do not add it
to the production kustomization until approved prerequisites are complete:

- dedicated HA Postgres/CNPG persistence with TLS and backups;
- supported visibility store and retention;
- external secrets and least-privilege identities;
- two or more Temporal server replicas with disruption policy;
- authenticated UI behind BFF, not public direct access;
- encryption/codec for sensitive payloads;
- per-product namespace, task queue, retention, quota, and worker identity;
- metrics, alerts, backup/restore, and disaster-recovery exercise.

Do not reuse the current single-node embedded-database installation as the
multi-product production backbone without an explicit migration and capacity
decision.

### 4.2 Turn on DevAI Temporal by evidence

Owner: `devai` plus its chart.

- keep local/test default `inproc`;
- set production to `temporal` only after worker reachability and namespace
  provisioning pass;
- ensure all I/O remains in activities;
- use opaque prompt/transcript handles;
- define activity retry, timeout, heartbeat, cancellation, and idempotency;
- version workflows and worker builds;
- remove per-run silent fallback to in-process in production. An unavailable
  durability dependency must not pretend a durable run was started.

Acceptance tests:

- kill a worker mid-run and resume without duplicate commit/PR/tool mutation;
- hold an approval longer than one hour with no pod-held state;
- retry a provider 429 within budget and record every attempt;
- cancel an in-flight run and settle already-spent usage;
- deploy a compatible worker version and replay old history;
- restore a test namespace from backup.

### 4.3 Keep Kora’s hot path simple

Do not put current resolve or one-shot coach calls inside Temporal. If proactive
post-log nudges are approved, first implement:

- food log and outbox insert in one Postgres transaction;
- at-least-once worker with `log_id` idempotency;
- bounded retry and dead-letter/terminal state;
- nudge persistence and retrieval;
- no agent call while the database transaction is open.

Move to Temporal only when the workflow gains long waits, multiple remote
mutations, or compensation that justifies it.

## Workstream 5: Harden sandboxes and evaluations

### 5.1 Supported near-term runtime

Owner: `devai` and `tesserix-k8s`.

Use the existing ephemeral Job sandbox path as the supported route while
kagent/Substrate remains disabled. Enforce:

- immutable image digest and pinned ADK version;
- per-run namespace/workspace identity;
- tokenless ServiceAccount and no workload/cloud identity;
- runtime class providing a reviewed kernel boundary;
- default-deny network and explicit gateway/broker egress;
- no direct provider, Registry write, product database, metadata, or Kubernetes
  API access from the actor;
- credential broker grants bound to user, tenant, run, audience, scope, and TTL;
- resource/output/token/cost/time ceilings;
- TTL teardown and durable, owner-scoped evidence.

### 5.2 kagent/Substrate acceptance

Do not change `DEVAI_KAGENT_ENABLED=false` until all are true:

1. a published, digest-pinned compatible release needs no local patch;
2. WorkerPools use tokenless ServiceAccounts and no cloud identity;
3. root, hostPath, AppArmor, and broad capability requirements have an approved
   dedicated-node threat model or are removed;
4. default-deny ingress/egress and cross-tenant negative tests pass;
5. per-sandbox create/readiness/dispatch/teardown preserves every `SandboxSpec`
   field or fails closed;
6. 5/20/50 Actor tests capture CPU, memory, pods, queue, failures, cold start,
   p50/p95 runtime, and impact on core workloads;
7. uncertain A2A results reconcile by stable run ID and are never replayed;
8. one-step GitOps rollback is rehearsed.

### 5.3 Evaluation and promotion

Use DevAI’s versioned dataset/evaluation storage and agent publication gate as
the platform pattern. A routable agent version must have:

- immutable candidate bundle and dataset/suite versions;
- deterministic/schema/task scorers;
- trajectory/tool-selection and forbidden-action scorers;
- model judge only where judgment is genuinely required, with pinned judge;
- safety 100% for required refusal/destructive cases;
- latency, tokens, cost, retries, and blocked-call limits;
- baseline comparison on the same dataset;
- every failed case linked to a durable trace;
- owner-scoped override with non-empty reason and append-only audit, only where
  product policy permits override.

Kora agent publication should consume the same evidence shape even if its eval
runner remains in `ai-agents` initially.

## Workstream 6: Build the governed model-improvement lane

This workstream starts only after usage, evaluation, MCP retrieval, and routing
evidence identify a gap that prompt/tool/RAG changes do not solve.

### 6.1 Data eligibility and lineage

Owners: Product, Security, Privacy/Data Governance.

Define:

- approved data sources and explicit purpose;
- consent and product/tenant eligibility;
- retention and user deletion propagation;
- DLP, secret, PII, and unsafe-content redaction;
- deduplication and conversation/user-level split policy;
- labeling rubric, quality review, and provenance;
- immutable dataset version/digest in encrypted object storage;
- access audit and tenant isolation.

Pause the existing support conversation export from being treated as
training-ready. It may continue only under its approved current purpose; a
trainer must reject it until a governed dataset manifest and approval exist.

### 6.2 Training backend and sandbox

Add a provider-neutral `TrainingBackend` adapter. The first implementation may
use Vertex AI custom training or an isolated Kubernetes GPU Job, chosen after
cost, model-license, residency, and operations review.

Each job gets:

- immutable trainer/base-model/dataset digests;
- isolated service account, namespace/node pool, and network;
- read access to exactly one dataset prefix;
- write access to exactly one run-artifact prefix;
- no production DB, product service, or provider-serving credentials;
- GPU/time/cost quota and cancellation;
- signed lineage manifest, logs with no training examples/secrets, and durable
  terminal state.

### 6.3 Temporal training workflow

Implement one durable workflow:

1. validate data approval and freeze dataset;
2. run baseline evaluations;
3. request budget/human approval;
4. launch and monitor isolated training activity;
5. register candidate artifact;
6. execute offline quality/safety/privacy/robustness evaluations;
7. compare candidate to base/current alias;
8. wait for promotion approval;
9. shadow, canary, and observe;
10. submit a GitOps alias promotion or rollback.

Temporal carries handles and digests, not dataset rows or model weights.

### 6.4 Model release gate

No trained model becomes eligible until it has:

- base model/license and data-lineage approval;
- signed artifact and vulnerability/provenance evidence;
- no regression on required product safety/authorization/tool tests;
- privacy memorization/extraction testing;
- adversarial injection and jailbreak testing;
- quality, latency, capacity, and reconciled cost comparison;
- shadow evidence, small canary, alert thresholds, and alias rollback;
- explicit product, AI Platform, and Security approval.

Promote a logical alias through GitOps. Never edit product code or let a
training job update a live endpoint directly.

## Workstream 7: Select and onboard one pilot product

The first implementation must have one product owner, one bounded capability,
and one rollback. It must not begin by changing Kora and DevAI together. Product,
AI Platform, Platform Engineering, and Security record the selected product and
capability in an ADR after Workstream 0 evidence is current.

### Product-selection gate

Scores measure suitability for the first platform pilot, not general product
quality or production readiness. Each criterion is scored from 1 (blocked or
unproven) to 5 (live-proven and bounded), then multiplied by its weight.

| Criterion | Weight | Kora | DevAI | Evidence affecting the score |
| --- | --- | --- | --- | --- |
| Proven Solo.io product request path | 25% | 5 | 3 | Kora model, embedding, and A2A paths have live successes; DevAI model/MCP clients are wired but individual routes lack conformance proof |
| Reviewed agent runtime | 20% | 5 | 2 | Two Kora agents are live; DevAI dynamic-runtime source of truth and acceptance remain incomplete |
| Security boundary is narrow enough to pilot | 20% | 4 | 2 | Kora has a raw-token delegation gap but a small route set; DevAI spans more providers, MCP servers, BYOK shapes, sandboxes, and automation authority |
| Independence from blocked durability/sandbox components | 15% | 5 | 1 | Kora's synchronous path does not require Temporal or kagent; important DevAI target flows do |
| Product MCP readiness | 10% | 2 | 3 | Kora still needs its product MCP surface; DevAI has broader wiring, but protocol and fine-grained auth are not proven |
| Availability and recovery evidence | 10% | 3 | 2 | Kora Gateway/agents are 2/2 while its API is 1/1; DevAI's durable/sandbox recovery path remains incomplete |
| **Weighted pilot-fit score** | **100%** | **86/100** | **44/100** | A score is a selection aid, not permission to release |

**Decision: Kora is selected** and the initial pilot is scoped to one read-only
nutrition-coach capability. It exercises product authentication, Registry
resolution, an ADK/A2A agent, the isolated `kora-ai` Solo data plane, token
optimization, provider selection, budgets, and evaluation without making
Temporal or an untrusted code sandbox a prerequisite. The owner approved this
selection on 2026-08-23; scope changes still require an explicit decision.

Select DevAI instead only if the goal of the first pilot is specifically to
prove durable dynamic automation and the owners accept that Temporal, sandbox,
MCP, BYOK, and kagent/ATE blockers make it a longer security program rather
than the shortest route to a reusable product pattern.

### Kora pilot exit gate

Required before calling the recommended Kora capability platform-ready:

- Firebase login token terminates at Kora API and an audience-bound internal
  delegation is verified at Solo, agent, and product boundaries;
- fail-closed Registry and A2A behavior is deployed;
- the two reviewed agents and Vertex routes pass scheduled canaries;
- Anthropic fallback passes a controlled, budgeted exercise;
- one Kora MCP read-only resource/tool re-authorizes the principal and passes
  tenant, injection, destination, and protocol negative tests;
- Kora action and provider-attempt records reconcile, including failed and
  fallback attempts;
- gateway/API replica and one-pod-loss behavior meet the approved objective;
- prompt, turn, usage, Registry-cache, and audit retention is ratified;
- dashboard and runbook identify owner, last conformance evidence, and rollback.

Do not change Kora's trusted nutrition, user-ownership, quota, or confirmation
invariants while generalizing the platform. Mutation is a later capability and
requires an idempotency key plus product re-authorization.

### DevAI alternative exit gate

If owners select DevAI, it is not platform-ready until:

- P0 authentication, authorization, and provider-bypass paths pass negative
  tests;
- Registry bundle is the digest-pinned executable source of truth;
- production model and MCP gateway use is mandatory;
- the supported Job sandbox passes cross-principal, tokenless identity, egress,
  kernel, cleanup, resource, and 5/20/50 concurrency tests;
- dataset, evaluation, and promotion evidence is durable and owner-scoped;
- the Temporal platform is healthy and resumes a killed, versioned workflow
  without duplicating an idempotent activity;
- MCP routes are destination-allowlisted and protocol, OAuth/internal grant,
  backend re-authorization, timeout, and attribution conformance passes;
- kagent remains disabled unless every separate acceptance gate passes.

### Future product template

After the selected pilot passes, publish a template containing:

- AI Interface adapter and server-derived envelope;
- `AIProduct` policy manifest;
- private product gateway values/policies;
- workload identity and Secret Manager references;
- MCP server skeleton with read/propose/mutate separation;
- ADK agent bundle and eval suite examples;
- action/attempt ledger schema and dashboard;
- synthetic canaries, negative tests, rollout, and rollback runbook.

## Conformance gates

| Object | Required gate before routable |
| --- | --- |
| Product | Identity, tenancy, data policy, budget, gateway isolation, action ledger, rollback |
| Provider/model route | Auth, modality/schema/tools, region, safety eval, usage/cost mapping, load, fallback |
| Agent bundle | Signature, transitive digest, runtime admission, scopes, budget, eval/baseline, image provenance |
| Skill/prompt | Version/digest, injection review, token budget, expected capability tests |
| MCP server | Canonical URL, OAuth/internal auth, SSRF/egress, tenancy, protocol, capacity, revocation |
| MCP tool | Schema, risk, scopes, idempotency, confirmation/approval, negative authorization tests |
| Sandbox backend | Tokenless identity, kernel boundary, network, cleanup/reuse, concurrency, usage attribution |
| Temporal workflow | Replay safety, versioning, activity idempotency, cancellation, kill/recovery, payload policy |
| Dataset | Consent, redaction, deletion, tenant, version/digest, split/leakage, access audit |
| Trained model | Lineage/license, safety/privacy/quality, capacity/cost, shadow/canary, alias rollback |

## Verification matrix

### Contract tests

- Go/Python request/result fixtures;
- Registry bundle canonicalization and signature verification;
- ADK identity/delegation/budget/uncertain outcome;
- provider and MCP adapter conformance;
- usage action/attempt reconciliation.

### Security tests

- cross-user and cross-tenant object access returns 404 where appropriate;
- forged product/tenant/provider/model/route headers fail;
- Agent Card/MCP URL SSRF and destination allowlist;
- prompt, retrieved-content, tool-result, and output injection corpus;
- credential scope/audience/expiry and revocation;
- sandbox metadata/Kubernetes/provider/direct-egress denial;
- destructive tool approval and stale/forged approval rejection.

### Reliability tests

- provider and MCP dependency fault injection;
- Registry stale cache and revocation;
- retry amplification audit across every layer;
- Temporal worker kill/replay/cancel/continue-as-new;
- uncertain mutation reconciliation;
- pod/node loss and disruption budget;
- usage/audit datastore failure semantics.

### Evaluation tests

- product happy path and deterministic facts;
- adversarial injection and should-refuse;
- tool failure and recovery;
- schema and citation/grounding;
- fallback equivalence;
- latency/token/cost ceilings;
- model/agent candidate versus pinned baseline.

### Load tests

- Kora’s current 10 requests/second assumption;
- Registry search/resolve and cache cold start;
- gateway/provider quotas and connection pools;
- MCP sessions and long-lived transports;
- DevAI 5/20/50 sandboxes/actors;
- Temporal concurrent workflows and activity backlogs;
- training GPU quota/cost guard.

## Rollout sequence

For each product/capability:

1. merge contracts and tests with runtime disabled;
2. publish immutable agent/tool/model artifacts;
3. apply gateway and runtime GitOps desired state;
4. run authenticated synthetic and negative tests;
5. shadow without product side effects;
6. internal users only;
7. small canary by server-owned feature flag;
8. expand while comparing success, safety, latency, cost, fallback, and business
   outcome against baseline;
9. record general-availability decision and owner.

Rollback changes only the product flag or logical alias/route to the previous
known-good digest. Do not delete CRDs, workflows, datasets, model artifacts, or
usage evidence during an incident rollback.

## Definition of platform ready

The multi-product platform is ready only when all of the following are true:

- Kora and DevAI clients have no production provider/MCP/Agent Card bypass;
- each product request is authenticated, scoped, budgeted, and traceable;
- Registry resolves signed immutable bundles but cannot grant reachability;
- approved runtimes execute the same ADK identity/budget/tool contract;
- every provider/model alias and MCP server has recent end-to-end evidence;
- mutating tools are idempotent and destructive tools require approval;
- DevAI durable runs survive worker loss without duplicate side effects;
- sandbox negative tests prove tenant, secret, network, and cleanup isolation;
- action and attempt ledgers reconcile product entitlement and provider spend;
- models/agents/tools cannot become routable without their evaluation gate;
- current product knowledge comes from cited, tenant-filtered MCP/RAG resources;
- any fine-tuned model has governed data lineage, isolated training, shadow/
  canary evidence, and a tested alias rollback;
- the readiness dashboard reports real authenticated outcomes, not only
  configuration status.

Until then, describe readiness per capability: Kora private model/A2A routes
are operational; public MCP, shared provider routing, generic dynamic agents,
production Temporal durability, and model training remain separate gated
workstreams.
