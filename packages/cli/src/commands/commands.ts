import { Argument, Flag, GlobalFlag } from "effect/unstable/cli"
import { Schema } from "effect"
import { Spec } from "../framework/spec"
import { Updater } from "../services/updater"

export const PrintLogs = GlobalFlag.setting("print-logs")({
  flag: Flag.boolean("print-logs").pipe(
    Flag.withDescription("Print logs to stderr (server logs require --standalone)"),
    Flag.withDefault(false),
  ),
})

declare const OPENCODE_CLI_NAME: string | undefined

const ServerParams = {
  standalone: Flag.boolean("standalone").pipe(
    Flag.withDescription("Run with a private server instead of the background service"),
    Flag.withDefault(false),
  ),
  server: Flag.string("server").pipe(
    Flag.withDescription("Connect to a server URL instead of the background service"),
    Flag.optional,
  ),
}

const PermissionParams = {
  auto: Flag.boolean("auto").pipe(
    Flag.withDescription("Auto-approve permissions that are not explicitly denied"),
    Flag.withDefault(false),
  ),
  yolo: Flag.boolean("yolo").pipe(Flag.withDefault(false), Flag.withHidden),
  dangerouslySkipPermissions: Flag.boolean("dangerously-skip-permissions").pipe(
    Flag.withDefault(false),
    Flag.withHidden,
  ),
}

