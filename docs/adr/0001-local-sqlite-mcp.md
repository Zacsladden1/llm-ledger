# ADR 0001: Local SQLite + MCP as the product surface

- **Status:** Accepted
- **Date:** 2026-09-08

## Context

AI contractors juggle spend across OpenAI, Anthropic, OpenRouter, and others. Provider dashboards and CSV exports answer humans, not agents. A hosted FinOps SaaS would require uploading usage data and operating accounts/auth.

## Decision

Ship a **local SQLite ledger** with ingest adapters (CSV + provider cost/activity APIs) and expose query/budget operations as **MCP tools** over stdio.

## Consequences

**Positive**

- No third-party custody of spend data
- Works offline after ingest; single-file backup/restore
- Agents can sync and query without leaving the IDE
- Small ops surface for a solo/contractor maintainer

**Negative / tradeoffs**

- No multi-user shared ledger out of the box
- Sync requires privileged Management/Admin keys (documented, easy to misconfigure)
- Operators must back up `ledger.db` themselves
- Not a substitute for company-wide FinOps platforms

## Alternatives considered

1. **Hosted dashboard only** — loses agent composability and increases trust surface.
2. **Postgres by default** — better for teams, worse for “clone and run” local-first.
3. **LLM gateway that meters prompts** — different product; this repo deliberately does not proxy inference.
