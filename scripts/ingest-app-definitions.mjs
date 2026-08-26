import fs from "node:fs"; import path from "node:path";
const root=process.cwd(); const corpus=process.env.PAPERCLIP_CONTENT_TEMPLATES??path.resolve(root,"../../paperclip-content/research/connections/vercel/templates");
const out=path.join(root,"packages/shared/src/app-definitions");
const brandingManifest=JSON.parse(fs.readFileSync(path.join(root,"ui/public/brands/apps/manifest.json"),"utf8"));
const brandingBySlug=new Map(brandingManifest.providers.map((entry)=>[entry.slug,entry]));
const brandingFor=(slug)=>{
 const entry=brandingBySlug.get(slug);
 if(entry) return {logoUrl:entry.localAsset,...(entry.darkAsset?{darkLogoUrl:entry.darkAsset}:{})};
 if(slug==="oauth-generic"||slug==="api-key-generic") return {logoUrl:`/brands/apps/${slug}.svg`};
 throw new Error(`${slug}: missing local branding provenance`);
};
const field=(key,label,placeholder)=>({key,label,type:"password",required:true,placeholder,secret:true});
const method=(key,transport,auth,defaults,riskTier,guidanceMd,extra={})=>({key,transport,auth,ownershipModes:auth==="oauth"?["customer","dcr"]:["customer"],whenToUse:transport==="mcp_remote"?"Use the provider-hosted connection for the quickest setup.":"Use credentials from your provider account.",defaults,guidanceMd,riskTier,...extra});
const posthogConfigFields=()=>[
 {key:"projectId",label:"Project ID",type:"text",required:true,placeholder:"12345",helperMd:"Find the numeric project ID in PostHog project settings.",validation:{pattern:"^[0-9]+$",maxLength:32},transport:{location:"header",name:"x-posthog-project-id"}},
 {key:"readOnly",label:"Read-only mode",type:"checkbox",defaultValue:false,helperMd:"Turn on to hide tools that can change PostHog data.",transport:{location:"query",name:"readonly",format:"boolean",omitFalse:true}},
 {key:"features",label:"Feature groups",type:"textarea",advanced:true,placeholder:"Optional comma-separated feature groups",helperMd:"Leave blank to expose every feature group, or enter a comma-separated list to narrow access.",validation:{maxLength:500},transport:{location:"query",name:"features",format:"csv"}},
 {key:"tools",label:"Individual tools",type:"textarea",advanced:true,placeholder:"Optional comma-separated tool names",helperMd:"Leave blank to expose all tools. Exact names here are combined with any feature groups.",validation:{maxLength:2000},transport:{location:"query",name:"tools",format:"csv"}},
 {key:"mode",label:"Tool response mode",type:"select",advanced:true,required:true,placeholder:"Individual tools",defaultValue:"tools",options:[{value:"tools",label:"Individual tools"}],helperMd:"Paperclip uses individual tools so every action can be governed. CLI mode remains unavailable until nested execution is governed.",transport:{location:"query",name:"mode"}},
];
const posthogMethod=(key,auth,extra={})=>method(key,"mcp_remote",auth,{serverUrl:"https://mcp.posthog.com/mcp"},"S3","Pin the connection to one PostHog project and expose the full tool catalog by default. Narrow feature groups or tools only when needed.",{tenantFields:posthogConfigFields(),requiredResourceFilters:["project"],...extra});
const apps=[
["zapier","Zapier","Reach thousands of apps through your Zapier account.","productivity","zapier.com",["https://mcp.zapier.com/*"],method("generated-url","mcp_remote","none",{},"S3","Create a Zapier MCP server, then paste the complete generated connection URL. The token remains embedded in that URL.",{label:"Paste generated MCP URL",whenToUse:"Use the complete provider-generated MCP URL from Zapier."})],
["github","GitHub","Read code and pull requests, and coordinate repository work.","developer","github.com",["https://api.githubcopilot.com/mcp/*"],method("mcp-key","mcp_remote","api_key",{serverUrl:"https://api.githubcopilot.com/mcp/"},"S3","Create a fine-grained token limited to the repositories agents should use.",{credentialFields:[field("authorization","GitHub token","github_pat_...")],keyPlacement:{location:"header",name:"Authorization",prefix:"Bearer "},requiredResourceFilters:["organization","repository"]})],
["slack","Slack","Search channels and coordinate team communication.","communication","slack.com",["https://mcp.slack.com/*"],method("mcp-oauth","mcp_remote","oauth",{serverUrl:"https://mcp.slack.com/mcp",authorizationEndpoint:"https://slack.com/oauth/v2/authorize",tokenEndpoint:"https://slack.com/api/oauth.v2.access",scopesHint:["channels:read","chat:write","search:read"]},"S3","Connect a Slack workspace and limit access to the channels agents need.",{ownershipModes:["customer"],requiredResourceFilters:["workspace","channel"]})],
["notion","Notion","Read and update pages in your Notion workspace.","content","notion.so",["https://mcp.notion.com/*"],method("mcp-oauth","mcp_remote","oauth",{serverUrl:"https://mcp.notion.com/mcp"},"S3","Connect Notion for workspace content. Share only the pages and databases agents should use.",{requiredResourceFilters:["workspace","page","database"]}),{redirectConstraints:"https-or-loopback-http"}],
["posthog","PostHog","Analyze product usage, errors, feature flags, and experiments in a pinned PostHog project.","analytics","posthog.com",["https://mcp.posthog.com/*"],[posthogMethod("mcp-oauth","oauth",{label:"Sign in with PostHog",ownershipModes:["customer","dcr"],whenToUse:"Sign in with PostHog in the browser. Recommended for hosted PostHog accounts.",consoleLinks:{docs:"https://posthog.com/docs/model-context-protocol"}}),posthogMethod("mcp-api-key","api_key",{label:"Use a personal API key",whenToUse:"Use a PostHog personal API key when browser sign-in is not suitable.",credentialFields:[field("authorization","PostHog personal API key","phx_...")],keyPlacement:{location:"header",name:"Authorization",prefix:"Bearer "},consoleLinks:{keys:"https://posthog.com/docs/model-context-protocol/faq",docs:"https://posthog.com/docs/model-context-protocol/faq"}})],{featured:true}],
["linear","Linear","Create, update, and read Linear issues.","productivity","linear.app",["https://mcp.linear.app/*"],method("mcp-oauth","mcp_remote","oauth",{serverUrl:"https://mcp.linear.app/mcp",authorizationEndpoint:"https://linear.app/oauth/authorize",tokenEndpoint:"https://api.linear.app/oauth/token",scopesHint:["read","write"]},"S2","Register a Linear OAuth app and add Paperclip's redirect URI before connecting.",{ownershipModes:["customer"],requiredResourceFilters:["workspace","team","project"]})],
["google-sheets","Google Sheets","Read and update selected spreadsheets.","data","sheets.google.com",["https://docs.google.com/spreadsheets/*","https://sheets.google.com/*"],method("local","local_stdio","none",{templateKey:"paperclip.google-sheets"},"S3","Share each spreadsheet with the Paperclip robot email, then paste the sheet links.",{requiredResourceFilters:["spreadsheet"]})],
["context7","Context7","Look up current documentation for software libraries.","developer","context7.com",["https://mcp.context7.com/*"],method("mcp","mcp_remote","none",{serverUrl:"https://mcp.context7.com/mcp"},"S1","Connect Context7 to give agents current library documentation.")],
["composio","Composio","Connect Composio so Paperclip can discover and manage the toolkits in your project.","productivity","composio.dev",["https://backend.composio.dev/*"],method("api-key","rest_api","api_key",{serviceHost:"backend.composio.dev"},"S3","Create a scoped project API key in Composio. It needs read access to toolkits and auth configs; later service-connection phases also need connected-account and session access.",{whenToUse:"Use a project API key from the Composio project that owns the toolkits and connected accounts.",credentialFields:[field("apiKey","Composio project API key","Paste the Composio API key")],keyPlacement:{location:"header",name:"x-api-key"},consoleLinks:{keys:"https://app.composio.dev/",settings:"https://app.composio.dev/",docs:"https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions"}}),{featured:true}],
["oauth-generic","OAuth app","Connect a provider using your own OAuth client.","other","oauth.net",[],method("oauth","rest_api","oauth",{},"S3","Register an OAuth client with the provider and add Paperclip's redirect URI.",{credentialFields:[{...field("clientId","Client ID","Paste the client ID"),type:"text",secret:false},field("clientSecret","Client secret","Paste the client secret")]})],
["api-key-generic","API key app","Connect an API using a key from your provider.","other","openapis.org",[],method("api-key","rest_api","api_key",{},"S3","Create a restricted API key and paste it here.",{credentialFields:[field("apiKey","API key","Paste the API key")],keyPlacement:{location:"header",name:"Authorization",prefix:"Bearer "}})],
["sentry","Sentry","Investigate errors, releases, and production issues.","developer","sentry.io",["https://mcp.sentry.dev/*"],method("mcp-oauth","mcp_remote","oauth",{serverUrl:"https://mcp.sentry.dev/mcp",discoveryUrl:"https://sentry.io/.well-known/oauth-authorization-server"},"S2","Connect the Sentry organization and projects agents need for incident work.",{requiredResourceFilters:["organization","project","environment"]})],
["vercel","Vercel","Inspect projects, deployments, and runtime logs.","developer","vercel.com",["https://mcp.vercel.com/*"],method("mcp-oauth","mcp_remote","oauth",{serverUrl:"https://mcp.vercel.com/mcp"},"S3","Connect the Vercel team and projects agents should operate.",{requiredResourceFilters:["team","project","environment"]})],
["anthropic","Anthropic","Use Anthropic APIs with a restricted key.","ai","anthropic.com",["https://api.anthropic.com/*"],method("api-key","rest_api","api_key",{serviceHost:"api.anthropic.com"},"S3","Create a key in the Anthropic Console and rotate it if it has been exposed.",{credentialFields:[field("apiKey","API key","sk-ant-api03-...")],keyPlacement:{location:"header",name:"x-api-key"}})],
].map(([slug,name,description,category,_domain,urlPatterns,m,extra={}])=>({schemaVersion:1,slug,name,description,categories:[category],featured:["zapier","github","slack","notion","posthog","linear"].includes(slug),branding:brandingFor(slug),urlPatterns,methods:Array.isArray(m)?m:[m],...extra}));
apps.push({schemaVersion:1,slug:"gmail",name:"Gmail",description:"Search and read Gmail messages and create drafts without enabling mail sending.",categories:["communication","productivity"],featured:true,branding:brandingFor("gmail"),urlPatterns:["https://gmailmcp.googleapis.com/*"],docsUrl:"https://developers.google.com/workspace/guides/configure-mcp-servers",redirectConstraints:"https-or-loopback-http",methods:[{key:"paperclip-id-oauth",label:"Connect Gmail",transport:"mcp_remote",auth:"oauth",oauthStrategy:"paperclip_id_connector",grantKinds:["user"],ownershipModes:["customer"],whenToUse:"Use Paperclip ID for a personal Gmail connection with centrally registered Google OAuth.",defaults:{serverUrl:"https://gmailmcp.googleapis.com/mcp/v1",scopesHint:["https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/gmail.compose"]},guidanceMd:"Connect your Gmail identity. Paperclip can search and read mail and create drafts. Sending mail is not enabled.",warnings:["This connection is personal. Agents need an explicit install, profile, and delegation before they can use it."],riskTier:"S3"}]});

