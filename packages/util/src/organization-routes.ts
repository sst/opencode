// Console reserves this provider namespace for organization-scoped routing catalogs.
export function isOrganizationRouteProvider(providerID: string) {
  return providerID.startsWith("opencode-routes-") && providerID.length > "opencode-routes-".length
}
