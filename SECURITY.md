# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (current) | yes |
| < 0.1 | no |

## Reporting a vulnerability

Please report privately — do not open a public issue.

- On the forge: message the repository owner (`brett`) or open a private
  security advisory on GitHub (**Security → Advisories → Report a
  vulnerability**) for `QuxKit/billing-kit-mcp`.
- Include a reproduction, the version, and the impact you believe it has.

You will get an acknowledgement within 7 days. We follow **90-day coordinated
disclosure**: a fix or mitigation is targeted before publication, and the report
is credited unless you ask otherwise.

## Scope

In scope:

- The MCP server itself: tool input handling, anything that could make a tool
  return a wrong monetary value, protocol-frame corruption on stdout, and the
  bundling / release path (`dist/index.js`, the publish workflow).
- The discovery snapshots leaking anything beyond component *metadata*
  (names, descriptions, dependencies, install command).

Out of scope:

- Vulnerabilities in `@quxkit/billing-kit` itself — report them to that
  repository.
- Vulnerabilities in the MCP host (Claude Desktop, Claude Code, etc.).
- The server is a local stdio process spawned by a host; it does not listen on a
  socket and does not authenticate callers. Reports that assume a hostile MCP
  host are out of scope.
