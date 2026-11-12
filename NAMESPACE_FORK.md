# SigNoz namespace fork

This fork of [SigNoz](https://github.com/SigNoz/signoz) adds a global
**namespace switcher** to the SigNoz UI. Pick a namespace in the side nav and
the whole UI is scoped to `service.namespace = '<namespace>'`. Pick nothing
and SigNoz behaves exactly like upstream.

Only the frontend is changed. The image is the official `signoz/signoz`
release with its web UI replaced, so backend behaviour, storage and APIs are
upstream's.

## What gets scoped

| Area | How |
|---|---|
| Charts, explorers, dashboards panels, exports (query_range v3/v4/v5) | namespace added to every builder query filter |
| Services, top operations, exceptions | namespace added as a resource tag |
| Infra monitoring, metrics explorer, external APIs, queue overview | namespace added to the request filter |
| Autocomplete values | narrowed to the namespace |
| Opening a trace by id | refused unless one of its spans is in the namespace |
| Dashboards list | tag `namespace:<ns>`, or no `namespace` tag (shared) |
| Alert rules, firing alerts | label `namespace=<ns>`, or no label (shared) |
| Saved views | query contains `service.namespace = '<ns>'`, or no namespace (shared) |
| New dashboard / alert / saved view created while scoped | stamped with the namespace; a new alert's queries are also filtered to it |

Not scoped: PromQL and ClickHouse SQL panels, SQL dashboard variables, and
org-wide settings (notification channels, downtime schedules, pipelines).

Data must carry `service.namespace` (an OpenTelemetry resource attribute). An
OTel collector `resource` processor with `action: insert` can default it for
apps that don't set it.

## Code

| File | Purpose |
|---|---|
| `frontend/src/utils/namespaceScope.ts` | all scoping rules (axios request/response hooks) |
| `frontend/src/container/SideNav/NamespaceSelector/` | the side-nav dropdown |
| `frontend/src/api/index.ts`, `frontend/src/container/SideNav/SideNav.tsx` | ~10 lines wiring the two above in |
| `frontend/src/utils/__tests__/namespaceScope*.test.ts` | unit tests + endpoint coverage guard |
| `frontend/src/utils/namespaceScope.endpoints.json` | every API endpoint and how it is scoped |
| `.fork/` | base release, build script, Dockerfile |
| `.github/workflows/namespace-fork.yml` | upstream sync + image build |

## Staying on upstream

`.github/workflows/namespace-fork.yml` runs daily. When SigNoz publishes a
release it rebases this branch onto it, runs the tests and publishes
`ghcr.io/<owner>/signoz:<release>-ns`. A conflict or failing test stops the
run before anything is published.

The **endpoint coverage guard** fails when upstream adds or changes an API
endpoint, listing it, so a new page can't silently show every namespace's
data. To clear it, decide whether the endpoint returns telemetry, add a rule in
`namespaceScope.ts` if it does, then refresh the manifest:

```sh
cd frontend
UPDATE_SCOPE_MANIFEST=1 pnpm jest src/utils/__tests__/namespaceScopeCoverage
pnpm jest src/utils/__tests__/namespaceScope
```

### Manual rebase

```sh
git remote add upstream https://github.com/SigNoz/signoz.git
git fetch upstream --tags
git rebase --onto <new-tag> "$(cat .fork/base)" namespace-scope
echo <new-tag> > .fork/base && git commit -am "fork: rebase onto SigNoz <new-tag>"
```

## Build locally

```sh
.fork/build-frontend.sh
docker buildx build --platform linux/arm64 -f .fork/Dockerfile \
  --build-arg SIGNOZ_VERSION="$(cat .fork/base)" -t signoz-ns .
```

The image tag's SigNoz version and the backend version must match.