// The reviewed MCP program is a durable input, not another hand-maintained
// allowlist. Runtime definitions are generated from the same 46-row evidence
// ledger that the tests and implementation checklist validate.
const researchManifest=JSON.parse(fs.readFileSync(path.join(root,"packages/shared/src/self-serve-mcp-research.json"),"utf8"));
const categoryBySlug={
 airtable:"data",asana:"productivity",beehiiv:"content",bitly:"analytics",box:"content",brex:"commerce",candid:"data",clickhouse:"data",cloudflare:"developer",cloudinary:"content",coda:"productivity",egnyte:"content",embat:"commerce","hugging-face":"ai",jira:"productivity",kernel:"developer","local-falcon":"analytics",make:"productivity",manufact:"productivity",mem0:"ai",miro:"productivity",mixpanel:"analytics",netlify:"developer",notion:"content",oreilly:"content",pagerduty:"developer",planetscale:"data",posthog:"analytics",postman:"developer",razorpay:"commerce",resend:"communication",sanity:"content",sentry:"developer",similarweb:"analytics",stripe:"commerce",supabase:"data","ticket-tailor":"commerce",ticktick:"productivity",todoist:"productivity",webflow:"content",wix:"content",xero:"commerce",zapier:"productivity",
};
const oauthMethodFor=(entry,key="mcp-oauth",serverUrl=entry.serverUrl,extra={})=>method(key,"mcp_remote","oauth",{serverUrl},entry.riskTier,`Connect ${entry.name} in the browser. ${entry.prerequisite}`,{label:`Sign in with ${entry.name}`,ownershipModes:["dcr"],whenToUse:"Use browser sign-in for the provider-hosted MCP server.",consoleLinks:{docs:entry.docsUrl},warnings:[entry.prerequisite],...extra});
const customerOAuthMethodFor=(entry)=>oauthMethodFor(entry,"mcp-own-oauth",entry.serverUrl,{label:"Use your own OAuth app",ownershipModes:["customer"],whenToUse:`Register an OAuth app with ${entry.name}, then enter its client ID and secret.`,consoleLinks:{register:entry.docsUrl,docs:entry.docsUrl}});
const apiKeySpec={
 bitly:{name:"Authorization",prefix:"Bearer ",placeholder:"Paste your Bitly API token"},
 cloudflare:{name:"Authorization",prefix:"Bearer ",placeholder:"Paste your Cloudflare API token"},
 coda:{name:"Authorization",prefix:"Bearer ",placeholder:"Paste your Coda API token"},
 kernel:{name:"X-API-Key",prefix:null,placeholder:"Paste your Kernel API key"},
 mem0:{name:"Authorization",prefix:"Bearer ",placeholder:"m0sk_..."},
 oreilly:{name:"Authorization",prefix:"Bearer ",placeholder:"Paste your O'Reilly API token"},
 pagerduty:{name:"Authorization",prefix:"Token token=",placeholder:"Paste your PagerDuty user API token"},
 postman:{name:"X-API-Key",prefix:null,placeholder:"PMAK-..."},
 razorpay:{name:"Authorization",prefix:"Basic ",placeholder:"Paste the base64-encoded key ID and secret"},
 sanity:{name:"Authorization",prefix:"Bearer ",placeholder:"sk..."},
 similarweb:{name:"api-key",prefix:null,placeholder:"Paste your Similarweb API key"},
 stripe:{name:"Authorization",prefix:"Bearer ",placeholder:"sk_..."},
 supabase:{name:"Authorization",prefix:"Bearer ",placeholder:"sbp_..."},
};
const apiKeyMethodFor=(entry,key="mcp-api-key",serverUrl=entry.serverUrl,extra={})=>{
 const spec=apiKeySpec[entry.slug]??{name:"Authorization",prefix:"Bearer ",placeholder:`Paste your ${entry.name} API key`};
 return method(key,"mcp_remote","api_key",{serverUrl},entry.riskTier,`Use a customer-created ${entry.name} key. ${entry.prerequisite}`,{label:"Use an API key",whenToUse:"Use a restricted customer-owned key when browser sign-in is not suitable.",credentialFields:[field("authorization",`${entry.name} API key`,spec.placeholder)],keyPlacement:{location:"header",name:spec.name,prefix:spec.prefix},consoleLinks:{keys:entry.docsUrl,docs:entry.docsUrl},warnings:[entry.prerequisite],...extra});
};
const specialMethodsFor=(entry)=>{
 if(entry.slug==="clickhouse") return [oauthMethodFor(entry,"mcp-oauth",entry.serverUrl,{tenantFields:[{key:"serviceId",label:"ClickHouse Cloud service ID",type:"text",required:true,placeholder:"11e1031f-9a13-4cac-9bc7-d4ec9286ec17",helperMd:"Copy the service ID from ClickStack → Team Settings → API & Agents.",transport:{location:"header",name:"x-service-id"}}],requiredResourceFilters:["service"]})];
 if(entry.slug==="planetscale") return [
  oauthMethodFor(entry,"mcp-oauth",entry.serverUrl,{label:"Database access",tenantFields:[{key:"project",label:"Project or database",type:"text",advanced:true,placeholder:"Optional project or database name",helperMd:"Records the intended database boundary; final access is selected during PlanetScale authorization."},{key:"branch",label:"Branch",type:"text",advanced:true,placeholder:"Optional branch name",helperMd:"Records the intended branch boundary; final access is selected during PlanetScale authorization."}],requiredResourceFilters:["organization","database","branch"]}),
  oauthMethodFor(entry,"mcp-insights-only","https://mcp.pscale.dev/mcp/planetscale-insights-only",{label:"Insights only",whenToUse:"Use query insights and schema recommendations without query execution tools.",requiredResourceFilters:["organization","database","branch"]}),
 ];
 if(entry.slug==="postman") return [
  oauthMethodFor(entry,"mcp-oauth-minimal","https://mcp.postman.com/minimal",{label:"US · Minimal"}),
  oauthMethodFor(entry,"mcp-oauth-code","https://mcp.postman.com/code",{label:"US · Code"}),
  oauthMethodFor(entry,"mcp-oauth-full","https://mcp.postman.com/mcp",{label:"US · Full"}),
  apiKeyMethodFor(entry,"mcp-eu-key-minimal","https://mcp.eu.postman.com/minimal",{label:"EU · Minimal"}),
  apiKeyMethodFor(entry,"mcp-eu-key-code","https://mcp.eu.postman.com/code",{label:"EU · Code"}),
  apiKeyMethodFor(entry,"mcp-eu-key-full","https://mcp.eu.postman.com/mcp",{label:"EU · Full"}),
 ];
 if(entry.slug==="pagerduty") return [
  apiKeyMethodFor(entry,"mcp-api-key-us","https://mcp.pagerduty.com/mcp",{label:"US service region"}),
  apiKeyMethodFor(entry,"mcp-api-key-eu","https://mcp.eu.pagerduty.com/mcp",{label:"EU service region"}),
 ];
 if(entry.slug==="supabase") {
  const tenantFields=[
   {key:"projectRef",label:"Project reference",type:"text",required:true,placeholder:"abcdefghijklmnopqrst",helperMd:"Scope the connection to one development project.",transport:{location:"query",name:"project_ref"}},
   {key:"readOnly",label:"Read-only mode",type:"checkbox",defaultValue:true,helperMd:"Keep enabled unless the agent must change the database.",transport:{location:"query",name:"read_only",format:"boolean"}},
   {key:"features",label:"Feature groups",type:"textarea",advanced:true,placeholder:"database,docs",helperMd:"Optional comma-separated feature groups.",transport:{location:"query",name:"features",format:"csv"}},
  ];
  const warning="Do not connect production data unless you have reviewed Supabase's MCP security guidance.";
  return [oauthMethodFor(entry,"mcp-oauth",entry.serverUrl,{tenantFields,warnings:[entry.prerequisite,warning],requiredResourceFilters:["project"]}),apiKeyMethodFor(entry,"mcp-api-key",entry.serverUrl,{tenantFields,warnings:[entry.prerequisite,warning],requiredResourceFilters:["project"]})];
 }
 return null;
};

