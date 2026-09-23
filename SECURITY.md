# Security

This worker exists to keep one tenant's agents away from another's files, credentials and budget, so reports about isolation, credential handling or the cost cap get priority.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability.

Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). If that is not available to you, send the report through [clawhire.ai/contact](https://clawhire.ai/contact) and put "security report" in the first line.

Include the worker version (`GET /health` returns it), a minimal reproduction, and what an attacker gains. Expect an acknowledgement within a few business days.

## Scope

- In scope: the code in this repository. The adapter, tenant scoping, the token-broker client, the cost meter, the MCP tool proxy and the Docker image.
- Out of scope: the OpenClaw CLI itself (report to [openclaw/openclaw](https://github.com/openclaw/openclaw)), and the hosted ClawHire service (use the contact page above).

## Hardening notes for operators

- Set a long random `OPENCLAW_API_KEY`. Without one the worker refuses every request except `/health`; with one, every request is authenticated against it.
- Keep the worker on a private network or behind your control plane. It has no per-user authentication of its own.
- Mount `/data` on a volume with backups; all agent state lives there.
- Set `MONTHLY_COST_CAP_USD` and `COST_CAP_ENFORCE=true` before exposing it to real tenants.
