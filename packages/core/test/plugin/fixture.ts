import { Agent } from "@opencode/core/agent"
import { AISDK } from "@opencode/core/aisdk"
import { Catalog } from "@opencode/core/catalog"
import { ProviderPolicy } from "@opencode/core/provider-policy"
import { Command } from "@opencode/core/command"
import { Config } from "@opencode/core/config"
import { Credential } from "@opencode/core/credential"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { AppProcess } from "@opencode/util/process"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { FileSystem } from "@opencode/core/filesystem"
import { FSUtil } from "@opencode/util/fs-util"
import { Form } from "@opencode/core/form"
import { Generate } from "@opencode/core/generate"
import { Integration } from "@opencode/core/integration"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { Npm } from "@opencode/util/npm"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Session } from "@opencode/core/session"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Permission } from "@opencode/core/permission"
import { Reference } from "@opencode/core/reference"
import { Rpc } from "@opencode/core/rpc"
import { Skill } from "@opencode/core/skill"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Tool } from "@opencode/core/tool"
import { Vcs } from "@opencode/core/vcs"
import { WebSearch } from "@opencode/core/websearch"
import { Worktree } from "@opencode/core/worktree"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"
import { emptyMcpLayer } from "../fixture/mcp"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: (name) => Effect.succeed({ directory: "", name }),
    resolve: (name) => Effect.succeed({ directory: "", name }),
    check: () => Effect.succeed(false),
    update: (name) => Effect.succeed({ directory: "", name }),
    which: () => Effect.undefined,
  }),
)

const generateLayer = Layer.succeed(Generate.Service, Generate.Service.of({ text: () => Effect.succeed("") }))

const permissionLayer = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "ask" }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    AppProcess.node,
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    Bus.node,
    Form.node,
    Generate.node,
    LayerNodePlatform.httpClient,
    Plugin.node,
    Agent.node,
    AISDK.node,
    Catalog.node,
    ProviderPolicy.node,
    Config.node,
    Command.node,
    Integration.node,
    KV.node,
    Mcp.node,
    Session.node,
    PersistentPty.node,
    LocationServiceMap.node,
    Permission.node,
    PluginHooks.node,
    Reference.node,
    Rpc.node,
    Skill.node,
    SkillDiscovery.node,
    Tool.node,
    Vcs.node,
    Watcher.node,
    WebSearch.node,
    Worktree.node,
  ]),
  [
    Location.node.replace(tempLocationLayer),
    Npm.node.replace(npmLayer),
    Config.node.replace(Config.testLayer()),
    Mcp.node.replace(emptyMcpLayer),
    Generate.node.replace(generateLayer),
    Permission.node.replace(permissionLayer),
  ],
)
