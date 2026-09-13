import type { APIEvent } from "@solidjs/start/server"

// OAuth Client ID Metadata Document for the opencode client.
// Spec: https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/
//
// When an MCP server's authorization server supports this, opencode sends this URL as its OAuth client_id
// instead of registering a new client. The authorization server fetches the document to learn our name and
// allowed redirect URIs. The client_id field must equal the exact URL the document was fetched from, so it is
// built from the request origin and stays valid on dev.opencode.ai as well as production.
//
// redirect_uris have no port because opencode binds an ephemeral port per login. RFC 8252 section 7.3 has
// authorization servers ignore the port when matching loopback redirects for native apps.
const PATH = "/oauth/opencode/client.json"

const cache = "public, max-age=300"

export function GET(event: APIEvent) {
  const origin = new URL(event.request.url).origin
  const document = {
    client_id: origin + PATH,
    client_name: "opencode",
    client_uri: origin,
    logo_uri: origin + "/web-app-manifest-512x512.png",
    application_type: "native",
    redirect_uris: ["http://127.0.0.1/callback", "http://localhost/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    token_endpoint_auth_methods_supported: ["none"],
  }
  return new Response(JSON.stringify(document, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cache,
      "Access-Control-Allow-Origin": "*",
    },
  })
}
