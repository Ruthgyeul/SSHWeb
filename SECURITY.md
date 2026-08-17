# Security policy

## Supported versions

SSHWeb is maintained on the `main` branch. Security fixes are applied to the
latest revision; older revisions do not receive backports.

## Reporting a vulnerability

Please report suspected vulnerabilities through GitHub's **private security
advisory** feature rather than a public issue. Include the affected revision,
reproduction steps, impact, and any suggested mitigation you have.

Do not include real SSH credentials, private keys, access tokens, hostnames, or
personal data in a report. Use disposable test infrastructure and redact logs
and screenshots.

Maintainers should acknowledge a report within seven days. Disclosure timing
will be coordinated with the reporter after the issue has been reproduced and a
fix is available. If the report is not a vulnerability, maintainers will explain
why and may suggest the appropriate public issue template.

## Deployment responsibility

SSHWeb connects browsers to SSH targets selected by users. Operators are
responsible for configuring the relay's access token, allowed origins, allowed
hosts, private-network blocking, connection and transfer limits, TLS
termination, and logging policy for their threat model. Review `.env.example`
before exposing a deployment to an untrusted network; defaults intended for
local evaluation may not be appropriate for a public relay.

Never commit deployment secrets or identity. Store deployment-specific values
in `.env.local` or the hosting platform's secret manager.
