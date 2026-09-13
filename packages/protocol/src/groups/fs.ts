import { FileSystem } from "@opencode/schema/filesystem"
import { Location } from "@opencode/schema/location"
import { PositiveInt } from "@opencode/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { FileNotFoundError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const ListQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: Schema.String.pipe(Schema.optional).annotate({
    description: "An absolute path or a path relative to the requested location. Defaults to the location directory.",
  }),
})

const FindQuery = Schema.Struct({
  ...LocationQuery.fields,
  query: FileSystem.FindInput.fields.query,
  type: FileSystem.FindInput.fields.type,
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
})

export const FileSystemGroup = HttpApiGroup.make("server.fs")
  .add(
    HttpApiEndpoint.get("fs.read", "/api/fs/read/*", {
      query: LocationQuery,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: FileNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.read",
          summary: "Read file",
          description: "Serve one file relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.list", "/api/fs/list", {
      query: ListQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.list",
          summary: "List directory",
          description:
            "List direct children using an absolute path or a path relative to the requested location, including parents and siblings outside its directory. Entry paths remain relative to the requested location; listing does not switch locations.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.find", "/api/fs/find", {
      query: FindQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.find",
          summary: "Find files",
          description: "Find recursively ranked filesystem entries relative to the requested location.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "filesystem",
      description: "Experimental location-scoped filesystem routes.",
    }),
  )
