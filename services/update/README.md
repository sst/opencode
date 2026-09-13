# OpenCode Update

The update Worker serves all selected artifacts for a channel.

```sh
curl 'https://opencode.ai/update/api/latest'
curl 'https://opencode.ai/update/api/latest/cli'
curl 'https://opencode.ai/update/api/latest/cli/npm'
```

The same Worker also serves the original `https://update.opencode.ai` hostname without
the `/update` prefix. Admin forms, pagination, and redirects preserve the request's mount.

## Desktop update feeds

Electron updater manifests are available at `/api/<channel>/desktop/<distribution>/<filename>`:

```sh
curl 'https://opencode.ai/update/api/beta/desktop/opencode/latest-mac.yml'
```

Use `latest.yml` for Windows, `latest-mac.yml` for macOS, `latest-linux.yml` for Linux x64,
and `latest-linux-arm64.yml` for Linux ARM64. The distribution selects the stored download
URLs (`opencode` or `github`). Each manifest includes the selected artifact's version,
file URLs, SHA-512 checksums, sizes, and release date. Existing minimum-version selection
and `current`/User-Agent handling also apply to these feeds.

## Channel rollouts

Set each channel's rollout duration in hours on the admin page. All channels default
to `0` (immediate); fractional hours are supported. For example, `6` makes a release
available to roughly half of IPs after three hours and all IPs after six hours.

Eligibility uses the original publication time (`time_created`) and a SHA-256 hash
of the channel and Cloudflare's `CF-Connecting-IP`. Each IP keeps the same rollout
position across releases in that channel. Requests without this header wait for
the full duration. The retired `next` channel is not configurable; `/api/next`
remains a compatibility alias for `/api/beta`, including its rollout settings.

Until the active release is eligible, callers receive the newest eligible artifact
published before it, for the same name and distribution. This also handles overlapping
rollouts. Earlier inactive releases can be fallbacks, including manually deactivated
releases; releases newer than the active release cannot. If no eligible artifact
exists, it is omitted from listings and individual artifact requests return 404.

Minimum releases bypass rollout for clients that need them, and identified clients
are not sent a fallback below their configured minimum. Rollout applies to all JSON
endpoints and desktop manifests. Responses, including unavailable artifacts, are not cached.

Duration changes apply immediately to existing releases. Manual activation uses the
original publication time too; set the duration to `0` to make it immediate.
Apply the `0004_channel_rollout.sql` migration before deploying.

## Minimum releases

Each channel/name/distribution can mark one retained artifact as `minimum`, independently
of its `active` artifact. Set or clear it from the admin page. Publishing a new active
release preserves the minimum marker.

Clients send their running version as `?current=<version>` and use the CLI's default
`User-Agent: opencode/<channel>/<version>/cli`. When `current` is absent, the service
parses that User-Agent or the older `opencode/<version>` format.
The caller's channel comes from the default User-Agent, or from a preview version
such as `0.0.0-beta-18955` when that channel is absent. If an identified caller channel
differs from the requested channel, the service serves the active release without
applying the minimum. Historical `next` and `beta` count as the same channel.
A caller below the minimum receives that exact
artifact; callers at or above it receive the active artifact. An unparseable caller
version receives the minimum. Requests with neither version source receive the active
artifact. All three public API paths apply the same selection and use `Cache-Control:
no-store` because responses can depend on the User-Agent.

Version comparison uses semver, normalizing preview run numbers to numeric prerelease
identifiers and historical `next` versions to `beta`. The retired `/api/next`
channel transparently resolves to `beta` for older clients.

Choose a minimum that older clients can install and that can itself consume the active
release. For the CLI package migration, retain a package-aware release published as
`@opencode-ai/cli` as the minimum before activating releases under `@opencode/cli`.

Both admin mounts must be protected by the same Cloudflare Access self-hosted application:

- Public hostname/path: `update.opencode.ai/admin*`
- Public hostname/path: `opencode.ai/update/admin*`
- Policy: allow the OpenCode team identity group

Configure Access before deploying the new Worker route. The Worker has `workers_dev`
and preview URLs disabled; it is exposed through its custom hostname and the `/update` routes.

## Request logging

Every request reaching the Worker emits an unsampled event at request start to the shared production
Cloudflare lake stream through the `EVENTS` Pipelines binding. Events use
`source: "update"`, `type: "request"`, an ISO `timestamp`, and a `payload` containing
the method, path, `useragent`, `ip` (from Cloudflare's `CF-Connecting-IP` header),
country, and Cloudflare colo. The path is normalized without `/update` so both mounts
share the existing analytics paths. Query strings, request bodies, cookies, and authorization
headers are not included. Response status and duration are not recorded.

Delivery runs in `waitUntil` without delaying the response. Delivery failures are
logged but do not fail requests or retry; this is not lossless audit logging.
Requests blocked before reaching the Worker are not recorded.

The stream ID in `wrangler.jsonc` comes from the `lake.stream` output of the
`anomalyco/platform/production` Pulumi stack. Update the binding if that stream is
replaced. The stream is shared across release channels because the update service
has a single public deployment.

## Publishing

The publish workflow also registers direct binary downloads with distribution
`opencode`, after uploading every file to the public files bucket:

```sh
curl 'https://opencode.ai/update/api/dev/cli/opencode'
curl 'https://opencode.ai/update/api/dev/cli-node/opencode'
curl 'https://opencode.ai/update/api/latest/desktop/opencode'
```

`metadata.files` maps each filename to its direct
`https://opencode.ai/files/bin/<version>/<filename>` URL, SHA-256 checksum, and
byte size. Desktop records additionally contain `metadata.manifests`, with
the CDN URLs and the original Electron update checksums. Existing `npm`,
`github`, and `aur` distributions are published independently.

GitHub Actions publishes artifacts through `POST https://opencode.ai/update/api/publish`
using a short-lived OIDC token with audience `https://update.opencode.ai`. The original
hostname and token audience remain supported. The Worker accepts only tokens signed by
GitHub for repository ID `975734319`, owner ID `66570915`, and `.github/workflows/publish.yml`
on configured publishing refs.

Apply migrations and deploy from this directory:

```sh
bun run db:migrate
bun run deploy
```
