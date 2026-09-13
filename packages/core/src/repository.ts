import path from "path"
import { fileURLToPath } from "url"
import { Schema } from "effect"

type BaseReference = {
  readonly host: string
  readonly path: string
  readonly segments: string[]
  readonly owner?: string
  readonly repo: string
  readonly remote: string
  readonly label: string
}

export type RemoteReference = BaseReference & {
  readonly protocol?: string
}

export type FileReference = BaseReference & {
  readonly host: "file"
  readonly protocol: "file:"
}

export type Reference = RemoteReference | FileReference

export class InvalidReferenceError extends Schema.TaggedErrorClass<InvalidReferenceError>()(
  "RepositoryInvalidReferenceError",
  {
    repository: Schema.String,
    message: Schema.String,
  },
) {}

export class UnsupportedLocalRepositoryError extends Schema.TaggedErrorClass<UnsupportedLocalRepositoryError>()(
  "RepositoryUnsupportedLocalRepositoryError",
  {
    repository: Schema.String,
    message: Schema.String,
  },
) {}

export class InvalidBranchError extends Schema.TaggedErrorClass<InvalidBranchError>()("RepositoryInvalidBranchError", {
  branch: Schema.String,
  message: Schema.String,
}) {}

export type Error = InvalidReferenceError | UnsupportedLocalRepositoryError | InvalidBranchError

export function isError(error: unknown): error is Error {
  return (
    error instanceof InvalidReferenceError ||
    error instanceof UnsupportedLocalRepositoryError ||
    error instanceof InvalidBranchError
  )
}

export function parse(input: string): Reference | undefined {
  const cleaned = normalizeInput(input)
  if (!cleaned) return

  const githubPrefixed = cleaned.match(/^github:([^/\s]+)\/([^/\s]+)$/)
  if (githubPrefixed) return buildRemote({ host: "github.com", segments: [githubPrefixed[1], githubPrefixed[2]] })

  if (!cleaned.includes("://")) {
    const scp = cleaned.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/)
    if (scp) return buildRemote({ host: scp[1], segments: parts(scp[2]), remote: cleaned })

    const direct = parts(cleaned)
    if (direct.length >= 2 && hostLike(direct[0])) return buildRemote({ host: direct[0], segments: direct.slice(1) })
    if (direct.length === 2) return buildRemote({ host: "github.com", segments: direct })
  }

  try {
    const url = new URL(cleaned)
    if (url.protocol === "file:") return buildFile({ url, remote: cleaned })
    const segments = parts(url.pathname)
    return buildRemote({
      host: url.host,
      segments,
      remote: url.host === "github.com" ? githubRemote(segments.join("/")) : cleaned,
      protocol: url.protocol,
    })
  } catch {
    return
  }
}

export function parseRemote(input: string): RemoteReference {
  const reference = parse(input)
  if (!reference) {
    throw new InvalidReferenceError({
      repository: input,
      message: "Repository must be a git URL, host/path reference, or GitHub owner/repo shorthand",
    })
  }
  if (!isRemote(reference)) {
    throw new UnsupportedLocalRepositoryError({
      repository: input,
      message: "Local file repositories are not supported",
    })
  }
  return reference
}

export function validateBranch(branch: string): void {
  if (
    /^[A-Za-z0-9/_.-]+$/.test(branch) &&
    !branch.startsWith("-") &&
    !branch.includes("..") &&
    !branch.endsWith(".") &&
    branch
      .split("/")
      .every((component) => component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"))
  )
    return
  throw new InvalidBranchError({
    branch,
    message: "Branch must be a valid Git branch name using only alphanumeric characters, /, _, ., and -",
  })
}

export function isFile(reference: Reference): reference is FileReference {
  return reference.protocol === "file:"
}

export function isRemote(reference: Reference): reference is RemoteReference {
  return !isFile(reference)
}

/**
 * Checkouts are keyed by remote and branch: a branch-specific reference gets
 * its own directory so branchless refreshes can never move it. The branch is
 * percent-encoded because valid branch names may contain `/`.
 */
export function cachePath(root: string, reference: Reference, branch?: string): string {
  const base = path.join(root, ...reference.host.split(":"), ...reference.segments)
  return branch ? `${base}@${encodeURIComponent(branch)}` : base
}

export function cacheIdentity(reference: Reference): string {
  return `${reference.host}/${reference.path}`
}

export function same(left: Reference, right: Reference): boolean {
  return cacheIdentity(left) === cacheIdentity(right)
}

function normalizeInput(input: string) {
  return input
    .trim()
    .replace(/^git\+/, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "")
}

function trimGitSuffix(input: string) {
  return input.replace(/\.git$/, "")
}

function parts(input: string) {
  return input
    .split("/")
    .map((item) => trimGitSuffix(item.trim()))
    .filter(Boolean)
}

function safeHost(input: string) {
  return Boolean(input) && !input.startsWith("-") && !/[\s/\\]/.test(input)
}

function safeSegment(input: string) {
  return input !== "." && input !== ".." && !input.includes(":") && !/[\s/\\]/.test(input)
}

function hostLike(input: string) {
  return input.includes(".") || input.includes(":") || input === "localhost"
}

function withSlash(input: string) {
  return input.endsWith("/") ? input : `${input}/`
}

function githubRemote(pathname: string) {
  const base = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
  if (!base) return `https://github.com/${pathname}.git`
  return new URL(`${pathname}.git`, withSlash(base)).href
}

function buildRemote(input: { host: string; segments: string[]; remote?: string; protocol?: string }) {
  const segments = input.segments.map(trimGitSuffix).filter(Boolean)
  if (!safeHost(input.host) || !segments.length || segments.some((segment) => !safeSegment(segment))) return
  const repositoryPath = segments.join("/")
  const host = input.host.toLowerCase()
  return {
    host,
    path: repositoryPath,
    segments,
    owner: segments.length === 2 ? segments[0] : undefined,
    repo: segments[segments.length - 1],
    remote:
      input.remote ?? (host === "github.com" ? githubRemote(repositoryPath) : `https://${host}/${repositoryPath}.git`),
    label: host === "github.com" && segments.length === 2 ? repositoryPath : `${host}/${repositoryPath}`,
    protocol: input.protocol,
  } satisfies RemoteReference
}

function buildFile(input: { url: URL; remote: string }) {
  const filePath = path.normalize(fileURLToPath(input.url))
  const segments = filePath.split(/[\\/]+/).filter(Boolean)
  if (!segments.length) return
  return {
    host: "file",
    path: filePath,
    segments: segments.map((segment) => segment.replace(/:$/, "")),
    owner: undefined,
    repo: trimGitSuffix(segments[segments.length - 1]),
    remote: input.remote,
    label: filePath,
    protocol: "file:",
  } satisfies FileReference
}

export * as Repository from "./repository"
