import { describe, expect, it } from "vitest";
import {
  MCP_DIRECT_OAUTH_CONNECT_SLUGS,
  appSourceConnectHref,
  canEnterAppsConnect,
  isMcpDirectOAuthConnectSlug,
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
});