for(const entry of researchManifest.entries){
 const existing=apps.find((app)=>app.slug===entry.slug);
 if(entry.status==="blocked"){
  if(existing) existing.availability={available:false,reason:entry.prerequisite};
  continue;
 }
 if(existing){
  existing.docsUrl=entry.docsUrl;
  existing.redirectConstraints=existing.methods.some((entryMethod)=>entryMethod.auth==="oauth")?"https-or-loopback-http":existing.redirectConstraints;
  if(entry.slug!=="zapier") for(const entryMethod of existing.methods) if(entryMethod.transport==="mcp_remote"&&entryMethod.defaults?.serverUrl) entryMethod.defaults.serverUrl=entry.serverUrl;
  continue;
 }
 let methods=specialMethodsFor(entry);
 if(!methods){
  if(entry.authMode==="customer_oauth") methods=[customerOAuthMethodFor(entry)];
  else if(entry.authMode==="api_key") methods=[apiKeyMethodFor(entry)];
  else {
   methods=[oauthMethodFor(entry)];
   if(entry.authMode==="dcr_or_api_key") methods.push(apiKeyMethodFor(entry));
  }
 }
 const warnings=[];
 if(["coda","mixpanel"].includes(entry.slug)) warnings.push("This provider's hosted MCP server is currently beta or preview.");
 if(["brex","razorpay","stripe"].includes(entry.slug)) warnings.push("Financial or destructive actions must be explicitly approved before execution.");
 apps.push({schemaVersion:1,slug:entry.slug,name:entry.name,description:`Connect ${entry.name}'s provider-hosted MCP server.`,categories:[categoryBySlug[entry.slug]??"other"],featured:entry.slug==="jira",branding:brandingFor(entry.slug),urlPatterns:[`${new URL(entry.serverUrl).origin}/*`],docsUrl:entry.docsUrl,redirectConstraints:methods.some((entryMethod)=>entryMethod.auth==="oauth")?"https-or-loopback-http":undefined,methods:methods.map((entryMethod)=>warnings.length>0?{...entryMethod,warnings:[...(entryMethod.warnings??[]),...warnings]}:entryMethod)});
}
const parseTableRow=(line)=>line.slice(1,-1).split("|").map((cell)=>cell.trim());
const parseCapture=(fileName)=>{
 const markdown=fs.readFileSync(path.join(corpus,fileName),"utf8");
 const stateMatches=[...markdown.matchAll(/^## State: (.+)$/gm)];
 if(stateMatches.length===0) throw new Error(`${fileName}: no captured states`);
 return stateMatches.map((match,index)=>{
  const body=markdown.slice(match.index+match[0].length,stateMatches[index+1]?.index??markdown.length);
  const inputsBlock=body.match(/### Inputs\n([\s\S]*?)(?=\n### |$)/)?.[1]??"";
  const inputRows=inputsBlock.split("\n").filter((line)=>line.startsWith("|")).slice(2).map(parseTableRow);
  const fields=inputRows.map(([label,tagType,required,placeholder,prefilledValue,checked])=>({label,tagType,required:required.toLowerCase()==="yes",placeholder:placeholder||null,prefilledValue:prefilledValue||null,checked:checked.toLowerCase()==="true"}));
  const linksBlock=body.match(/### Links\n([\s\S]*?)(?=\n## |$)/)?.[1]??"";
  const links=linksBlock.split("\n").map((line)=>line.match(/^(.+?) → (https?:\/\/\S+)$/)).filter(Boolean).map((link)=>({label:link[1].trim(),href:link[2]}));
  return {label:match[1].trim(),fields,links};
 });
};
const inferState=(slug,state)=>{
 const label=state.label.toLowerCase();
 const fieldText=state.fields.map((field)=>field.label.toLowerCase()).join(" ");
 const transport=slug==="oauth-generic"||slug==="api-key-generic"||label.includes("path: api")||label.includes("api key form")?"rest_api":"mcp_remote";
 const auth=slug==="oauth-generic"||label.includes("oauth")||fieldText.includes("client id")?"oauth":slug==="api-key-generic"||label.includes("api key")||fieldText.includes("api key")?"api_key":null;
 const ownershipModes=[];
 if(label.includes("managed")) ownershipModes.push("platform_shared");
 if(label.includes("your own credentials")||label.includes("manual")||label.includes("api key")) ownershipModes.push("customer");
 if(slug==="oauth-generic"&&!label.includes("manually")) ownershipModes.push("dcr");
 return {label:state.label,transport,auth,ownershipModes:[...new Set(ownershipModes)],fieldCount:state.fields.length,linkCount:state.links.length};
};
const validateApp=(app)=>{
 if(app.schemaVersion!==1||!app.slug||!app.name||!Array.isArray(app.methods)||app.methods.length===0) throw new Error(`${app.slug||"unknown"}: invalid AppDefinition`);
 for(const connectionMethod of app.methods){
  if(connectionMethod.auth==="api_key"&&!connectionMethod.keyPlacement) throw new Error(`${app.slug}/${connectionMethod.key}: api_key requires keyPlacement`);
  if(connectionMethod.auth==="oauth"&&connectionMethod.ownershipModes.length===0) throw new Error(`${app.slug}/${connectionMethod.key}: oauth requires ownershipModes`);
  for(const connectionField of [...connectionMethod.tenantFields??[],...connectionMethod.extensionFields??[],...connectionMethod.credentialFields??[]]) if(connectionField.required&&connectionField.type!=="checkbox"&&!connectionField.placeholder) throw new Error(`${app.slug}/${connectionMethod.key}/${connectionField.key}: required field needs placeholder`);
 }
};
const captureFiles=fs.readdirSync(corpus).filter((fileName)=>fileName.endsWith(".md")&&fileName!=="INDEX.md").sort();
if(captureFiles.length!==99) throw new Error(`Expected 99 captures, found ${captureFiles.length}`);
const parsedCaptures=Object.fromEntries(captureFiles.map((fileName)=>[path.basename(fileName,".md"),parseCapture(fileName)]));
const reviewReport={schemaVersion:1,corpusSize:captureFiles.length,providers:captureFiles.map((fileName)=>{const slug=path.basename(fileName,".md");const states=parsedCaptures[slug].map((state)=>inferState(slug,state));return {slug,stateCount:states.length,states,ambiguities:states.filter((state)=>!state.auth).map((state)=>`Auth is not explicit in capture state: ${state.label}`)};})};
for(const app of apps){validateApp(app);if(parsedCaptures[app.slug]&&parsedCaptures[app.slug].length===0) throw new Error(`${app.slug}: capture has no states`);}
fs.mkdirSync(out,{recursive:true}); for(const app of apps) fs.writeFileSync(path.join(out,`${app.slug}.json`),JSON.stringify(app,null,2)+"\n");
fs.writeFileSync(path.join(root,"packages/shared/src/app-definitions.ingestion-report.json"),JSON.stringify(reviewReport,null,2)+"\n");
const imports=apps.map((a,i)=>`import a${i} from "./app-definitions/${a.slug}.json" with { type: "json" };`).join("\n");
fs.writeFileSync(path.join(root,"packages/shared/src/app-definitions.generated.ts"),`${imports}\nimport type { AppDefinition } from "./types/app-definition.js";\nexport const APP_DEFINITIONS=[${apps.map((_,i)=>`a${i}`).join(",")}] as AppDefinition[];\n`);
const ambiguityCount=reviewReport.providers.reduce((total,provider)=>total+provider.ambiguities.length,0);
console.log(`Parsed ${captureFiles.length} captures and ${reviewReport.providers.reduce((total,provider)=>total+provider.stateCount,0)} states; emitted ${apps.length} Wave 1 definitions and flagged ${ambiguityCount} states for review.`);
