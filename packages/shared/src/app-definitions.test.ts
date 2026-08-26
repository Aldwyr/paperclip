import { describe,expect,it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_DEFINITIONS } from "./app-definitions.generated.js";
import { CONNECTABLE_APP_DEFINITIONS, appSupportsCatalogSetup, recommendedDefaultsForApp } from "./app-definitions.js";
import { BLOCKED_MCP_PROVIDERS, SELF_SERVE_MCP_CANDIDATES, SELF_SERVE_MCP_RESEARCH } from "./self-serve-mcp-research.js";
import { appDefinitionsSchema } from "./validators/app-definition.js";
describe("AppDefinition catalog",()=>{
 it("validates all Wave 1 definitions",()=>expect(()=>appDefinitionsSchema.parse(APP_DEFINITIONS)).not.toThrow());
 it("contains every established provider plus the reviewed self-serve catalog",()=>{
 expect(APP_DEFINITIONS.map((app)=>app.slug)).toEqual(expect.arrayContaining(["zapier","github","slack","notion","posthog","linear","google-sheets","context7","composio","oauth-generic","api-key-generic","sentry","vercel","anthropic","gmail"]));
  expect(SELF_SERVE_MCP_CANDIDATES).toHaveLength(43);
  expect(BLOCKED_MCP_PROVIDERS.map((entry)=>entry.slug)).toEqual(["g2","vercel","zomato"]);
  const definitionSlugs=new Set(APP_DEFINITIONS.map((app)=>app.slug));
  const connectableSlugs=new Set(CONNECTABLE_APP_DEFINITIONS.map((app)=>app.slug));
  expect(SELF_SERVE_MCP_CANDIDATES.filter((entry)=>!definitionSlugs.has(entry.slug))).toEqual([]);
  expect(SELF_SERVE_MCP_CANDIDATES.filter((entry)=>!connectableSlugs.has(entry.slug))).toEqual([]);
  for(const entry of BLOCKED_MCP_PROVIDERS)expect(connectableSlugs.has(entry.slug)).toBe(false);
 });
 it("keeps a complete, unique, dated evidence ledger for all 46 researched MCP providers",()=>{
  expect(SELF_SERVE_MCP_RESEARCH.verifiedAt).toBe("2026-08-26");
  expect(SELF_SERVE_MCP_RESEARCH.entries).toHaveLength(46);
  expect(new Set(SELF_SERVE_MCP_RESEARCH.entries.map((entry)=>entry.slug))).toHaveProperty("size",46);
  for(const entry of SELF_SERVE_MCP_RESEARCH.entries){
   expect(new URL(entry.docsUrl).protocol).toBe("https:");
   expect(new URL(entry.serverUrl).protocol).toBe("https:");
   expect(entry.authMode).toBeTruthy();
   expect(entry.prerequisite.length).toBeGreaterThan(10);
   expect(["S1","S2","S3","S4"]).toContain(entry.riskTier);
  }
 });
 it("uses the reviewed current endpoints and configuration modes",()=>{
  const method=(slug:string,key?:string)=>APP_DEFINITIONS.find((app)=>app.slug===slug)?.methods.find((candidate)=>!key||candidate.key===key);
  expect(method("jira")?.defaults?.serverUrl).toBe("https://mcp.atlassian.com/v1/mcp/authv2");
  expect(method("cloudinary")?.defaults?.serverUrl).toBe("https://asset-management.mcp.cloudinary.com/mcp");
  expect(method("kernel")?.defaults?.serverUrl).toBe("https://mcp.onkernel.com/mcp");
  expect(method("resend")?.defaults?.serverUrl).toBe("https://mcp.resend.com/mcp");
  expect(method("clickhouse")?.defaults?.serverUrl).toBe("https://mcp.clickhouse.cloud/clickstack");
  expect(method("clickhouse")?.tenantFields?.[0]?.transport).toEqual({location:"header",name:"x-service-id"});
  expect(method("mem0")).toMatchObject({auth:"api_key",keyPlacement:{location:"header",name:"Authorization",prefix:"Bearer "}});
  expect(APP_DEFINITIONS.find((app)=>app.slug==="pagerduty")?.methods.map((candidate)=>({key:candidate.key,serverUrl:candidate.defaults?.serverUrl}))).toEqual([
   {key:"mcp-api-key-us",serverUrl:"https://mcp.pagerduty.com/mcp"},
   {key:"mcp-api-key-eu",serverUrl:"https://mcp.eu.pagerduty.com/mcp"},
  ]);
  expect(method("context7")).toMatchObject({auth:"none",defaults:{serverUrl:"https://mcp.context7.com/mcp"}});
  expect(APP_DEFINITIONS.find((app)=>app.slug==="planetscale")?.methods.map((candidate)=>candidate.key)).toEqual(["mcp-oauth","mcp-insights-only"]);
  expect(APP_DEFINITIONS.find((app)=>app.slug==="postman")?.methods.map((candidate)=>candidate.key)).toEqual([
   "mcp-oauth-minimal","mcp-oauth-code","mcp-oauth-full","mcp-eu-key-minimal","mcp-eu-key-code","mcp-eu-key-full",
  ]);
  expect(method("supabase")?.tenantFields?.find((field)=>field.key==="readOnly")?.defaultValue).toBe(true);
  expect(method("asana")?.ownershipModes).toEqual(["customer"]);
  expect(method("zapier")).toMatchObject({key:"generated-url",auth:"none",defaults:{}});
  expect(method("zapier")?.credentialFields).toBeUndefined();
 });
 it("uses discovery-first Notion MCP OAuth metadata",()=>{
  const notion=APP_DEFINITIONS.find((app)=>app.slug==="notion");
  expect(notion?.redirectConstraints).toBe("https-or-loopback-http");
  expect(notion?.methods[0]?.defaults).toEqual({serverUrl:"https://mcp.notion.com/mcp"});
 });
 it("preserves required Linear OAuth scopes",()=>expect(APP_DEFINITIONS.find((app)=>app.slug==="linear")?.methods[0]?.defaults?.scopesHint).toEqual(["read","write"]));
 it("defaults S4 write and destructive actions to ask-first",()=>{for(const app of APP_DEFINITIONS)for(const method of app.methods)expect(recommendedDefaultsForApp(app,method.key)).toEqual({access:"all_agents",askFirstRiskLevels:method.riskTier==="S4"?["write","destructive"]:[]})});
 it("ships complete local branding provenance for all 50 visible providers",()=>{
  const uiPublic=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../../ui/public");
  const manifest=JSON.parse(fs.readFileSync(path.join(uiPublic,"brands/apps/manifest.json"),"utf8")) as {providers:Array<{slug:string;catalogVisible:boolean;localAsset:string;darkAsset?:string;officialSourceUrl:string;upstreamAssetUrl:string;assetType:"svg"|"png";darkVariantRequired:boolean}>};
  const visible=manifest.providers.filter((entry)=>entry.catalogVisible);
  expect(visible).toHaveLength(50);
  expect(new Set(visible.map((entry)=>entry.slug))).toHaveProperty("size",50);
  expect(new Set(visible.map((entry)=>entry.localAsset))).toHaveProperty("size",50);
  expect(new Set(CONNECTABLE_APP_DEFINITIONS.map((entry)=>entry.slug))).toEqual(new Set(visible.map((entry)=>entry.slug)));
  for(const app of CONNECTABLE_APP_DEFINITIONS){
   const provenance=visible.find((entry)=>entry.slug===app.slug)!;
   expect(provenance).toBeTruthy();
   expect(provenance.localAsset).toBe(app.branding.logoUrl);
   expect(provenance.darkAsset).toBe(app.branding.darkLogoUrl);
   expect(provenance.darkVariantRequired).toBe(Boolean(provenance.darkAsset));
   expect(new URL(provenance.officialSourceUrl).protocol).toBe("https:");
   expect(new URL(provenance.upstreamAssetUrl).protocol).toBe("https:");
   expect(provenance.localAsset).toMatch(/^\/brands\/apps\/.+\.(svg|png)$/);
   expect(provenance.localAsset).not.toContain("google.com/s2/favicons");
   const asset=fs.readFileSync(path.join(uiPublic,provenance.localAsset));
   if(provenance.assetType==="png"){
    expect(asset.subarray(0,8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(asset.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
    expect(asset.readUInt32BE(20)).toBeGreaterThanOrEqual(128);
   }else{
    const svg=asset.toString("utf8");
    expect(svg).toMatch(/^<svg\b/);
    expect(svg).not.toMatch(/<script|<foreignObject|\son[a-z]+\s*=/i);
   }
   if(provenance.darkAsset)expect(fs.existsSync(path.join(uiPublic,provenance.darkAsset))).toBe(true);
  }
 });
 it("makes every researched self-serve candidate actionable while blocked providers stay absent",()=>{
  const definitions=new Map(CONNECTABLE_APP_DEFINITIONS.map((entry)=>[entry.slug,entry]));
  for(const candidate of SELF_SERVE_MCP_CANDIDATES)expect(appSupportsCatalogSetup(definitions.get(candidate.slug))).toBe(true);
  for(const blocked of BLOCKED_MCP_PROVIDERS)expect(definitions.has(blocked.slug)).toBe(false);
 });
 it("keeps Gmail personal-only and bound to the Paperclip ID broker",()=>expect(APP_DEFINITIONS.find((app)=>app.slug==="gmail")?.methods[0]).toMatchObject({oauthStrategy:"paperclip_id_connector",grantKinds:["user"],defaults:{serverUrl:"https://gmailmcp.googleapis.com/mcp/v1",scopesHint:["https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/gmail.compose"]}}));
 it("offers PostHog OAuth and API-key methods with broad defaults and advanced narrowing",()=>{const posthog=APP_DEFINITIONS.find((app)=>app.slug==="posthog");expect(posthog?.methods.map((method)=>method.key)).toEqual(["mcp-oauth","mcp-api-key"]);for(const method of posthog?.methods??[]){expect(method.riskTier).toBe("S3");expect(method.tenantFields?.find((field)=>field.key==="readOnly")?.defaultValue).toBe(false);expect(method.tenantFields?.find((field)=>field.key==="projectId")?.transport).toEqual({location:"header",name:"x-posthog-project-id"});expect(method.tenantFields?.filter((field)=>field.advanced).map((field)=>field.key)).toEqual(["features","tools","mode"]);expect(method.configRequirements).toBeUndefined();expect(method.requiredResourceFilters).toEqual(["project"])}});
 it("enforces method and field invariants",()=>{for(const app of APP_DEFINITIONS)for(const method of app.methods){if(method.auth==="api_key")expect(method.keyPlacement).toBeTruthy();if(method.auth==="oauth")expect(method.ownershipModes.length).toBeGreaterThan(0);for(const field of method.credentialFields??[])if(field.required&&field.type!=="checkbox")expect(field.placeholder).toBeTruthy()}});
});
