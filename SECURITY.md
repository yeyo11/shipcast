# Security policy

## Supported versions

Shipcast has no release yet. Until 1.0, only the latest commit on `main` (and later the latest
release) receives fixes.

## Reporting a vulnerability

Please report privately through
[GitHub's security advisories](https://github.com/yeyo11/shipcast/security/advisories/new), not in a
public issue. Include what an attacker could do, the steps to reproduce it and the commit you tested.
You will get an answer within a week, and credit in the advisory if you want it.

## What Shipcast holds

Shipcast publishes on your behalf, so the tokens it is given are the sensitive part: GitHub, the AI
provider and every social network you connect. By design:

- **Tokens stay in `.env`** on the machine that runs the engine and are never committed, logged or
  sent to the AI provider.
- **The engine runs locally** and polls GitHub instead of receiving webhooks, so it opens no port;
  outside access, when needed, goes through Tailscale Serve on your tailnet.
- **Nothing is published outside its channel's mode**: `approval` and `manual` channels never post
  without you.
- **Use the narrowest scopes** each network offers; the GitHub tokens need read-only access to
  contents and metadata.
