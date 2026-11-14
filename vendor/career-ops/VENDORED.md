# Vendored: career-ops providers

- Upstream: https://github.com/career-ops-hq/career-ops (also published as santifer/career-ops)
- Licence: MIT (see LICENSE)
- Commit: 115bc9873e3d43e23883f3c8f16436617facc62c (tag `career-ops-v1.38.0`), reviewed
  2026-11-10.
- Taken: `providers/` and the six helper modules they import, nothing else.
- Left out: `providers/local-parser.mjs` (runs a configured shell command), and the 53 job
  aggregators and listing sites (remoteok, getro, himalayas, computrabajo, magneto, ...): they
  list other companies' jobs, so a link to one says nothing about a company's own board. Leave
  them out on upgrade.
- Not modified. Job Signal drives these through `ats/runner.mjs`, in a separate
  process with no API keys in its environment.

Review on upgrade: copy the new upstream files over these, read the diff, then commit.
Things to check in the diff: new `child_process`/`spawn`, file writes, hosts outside
the provider's own ATS, and changes to `_ip-guard.mjs`, `_http.mjs` and `_registry.mjs`.

Note: upstream's scanner (`scan.mjs`) has no JSON output for tracked companies and its
`scan-ats-full.mjs --json` is a reverse sweep of public ATS directories, so neither is
vendored; the runner uses the providers layer directly, as both scanners do.
