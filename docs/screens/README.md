# Screenshots

Captured on 2026-11-09 against the service running locally on PGlite, with three real repositories mirrored from
GitHub (`OpenVibers/OpenVibe.SDK`, `OpenVibers/OpenVibe.Contracts`, `OpenVibers/OpenVibe.Design`). The views and
clones in Insights are from actually loading these pages and running `git clone` against the local server, not
seeded numbers; stars are real (zero). The shared navbar and footer render from `openvibe-shared`; the theme is
pinned to `vibe` (dark) and `cloud` (light) in the capture because the Network theme endpoint is not reachable from
`127.0.0.1` in this environment.

Each page is captured at 390 px and 1280 px, dark and light:

- `home-*` — the hero, live numbers, trending, activity and the official rail.
- `explore-*` — search, filters and repository cards.
- `repository-*` — a repository header, Get it sheet and file tree (viewport).
- `file-*` — a README highlighted on the server with line links (viewport).
- `insights-*` — views, unique visitors, clones, stars and commits per week.

The check run asserted `document.documentElement.scrollWidth === window.innerWidth` at every capture (no sideways
scroll), and there are no page errors. The only console messages are the Network frame/theme CORS refusals described
above; on `git.openvibe.codes` it is a first-party origin.
