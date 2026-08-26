import { CONNECTABLE_APP_DEFINITIONS, appSupportsCatalogSetup } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  MCP_DIRECT_OAUTH_CONNECT_SLUGS,
  appSourceConnectHref,
  canEnterAppsConnect,
  isMcpDirectOAuthConnectSlug,
  resolveAppsConnectRouteKey,
} from "./app-connect-policy";

describe("app connect policy", () => {
  it("derives automatic OAuth entry points from app capabilities", () => {
    expect(MCP_DIRECT_OAUTH_CONNECT_SLUGS).toEqual(expect.arrayContaining(["jira", "notion", "sentry"]));
    expect(isMcpDirectOAuthConnectSlug("notion")).toBe(true);
    expect(isMcpDirectOAuthConnectSlug("jira")).toBe(true);
    expect(isMcpDirectOAuthConnectSlug("asana")).toBe(false);
    expect(isMcpDirectOAuthConnectSlug("github")).toBe(false);
    expect(isMcpDirectOAuthConnectSlug("slack")).toBe(false);
    expect(isMcpDirectOAuthConnectSlug(null)).toBe(false);
  });

  it("admits every capability-backed catalog deep link", () => {
    expect(canEnterAppsConnect(new URLSearchParams("source=notion"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=jira"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=asana"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=github"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=context7"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=zapier"))).toBe(true);
    expect(canEnterAppsConnect(new URLSearchParams("source=unknown"))).toBe(false);
    expect(canEnterAppsConnect(new URLSearchParams("byo=1&source=zapier"))).toBe(true);
  });

  it("builds a generic source deep link", () => {
    expect(appSourceConnectHref("notion")).toBe("/apps/connect?source=notion");
  });

  it("routes every capability-backed catalog definition through its source deep link", () => {
    const connectableApps = CONNECTABLE_APP_DEFINITIONS.filter(appSupportsCatalogSetup);

    expect(connectableApps.length).toBeGreaterThan(0);
    for (const app of connectableApps) {
      const href = appSourceConnectHref(app.slug);
      const searchParams = new URL(href, "http://paperclip.test").searchParams;

      expect(canEnterAppsConnect(searchParams), app.slug).toBe(true);
      expect(resolveAppsConnectRouteKey({ sourceSlug: searchParams.get("source") }), app.slug).toBe(app.slug);
    }
  });

  it("preserves explicit route precedence while accepting every authentication mode", () => {
    expect(resolveAppsConnectRouteKey({ serviceSlug: "jira", appKey: "asana", sourceSlug: "mem0" })).toBe("jira");
    expect(resolveAppsConnectRouteKey({ appKey: "asana", sourceSlug: "mem0" })).toBe("asana");
    expect(resolveAppsConnectRouteKey({ sourceSlug: "mem0" })).toBe("mem0");
    expect(resolveAppsConnectRouteKey({ sourceSlug: "context7" })).toBe("context7");
    expect(resolveAppsConnectRouteKey({ sourceSlug: "supabase" })).toBe("supabase");
    expect(resolveAppsConnectRouteKey({})).toBeUndefined();
  });
});
