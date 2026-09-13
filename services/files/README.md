# Public Files

Each environment has one R2 bucket, a Worker, and a `/files/*` route on its domain.

| Environment | Bucket and Worker           | Public URL                       |
| ----------- | --------------------------- | -------------------------------- |
| Development | `opencode-dev-files`        | `https://dev.opencode.ai/files/` |
| Production  | `opencode-production-files` | `https://opencode.ai/files/`     |

The Worker removes `/files/` and URL-decodes the remaining path to obtain the R2
object key. For example:

```text
R2 key: releases/1.0.0/opencode-linux-x64.tar.gz
URL:    https://opencode.ai/files/releases/1.0.0/opencode-linux-x64.tar.gz

R2 key: videos/demo.mp4
URL:    https://opencode.ai/files/videos/demo.mp4
```

## Deployment

Wrangler bundles and deploys the Worker, its R2 binding, and its path route.
`wrangler.jsonc` defines the `dev` and `production` environments. Their routes
use the existing proxied stage hostnames and take precedence over broader website
routes.

```bash
bun typecheck
bun run build
bun run deploy --env dev
bun run deploy --env production
```

The existing buckets are reused. For a fresh environment, create its bucket once
with `bunx wrangler r2 bucket create opencode-<stage>-files` and add the matching
environment to `wrangler.jsonc`.

`.github/workflows/deploy-files.yml` deploys development on every push to `dev`
and production on every push to `v2`, using the existing
`CLOUDFLARE_API_TOKEN` GitHub secret. The token needs Workers Scripts and Workers
Routes write permissions, plus zone read access. Creating buckets and uploading
objects also requires R2 write access.

## Uploading

Upload through the R2 dashboard or its S3-compatible API using bucket-scoped
credentials. Store objects without a `files/` prefix. The public Worker accepts
only `GET`, `HEAD`, and CORS `OPTIONS`; upload access remains with authenticated
R2 clients. There is no bucket listing or directory index.

Set HTTP metadata when uploading:

- `Content-Type`: the actual media type, such as `video/mp4`, `image/png`, or
  `application/gzip`. Missing types default to `application/octet-stream`.
- `Content-Disposition`: use `attachment; filename="..."` when a file should
  download rather than display inline.
- `Cache-Control`: defaults to `public, max-age=3600` (one hour). Use
  `public, max-age=31536000, immutable` for versioned/content-addressed files,
  and a short TTL or `no-store` for mutable pointers such as `latest.json`.

The Worker preserves the object's HTTP metadata, returns ETag and Last-Modified
validators, supports conditional GET/HEAD, and streams single byte ranges for
video seeking and download resumption, including If-Range. Unsupported or
malformed range formats fall back to a full response. Public CORS allows these
files to be consumed from other origins.

## Release Binaries

Each package owns its publishing destinations. `packages/cli/script/publish.ts`
publishes npm packages, Cloudflare archives, and AUR releases.
`packages/desktop/scripts/publish.ts` publishes GitHub release assets, finalizes
desktop manifests, uploads to Cloudflare, and registers its update artifacts.
The root release script invokes these package publishers.

Both publishers upload signed/packaged outputs to the production bucket for
every release channel:

```text
R2 key: bin/0.0.0-dev-123/opencode-linux-x64.tar.gz
URL:    https://opencode.ai/files/bin/0.0.0-dev-123/opencode-linux-x64.tar.gz

R2 key: bin/2.0.0/opencode-desktop-mac-arm64.dmg
URL:    https://opencode.ai/files/bin/2.0.0/opencode-desktop-mac-arm64.dmg
```

CLI and Node CLI archives contain the standalone executable at their root, with
execute permissions restored after GitHub artifact downloads. Linux uses
`.tar.gz`; macOS and Windows use `.zip`. Desktop uploads retain their GitHub
release filenames, including blockmaps and `.app.tar.gz` bundles.

The package publishers use the shared `UpdateArtifact.upload` helper with the
existing GitHub `CLOUDFLARE_API_TOKEN` secret and R2 object write access. It derives
S3 credentials from the verified token, streams uploads, and sets the content
type, download filename, and immutable cache headers.

The publishers register `cli`, `cli-node` (when built), and `desktop` (when
released) with distribution `opencode`. Each record is published only after all
of its files have uploaded successfully.
Every `metadata.files` entry contains the direct CDN `url`, SHA-256 checksum,
and byte size. Desktop `metadata.manifests` also use those CDN URLs and retain
the original SHA-512 and blockmap metadata.

For local verification, each package publisher accepts `--dry-run` with
`OPENCODE_VERSION` and `OPENCODE_CHANNEL` matching the build. CLI reads its own
`dist/` directory (or `OPENCODE_CLI_DIST`). Desktop reads `OPENCODE_DESKTOP_DIST`;
its dry run expects already-finalized manifests in `RUNNER_TEMP`.

## Caching

Complete GET responses up to 512 MiB are cached through the Workers Cache API
at the serving Cloudflare location, subject to object Cache-Control. Cached
complete objects can also satisfy range requests. Cold range requests stream
only the requested bytes from R2 and do not populate the cache. Larger objects
stream from R2. This cache does not use Tiered Cache.

Query strings are retained in cache keys but do not change the R2 key. Cookies
and authorization do not affect public file contents. Replacing/deleting an R2
object does not purge an already-cached response: use versioned keys, wait for
the TTL, or purge the public URL through Cloudflare. Request `Cache-Control:
no-cache` bypasses the cache for revalidation.

## Verification

After uploading an object, check its full response, metadata, and byte ranges:

```bash
curl -I https://opencode.ai/files/videos/demo.mp4
curl --fail -H 'Range: bytes=0-31' -D - \
  https://opencode.ai/files/videos/demo.mp4 -o /dev/null
```

Expect `200` for HEAD and `206` with `Content-Range` for the range request. A
missing key returns `404`, unsupported methods return `405`, and matching
If-None-Match/If-Modified-Since requests return `304`.