const Root = Spec.make(typeof OPENCODE_CLI_NAME === "string" ? OPENCODE_CLI_NAME : "opencode", {
  description: "OpenCode command line interface",
  params: {
    ...ServerParams,
    ...PermissionParams,
    directory: Argument.string("directory").pipe(
      Argument.withDescription("Directory to start OpenCode in"),
      Argument.optional,
    ),
    continue: Flag.boolean("continue").pipe(
      Flag.withAlias("c"),
      Flag.withDescription("Continue the last session"),
      Flag.withDefault(false),
    ),
    session: Flag.string("session").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("Session ID to continue"),
      Flag.optional,
    ),
    prompt: Flag.string("prompt").pipe(Flag.withDescription("Prompt to use"), Flag.optional),
    model: Flag.string("model").pipe(
      Flag.withAlias("m"),
      Flag.withDescription("Model to use in the format provider/model#variant"),
      Flag.optional,
    ),
  },
  commands: [
    Spec.make("upgrade", {
      description: "Upgrade OpenCode to the latest or a specific version",
      aliases: ["update"],
      params: {
        target: Argument.string("target").pipe(
          Argument.withDescription("Version to upgrade to (with or without a leading v)"),
          Argument.optional,
        ),
        method: Flag.choice("method", Updater.methods).pipe(
          Flag.withAlias("m"),
          Flag.withDescription("Installation method to use"),
          Flag.optional,
        ),
      },
    }),
    Spec.make("uninstall", {
      description: "Uninstall OpenCode and remove all related files",
      params: {
        keepConfig: Flag.boolean("keep-config").pipe(
          Flag.withAlias("c"),
          Flag.withDescription("Keep configuration files"),
          Flag.withDefault(false),
        ),
        keepData: Flag.boolean("keep-data").pipe(
          Flag.withAlias("d"),
          Flag.withDescription("Keep session data and snapshots"),
          Flag.withDefault(false),
        ),
        dryRun: Flag.boolean("dry-run").pipe(
          Flag.withDescription("Show what would be removed without removing"),
          Flag.withDefault(false),
        ),
        force: Flag.boolean("force").pipe(
          Flag.withAlias("f"),
          Flag.withDescription("Skip confirmation prompts"),
          Flag.withDefault(false),
        ),
      },
    }),
    Spec.make("acp", { description: "Start an Agent Client Protocol server" }),
    Spec.make("api", {
      description: "Make a request to the running server",
      params: {
        ...ServerParams,
        request: Argument.string("operation | method path").pipe(
          Argument.withDescription("OpenAPI operation ID, or an HTTP method followed by a path"),
          Argument.variadic({ min: 1, max: 2 }),
        ),
        data: Flag.string("data").pipe(Flag.withAlias("d"), Flag.withDescription("Request body"), Flag.optional),
        header: Flag.string("header").pipe(
          Flag.withAlias("H"),
          Flag.withDescription("Request header in name:value form"),
          Flag.atMost(100),
        ),
        param: Flag.keyValuePair("param").pipe(Flag.withDescription("OpenAPI path or query parameter"), Flag.optional),
      },
    }),
    Spec.make("debug", {
      description: "Debugging and troubleshooting tools",
      commands: [
        Spec.make("agents", { description: "List all agents" }),
        Spec.make("config", { description: "List configuration sources" }),
        Spec.make("paths", {
          description: "Show global paths (data, config, cache, state)",
          params: {
            name: Argument.choice("name", [
              "db",
              "home",
              "data",
              "config",
              "cache",
              "state",
              "tmp",
              "bin",
              "log",
              "repos",
            ]).pipe(
              Argument.withDescription("Print only one path: db, home, data, config, cache, state, tmp, bin, log, repos"),
              Argument.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("auth", {
      description: "manage AI providers and credentials",
      commands: [
        Spec.make("list", {
          description: "list providers and credentials",
          params: {
            ...ServerParams,
            format: Flag.choice("format", ["default", "json"]).pipe(
              Flag.withDescription("Output format"),
              Flag.withDefault("default"),
            ),
          },
        }),
        Spec.make("login", {
          description: "log in to a provider",
          params: {
            ...ServerParams,
            target: Argument.string("target").pipe(
              Argument.withDescription("Integration ID, name, or well-known provider URL"),
              Argument.optional,
            ),
            method: Flag.string("method").pipe(Flag.withDescription("Authentication method ID"), Flag.optional),
          },
        }),
        Spec.make("logout", {
          description: "log out of a saved account",
          params: {
            ...ServerParams,
            target: Argument.string("target").pipe(
              Argument.withDescription("Integration ID or name"),
              Argument.optional,
            ),
            credential: Argument.string("credential").pipe(
              Argument.withDescription("Credential ID or label (opens an account picker when omitted)"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("switch", {
          description: "switch the active account for an integration",
          params: {
            ...ServerParams,
            target: Argument.string("target").pipe(
              Argument.withDescription("Integration ID or name"),
              Argument.optional,
            ),
            credential: Argument.string("credential").pipe(
              Argument.withDescription("Credential ID or label (opens an account picker when omitted)"),
              Argument.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("mcp", {
      description: "Manage MCP (Model Context Protocol) servers",
      commands: [
        Spec.make("list", { description: "List configured MCP servers and their status" }),
        Spec.make("add", {
          description: "Add an MCP server to your configuration",
          params: {
            name: Argument.string("name").pipe(Argument.withDescription("Name of the MCP server")),
            command: Argument.string("command").pipe(
              Argument.withDescription("Command and arguments for a local server, passed after --"),
              Argument.variadic({ min: 0 }),
            ),
            url: Flag.string("url").pipe(Flag.withDescription("URL for a remote MCP server"), Flag.optional),
            header: Flag.keyValuePair("header").pipe(
              Flag.withDescription("HTTP header for a remote server, as name=value"),
              Flag.optional,
            ),
            env: Flag.keyValuePair("env").pipe(
              Flag.withDescription("Environment variable for a local server, as name=value"),
              Flag.optional,
            ),
            global: Flag.boolean("global").pipe(
              Flag.withDescription("Write to the global config instead of the project config"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("auth", {
          description: "Authenticate with an OAuth-capable remote MCP server",
          params: { name: Argument.string("name").pipe(Argument.withDescription("Name of the MCP server")) },
        }),
        Spec.make("logout", {
          description: "Remove stored OAuth credentials for an MCP server",
          params: { name: Argument.string("name").pipe(Argument.withDescription("Name of the MCP server")) },
        }),
      ],
    }),
    Spec.make("plugin", {
      description: "Manage plugins",
      commands: [
        Spec.make("list", {
          description: "List plugins",
          params: {
            builtin: Flag.boolean("builtin").pipe(
              Flag.withDescription("Include built-in server plugins"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("add", {
          description: "Install a plugin and add it to the global configuration",
          params: {
            package: Argument.string("package").pipe(Argument.withDescription("npm registry or Git package specifier")),
          },
        }),
        Spec.make("check", {
          description: "Check package plugins for updates",
          params: {
            target: Argument.string("target").pipe(
              Argument.withDescription("Configured package target"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("update", {
          description: "Update package plugins",
          params: {
            target: Argument.string("target").pipe(
              Argument.withDescription("Configured package target; omit to update all outdated plugins"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("remove", {
          description: "Remove a plugin from global configuration",
          params: {
            package: Argument.string("package").pipe(Argument.withDescription("configured package specifier")),
          },
        }),
      ],
    }),
    Spec.make("models", {
      description: "List all available models",
      params: ServerParams,
    }),
    Spec.make("stats", {
      description: "Show shareable usage statistics",
      params: {
        ...ServerParams,
        days: Flag.integer("days").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
          Flag.withDescription("Show the last N days; 0 means today"),
          Flag.optional,
        ),
        year: Flag.integer("year").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1970, maximum: 9_999 }))),
          Flag.withDescription("Show a calendar year"),
          Flag.optional,
        ),
        all: Flag.boolean("all").pipe(Flag.withDescription("Show lifetime statistics"), Flag.withDefault(false)),
        project: Flag.string("project").pipe(
          Flag.withDescription('Filter by project ID, or use "." for the current project'),
          Flag.optional,
        ),
        models: Flag.boolean("models").pipe(Flag.withDescription("Show model usage"), Flag.withDefault(false)),
        tools: Flag.boolean("tools").pipe(Flag.withDescription("Show tool reliability"), Flag.withDefault(false)),
        cost: Flag.boolean("cost").pipe(Flag.withDescription("Show cost and token details"), Flag.withDefault(false)),
        full: Flag.boolean("full").pipe(Flag.withDescription("Show every detailed section"), Flag.withDefault(false)),
        limit: Flag.integer("limit").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
          Flag.withDescription("Number of rows in detailed sections"),
          Flag.withDefault(5),
        ),
        json: Flag.boolean("json").pipe(Flag.withDescription("Output statistics as JSON"), Flag.withDefault(false)),
      },
    }),
    Spec.make("mini", {
      description: "Start the minimal interactive interface",
      params: {
        ...ServerParams,
        continue: Flag.boolean("continue").pipe(
          Flag.withAlias("c"),
          Flag.withDescription("Continue the last session"),
          Flag.withDefault(false),
        ),
        session: Flag.string("session").pipe(
          Flag.withAlias("s"),
          Flag.withDescription("Session ID to continue"),
          Flag.optional,
        ),
        fork: Flag.boolean("fork").pipe(
          Flag.withDescription("Fork the session when continuing"),
          Flag.withDefault(false),
        ),
        replay: Flag.boolean("replay").pipe(
          Flag.withDescription("Restore session history on resume and resize (disable with --no-replay)"),
          Flag.optional,
        ),
        replayLimit: Flag.integer("replay-limit").pipe(
          Flag.withDescription("Limit replay to the newest N messages (default: 200)"),
          Flag.optional,
        ),
        model: Flag.string("model").pipe(
          Flag.withAlias("m"),
          Flag.withDescription("Model to use in the format provider/model"),
          Flag.optional,
        ),
        agent: Flag.string("agent").pipe(Flag.withDescription("Agent to use"), Flag.optional),
        prompt: Flag.string("prompt").pipe(Flag.withDescription("Prompt to use"), Flag.optional),
        demo: Flag.boolean("demo").pipe(Flag.withDefault(false), Flag.withHidden),
      },
    }),
    Spec.make("run", {
      description: "Run OpenCode with a message",
      params: {
        ...ServerParams,
        message: Argument.string("message").pipe(
          Argument.withDescription("Message to send"),
          Argument.variadic({ min: 0 }),
        ),
        continue: Flag.boolean("continue").pipe(
          Flag.withAlias("c"),
          Flag.withDescription("Continue the last session"),
          Flag.withDefault(false),
        ),
        session: Flag.string("session").pipe(
          Flag.withAlias("s"),
          Flag.withDescription("Session ID to continue"),
          Flag.optional,
        ),
        fork: Flag.boolean("fork").pipe(
          Flag.withDescription("Fork the session before continuing"),
          Flag.withDefault(false),
        ),
        model: Flag.string("model").pipe(
          Flag.withAlias("m"),
          Flag.withDescription("Model to use in the format provider/model#variant"),
          Flag.optional,
        ),
        agent: Flag.string("agent").pipe(Flag.withDescription("Agent to use"), Flag.optional),
        format: Flag.choice("format", ["default", "json"]).pipe(
          Flag.withDescription("Output format"),
          Flag.withDefault("default"),
        ),
        file: Flag.string("file").pipe(
          Flag.withAlias("f"),
          Flag.withDescription("File to attach to the message"),
          Flag.atMost(100),
        ),
        title: Flag.string("title").pipe(Flag.withDescription("Session title"), Flag.optional),
        thinking: Flag.boolean("thinking").pipe(Flag.withDescription("Show thinking blocks"), Flag.withDefault(false)),
        ...PermissionParams,
      },
    }),
    Spec.make("session", {
      description: "Manage sessions",
      commands: [
        Spec.make("list", {
          description: "List top-level sessions in the current project, newest first",
          params: {
            ...ServerParams,
            maxCount: Flag.integer("max-count").pipe(
              Flag.withAlias("n"),
              Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
              Flag.withDescription("Limit to N most recent sessions (default: 100)"),
              Flag.optional,
            ),
            format: Flag.choice("format", ["table", "json"]).pipe(
              Flag.withDescription("Output format"),
              Flag.withDefault("table"),
            ),
          },
        }),
        Spec.make("delete", {
          description: "Delete a session and its child sessions",
          params: {
            ...ServerParams,
            sessionID: Argument.string("sessionID").pipe(Argument.withDescription("Session ID to delete")),
          },
        }),
        Spec.make("export", {
          description: "Export session data as JSON",
          params: {
            ...ServerParams,
            session: Argument.string("session").pipe(
              Argument.withDescription("Session ID to export"),
              Argument.optional,
            ),
            sanitize: Flag.boolean("sanitize").pipe(
              Flag.withDescription("Redact sensitive transcript and file data"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("import", {
          description: "Import session data from a JSON file or URL",
          params: {
            ...ServerParams,
            file: Argument.string("file").pipe(Argument.withDescription("JSON file or URL to import")),
            directory: Flag.string("directory").pipe(
              Flag.withDescription("Directory in which to import the session"),
              Flag.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("service", {
      description: "Manage the background server",
      commands: [
        Spec.make("start", { description: "Start the background server" }),
        Spec.make("restart", { description: "Restart the background server" }),
        Spec.make("status", { description: "Show background server status" }),
        Spec.make("stop", { description: "Stop the background server" }),
        Spec.make("get", {
          description: "Get service configuration",
          params: {
            key: Argument.string("key").pipe(Argument.withDescription("Service setting or env"), Argument.optional),
            name: Argument.string("name").pipe(
              Argument.withDescription("Environment variable name"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("set", {
          description: "Set service configuration",
          params: {
            key: Argument.string("key").pipe(Argument.withDescription("Service setting or env")),
            value: Argument.string("value").pipe(
              Argument.withDescription("Setting value or environment variable name"),
            ),
            nestedValue: Argument.string("env-value").pipe(
              Argument.withDescription("Environment variable value"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("unset", {
          description: "Unset service configuration",
          params: {
            key: Argument.string("key").pipe(Argument.withDescription("Service setting or env")),
            name: Argument.string("name").pipe(
              Argument.withDescription("Environment variable name"),
              Argument.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("pair", {
      description: "Show server pairing information",
      params: {
        url: Flag.string("url").pipe(
          Flag.withDescription("Advertise an external HTTP(S) server URL in the pairing QR code"),
          Flag.mapTryCatch(
            (value) => {
              const url = new URL(value)
              if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
                throw new Error("Invalid pairing URL")
              return url.href.replace(/\/+$/, "")
            },
            () => "Expected an HTTP(S) server URL without credentials, query parameters, or a fragment",
          ),
          Flag.optional,
        ),
      },
    }),
    Spec.make("serve", {
      description: "Start the v2 API and web server",
      params: {
        hostname: Flag.string("hostname").pipe(Flag.optional),
        port: Flag.integer("port").pipe(Flag.optional),
        cors: Flag.string("cors").pipe(
          Flag.withSchema(Schema.NonEmptyString),
          Flag.withDescription("Additional allowed CORS origin (repeat for multiple origins)"),
          Flag.atLeast(0),
        ),
        service: Flag.boolean("service").pipe(Flag.withDefault(false)),
        stdio: Flag.boolean("stdio").pipe(Flag.withDefault(false)),
      },
    }),
  ],
})

export const Commands = Root
