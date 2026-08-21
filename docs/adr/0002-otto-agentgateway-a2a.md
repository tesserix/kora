# ADR 0002: Route Otto delegation through AgentGateway

Status: accepted

Date: 2026-08-20

## Context

Kora already authenticates mobile users with Firebase, builds user-scoped
nutrition context, enforces AI quota in Postgres, and sends model calls through
the private `kora-ai` AgentGateway. The separately deployed `kora-ai-agents`
runtime exposes reviewed A2A agents for nutrition coaching and meal planning,
but Kora had no supervisor client for them. Its Agent Cards advertised the
agent Service directly, and the mesh allowed Kora API to call that Service.

The required flow is:

```text
authenticated mobile user
  -> Kora API / Otto
  -> private kora-ai AgentGateway
  -> reviewed A2A agent
  -> the same AgentGateway
  -> selected model provider
```

The initial capacity assumption remains 10 Kora AI requests/second peak. A
delegated A2A run has a 20-second agent execution budget, a 23-second gateway
deadline, and a 24-second Kora deadline inside mobile's 25-second deadline. It
allows at most two model calls, 12,000 input tokens, and 2,000 output tokens.
The AI path retains its 99.9% monthly availability target. These are hard bounds
and a target, not measured production SLO evidence.

## Options considered

1. Let Otto call Agent Card URLs directly. This follows the registry's generic
   discovery example but bypasses Kora's gateway enforcement and makes a
   compromised or malformed card an SSRF/routing input.
2. Forward the Firebase login token through AgentGateway to an agent. This
   unnecessarily widens the end-user token audience and couples internal agents
   to mobile authentication.
3. Route a fixed, reviewed agent name through AgentGateway and let the gateway
   authenticate both sides. Kora retains user and quota authority while the
   gateway owns the service credential and route.

## Decision

Otto delegates only through the configured `kora-ai` AgentGateway origin.

- The Firebase token terminates at Kora API. Kora derives the user ID and builds
  context with user-scoped database queries. No login token, user ID header,
  tenant header, card URL, provider, or model is forwarded from mobile.
- A deterministic supervisor selector chooses only `nutrition-coach` or
  `meal-planner`. Arbitrary agent names and arbitrary URLs are rejected before
  network I/O.
- Kora sends JSON-RPC `message/send` to
  `/a2a/v1/{reviewed-agent}` using its existing AgentGateway client credential.
  When delegation is configured, an A2A failure is returned safely; Otto does
  not silently bypass the agent with a direct model call.
- AgentGateway validates the Kora client credential, rate-limits the A2A route,
  applies a 23-second deadline, and replaces the frontend credential with the
  separate agent-service credential from Secret Manager.
- Istio authorization and NetworkPolicy allow the agent Service only from the
  `agentgateway-system/kora-ai` workload identity. Kora API no longer has a
  direct network or mesh authorization path to the agent Service.
- The agent runtime remains tenant-fixed to `kora`, runs only reviewed ADK
  definitions, and calls `kora-auto` through the same AgentGateway for model
  execution. It holds no provider credential.
- The A2A response includes bounded usage metadata. Kora records it in the
  existing authenticated user's AI usage ledger; AgentGateway telemetry remains
  operational evidence rather than an entitlement ledger.
- Structured meal-plan output is validated and rendered to readable text before
  it reaches the existing mobile coach UI. Kora's post-generation protective
  guardrail and server-derived citations still apply.

## Failure and retry behavior

Kora performs one A2A attempt. Cancellation and deadlines propagate through
Kora, AgentGateway, and the agent runtime. The gateway does not retry the A2A
wrapper; any model-provider fallback occurs inside the existing model route.
HTTP errors, JSON-RPC errors, non-completed runs, oversized responses, missing
text artifacts, and malformed meal plans fail closed without returning upstream
response bodies or secret-bearing details.

Quota is checked before delegation. A failed or timed-out delegated run consumes
the reservation and records an error/timeout usage outcome, matching existing
provider-call behavior. Thread persistence remains best-effort after a safe
answer is available.

## Consequences

The gateway becomes a required dependency for Otto in production, as it already
is for Kora's other model capabilities. Agent Cards now advertise the gateway
address, so conforming internal consumers also remain on the governed path.
Adding a new Otto-selectable agent requires a reviewed agent definition and an
explicit selector change; registry publication alone cannot make arbitrary code
reachable from authenticated Kora traffic.
