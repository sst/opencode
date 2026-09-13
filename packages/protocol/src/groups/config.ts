import { Config } from "@opencode/schema/config"
import { ConfigShell } from "@opencode/schema/config/shell"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export const ConfigGroup = HttpApiGroup.make("server.config")
  .add(
    HttpApiEndpoint.get("config.get", "/api/config", {
      query: LocationQuery,
      success: Schema.Array(Config.Entry),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.get",
          summary: "Get configuration",
          description:
            "Return configuration documents and discovery sources for the requested location, from lowest to highest priority.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("config.preferences", "/api/config/preferences", {
      success: Config.Preferences,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.config.preferences",
        summary: "Get global preferences",
        description: "Return preferences from the highest-precedence global configuration document.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("config.updatePreferences", "/api/config/preferences", {
      payload: Config.PreferencesPatch,
      success: Config.Preferences,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.config.updatePreferences",
        summary: "Update global preferences",
        description: "Patch preferences in the highest-precedence global configuration document.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("config.shells", "/api/config/shell", {
      success: Schema.Array(ConfigShell.Option),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.config.shells",
        summary: "List available shells",
        description: "Return shells available to terminal and agent execution.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "config", description: "Location-scoped configuration routes." }))
