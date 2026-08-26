import {
  CONNECTABLE_APP_DEFINITIONS,
  appSupportsCatalogSetup,
  connectionMethodSupportsAutomaticOAuth,
  getAvailableConnectionMethods,
  getConnectableAppDefinition,
} from "@paperclipai/shared";

export const MCP_DIRECT_OAUTH_CONNECT_SLUGS = CONNECTABLE_APP_DEFINITIONS
  .filter((app) => getAvailableConnectionMethods(app).some((method) =>
    connectionMethodSupportsAutomaticOAuth(method)
  ))
  .map((app) => app.slug);

export function isMcpDirectOAuthConnectSlug(slug: string | null | undefined): boolean {
  return MCP_DIRECT_OAUTH_CONNECT_SLUGS.some((allowedSlug) => allowedSlug === slug);
}

export function appSourceConnectHref(slug: string): string {
  return `/apps/connect?${new URLSearchParams({ source: slug }).toString()}`;
}

export function resolveAppsConnectRouteKey(input: {
  serviceSlug?: string | null;
  appKey?: string | null;
  sourceSlug?: string | null;
}): string | undefined {
  return input.serviceSlug ?? input.appKey ?? input.sourceSlug ?? undefined;
}

export function canEnterAppsConnect(searchParams: URLSearchParams): boolean {
  if (searchParams.get("byo") === "1") return true;
  const entry = getConnectableAppDefinition(searchParams.get("source") ?? "");
  return appSupportsCatalogSetup(entry);
}
