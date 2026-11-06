# Directus backport catalog

YAML in this folder is the registry. The CLI and the Studio extension read a
local copy at runtime. **Check for updates** refreshes that copy from
[domdus/directus-backport](https://github.com/domdus/directus-backport) without
rebuilding. `advisories.yml` is the index. Patch blobs live under `patches/<GHSA>/`
only after a fix has been ported onto a pinned Directus build: a 12.x fix, or a
10.x/11.x fix that an older pin never received (`targets.yml`
for 11.17.4, `10.13.4.yml` for 10.13.4, `9.26.0.yml` for 9.26.0). New GHSAs come
from
[Directus security advisories](https://github.com/directus/directus/security).

Statuses:

| status | meaning |
|---|---|
| `already-fixed` | This Directus line already contains the fix |
| `needs-port` | Still open; no patch in this repo yet |
| `experimental` | Patch exists; not yet proven on a real install of this version |
| `stable` | Reproduced on the stock pin, blocked once patched, legitimate use unchanged |
| `wont-port` | Needs a 12.x refactor; use config/WAF or upgrade |

`port.status` is the default. `port.pins` overrides it per Directus version, so a
port can be `stable` on 11.17.4 and `experimental` on 9.26.0.

[VERIFICATION.md](VERIFICATION.md) records how each port was proven per version.

`manifest.json` and `manifest.sig` sign every file here. Any change needs a new
signature, or hosts refuse the catalog.

See [CONTRIBUTING.md](../CONTRIBUTING.md).
