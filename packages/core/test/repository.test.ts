import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { Repository } from "@opencode-ai/core/repository"

describe("Repository", () => {
  test("parses github shorthand and builds an explicit-root cache path", () => {
    const reference = Repository.parseRemote("owner/repo")

    expect(reference).toMatchObject({
      host: "github.com",
      path: "owner/repo",
      segments: ["owner", "repo"],
      owner: "owner",
      repo: "repo",
      remote: "https://github.com/owner/repo.git",
      label: "owner/repo",
    })
    expect(Repository.cachePath("/cache", reference)).toBe(path.join("/cache", "github.com", "owner", "repo"))
    expect(Repository.cachePath("/cache", reference, "main")).toBe(
      path.join("/cache", "github.com", "owner", "repo@main"),
    )
    expect(Repository.cachePath("/cache", reference, "feature/x")).toBe(
      path.join("/cache", "github.com", "owner", "repo@feature%2Fx"),
    )
    expect(Repository.cacheIdentity(reference)).toBe("github.com/owner/repo")
  })

  test("parses host path and scp remote references", () => {
    expect(Repository.parseRemote("gitlab.com/group/repo")).toMatchObject({
      host: "gitlab.com",
      path: "group/repo",
      remote: "https://gitlab.com/group/repo.git",
      label: "gitlab.com/group/repo",
    })
    expect(Repository.parseRemote("git@github.com:owner/repo.git")).toMatchObject({
      host: "github.com",
      path: "owner/repo",
      remote: "git@github.com:owner/repo.git",
      label: "owner/repo",
    })
  })

  test("keeps local file repositories distinct from remote repositories", () => {
    const localPath = path.resolve("repo.git")
    const reference = Repository.parse(pathToFileURL(localPath).href)

    expect(reference).toMatchObject({ host: "file", protocol: "file:", label: localPath })
    expect(reference && Repository.isFile(reference)).toBe(true)
    expect(reference && Repository.isRemote(reference)).toBe(false)
    expect(() => Repository.parseRemote(pathToFileURL(localPath).href)).toThrow(
      Repository.UnsupportedLocalRepositoryError,
    )
  })

  test("rejects unsafe remote references and branches with typed errors", () => {
    expect(() => Repository.parseRemote("not-a-repo")).toThrow(Repository.InvalidReferenceError)
    expect(() => Repository.parseRemote("git@github.com:../../../etc/passwd")).toThrow(Repository.InvalidReferenceError)
    ;["feature/docs.v1", "topic./child", "topic.LOCK"].forEach((branch) =>
      expect(() => Repository.validateBranch(branch)).not.toThrow(),
    )
    ;[
      "-bad",
      "bad..branch",
      "bad branch",
      "/topic",
      "topic/",
      "topic//child",
      ".topic",
      "topic/.child",
      "topic.",
      "topic.lock",
      "topic.lock/child",
    ].forEach((branch) => expect(() => Repository.validateBranch(branch)).toThrow(Repository.InvalidBranchError))
  })

  test("compares cache identity independent of input spelling", () => {
    const shorthand = Repository.parseRemote("owner/repo")

    expect(Repository.same(shorthand, Repository.parseRemote("https://github.com/owner/repo.git"))).toBe(true)
    expect(Repository.same(shorthand, Repository.parseRemote("github.com/owner/repo"))).toBe(true)
  })
})
