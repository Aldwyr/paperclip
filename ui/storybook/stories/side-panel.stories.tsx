import { useMemo, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import {
  Activity,
  Box,
  FileCode2,
  FileText,
  FolderOpen,
  History,
  Info,
  Lightbulb,
  Plus,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SidePanelFrame,
  SidePanelLauncher,
  SidePanelTabs,
  SidePanelToggleButton,
  SidePanelWindowControls,
  useSidePanelTabs,
  type SidePanelContentMode,
  type SidePanelLauncherItem,
  type SidePanelLauncherSection,
  type SidePanelPresentation,
  type SidePanelTabItem,
  type SidePanelTabRecord,
} from "@/components/side-panel";

type DemoPayload = { body: string };

const DEMO_TABS: SidePanelTabRecord<DemoPayload>[] = [
  { id: "properties", type: "properties", label: "Properties", payload: { body: "Structured metadata and controls." } },
  { id: "document:plan", type: "plan", label: "Plan", payload: { body: "A readable plan document with annotations." } },
  { id: "artifacts", type: "artifacts", label: "Artifacts", payload: { body: "Work products, documents, and generated files." } },
  { id: "document:review", type: "document", label: "2026-08-23-paperclip-runner-stress-campaign.md", payload: { body: "A deliberately long document title demonstrates truncation." } },
  { id: "files", type: "files", label: "Files", payload: { body: "Browse the active workspace." }, contentMode: "full-bleed" },
  { id: "file:driver", type: "file", label: "codex-driver.md", payload: { body: "Workspace file preview." }, contentMode: "full-bleed" },
];

function iconFor(type: string): ReactNode {
  if (type === "properties") return <SlidersHorizontal />;
  if (type === "plan") return <Lightbulb />;
  if (type === "artifacts") return <Box />;
  if (type === "files") return <FolderOpen />;
  if (type === "file") return <FileCode2 />;
  if (type === "activity") return <Activity />;
  if (type === "history") return <History />;
  if (type === "settings") return <Settings />;
  if (type === "info") return <Info />;
  return <FileText />;
}

function visualTabs(tabs: SidePanelTabRecord<DemoPayload>[]): SidePanelTabItem[] {
  return tabs.map((tab) => ({
    id: tab.id,
    type: tab.type,
    label: tab.label,
    ariaLabel: tab.ariaLabel,
    closable: tab.closable ?? true,
    contentMode: tab.contentMode,
    icon: iconFor(tab.type),
  }));
}

const LAUNCHER_SECTIONS: SidePanelLauncherSection[] = [
  {
    id: "views",
    label: "Open",
    items: [
      { id: "properties", label: "Properties", icon: <SlidersHorizontal /> },
      { id: "artifacts", label: "Artifacts", icon: <Box /> },
      { id: "files", label: "Files", icon: <FolderOpen />, shortcut: "G F" },
    ],
  },
  {
    id: "suggested",
    label: "Suggested",
    items: [
      { id: "document:plan", label: "Plan", description: "Task document", icon: <Lightbulb /> },
      { id: "document:review", label: "2026-08-23-paperclip-runner-stress-campaign.md", description: "Updated moments ago", icon: <FileText /> },
      { id: "file:driver", label: "codex-driver.md", description: "ui/src/components", icon: <FileCode2 /> },
    ],
  },
];

interface SidePanelStoryArgs {
  width: number;
  presentation: SidePanelPresentation;
  contentMode: SidePanelContentMode;
  maximized: boolean;
  open: boolean;
  initialTabCount: number;
  initialActiveTabId: string;
  empty: boolean;
  launcherOpen: boolean;
  dark: boolean;
}

function DemoContent({ tab }: { tab: SidePanelTabRecord<DemoPayload> }) {
  if (tab.contentMode === "full-bleed") {
    return (
      <div className="flex h-full min-h-72 bg-muted/30 p-3">
        <div className="w-2/5 rounded-lg border border-border bg-card p-3">
          <div className="text-xs font-medium text-muted-foreground">Workspace</div>
          <div className="mt-3 space-y-1 text-sm">
            <div className="rounded-md bg-accent px-2 py-1">ui/src/components</div>
            <div className="px-2 py-1">server/src/routes</div>
            <div className="px-2 py-1">packages/shared</div>
          </div>
        </div>
        <div className="min-w-0 flex-1 p-4 font-mono text-xs leading-6 text-muted-foreground">
          {tab.payload.body}
          <br />
          export function PortableSidePanel() &#123;
          <br />&nbsp;&nbsp;return &quot;content&quot;;
          <br />&#125;
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tab.type}</div>
        <h2 className="mt-1 text-lg font-semibold">{tab.label}</h2>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">{tab.payload.body}</p>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="rounded-lg border border-border p-3 text-sm">
          Portable content row {index + 1}
        </div>
      ))}
    </div>
  );
}

function SidePanelStoryHarness(args: SidePanelStoryArgs) {
  const initialTabs = args.empty ? [] : DEMO_TABS.slice(0, args.initialTabCount);
  const controller = useSidePanelTabs<DemoPayload>({
    initialState: {
      tabs: initialTabs,
      activeTabId: initialTabs.some((tab) => tab.id === args.initialActiveTabId)
        ? args.initialActiveTabId
        : initialTabs[0]?.id ?? null,
    },
  });
  const [panelOpen, setPanelOpen] = useState(args.open);
  const [maximized, setMaximized] = useState(args.maximized);
  const [launcherOpen, setLauncherOpen] = useState(args.launcherOpen);
  const activeTab = controller.tabs.find((tab) => tab.id === controller.activeTabId) ?? null;
  const tabs = useMemo(() => visualTabs(controller.tabs), [controller.tabs]);
  const launcherSections = useMemo(
    () => LAUNCHER_SECTIONS.map((section) => ({
      ...section,
      items: section.items.map((item) => ({
        ...item,
        alreadyOpen: controller.tabs.some((tab) => tab.id === item.id),
      })),
    })),
    [controller.tabs],
  );

  function openLauncherItem(item: SidePanelLauncherItem) {
    const tab = DEMO_TABS.find((candidate) => candidate.id === item.id);
    if (tab) controller.openTab(tab);
  }

  const launcher = (
    <SidePanelLauncher
      sections={launcherSections}
      onSelect={openLauncherItem}
      presentation="popover"
      open={launcherOpen}
      onOpenChange={setLauncherOpen}
      trigger={(
        <Button type="button" variant="ghost" size="icon-sm" className="shrink-0 rounded-xl" aria-label="Open a new tab">
          <Plus aria-hidden />
        </Button>
      )}
    />
  );

  const frame = (
    <div className="flex h-screen min-h-96 justify-end bg-background text-foreground">
      <div className="min-w-0 flex-1 p-8">
        <div className="flex items-center justify-between border-b border-border pb-4">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Host application</div>
            <h1 className="mt-1 text-xl font-semibold">Portable side-panel preview</h1>
          </div>
          <SidePanelToggleButton open={panelOpen} onToggle={() => setPanelOpen((current) => !current)} shortcut="]" />
        </div>
      </div>
      <div
        className="shrink-0"
        style={{ width: maximized ? "min(72rem, 100vw)" : args.width }}
      >
        <SidePanelFrame
          presentation={args.presentation}
          open={panelOpen}
          maximized={maximized}
          contentMode={activeTab?.contentMode ?? args.contentMode}
          header={(
            <SidePanelTabs
              tabs={tabs}
              activeTabId={controller.activeTabId}
              onActiveTabChange={controller.selectTab}
              onCloseTab={controller.closeTab}
              onReorderTabs={controller.reorderTabs}
              addControl={launcher}
            />
          )}
          trailingControls={(
            <SidePanelWindowControls
              maximized={maximized}
              onMaximizedChange={setMaximized}
              onClose={() => setPanelOpen(false)}
            />
          )}
        >
          {activeTab ? (
            <DemoContent tab={activeTab} />
          ) : (
            <SidePanelLauncher sections={launcherSections} onSelect={openLauncherItem} />
          )}
        </SidePanelFrame>
      </div>
    </div>
  );

  return <div className={args.dark ? "dark" : undefined}>{frame}</div>;
}

const meta = {
  title: "Navigation/Side Panel",
  component: SidePanelStoryHarness,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Portable, controlled Codex-style side-panel components. Hosts own tab payloads, persistence, data fetching, routing, and content rendering; the shared layer owns panel presentation and interaction mechanics.",
      },
    },
  },
  args: {
    width: 380,
    presentation: "docked",
    contentMode: "padded",
    maximized: false,
    open: true,
    initialTabCount: 3,
    initialActiveTabId: "document:plan",
    empty: false,
    launcherOpen: false,
    dark: false,
  },
  argTypes: {
    width: { control: { type: "range", min: 260, max: 760, step: 20 } },
    presentation: { control: "inline-radio", options: ["docked", "sheet", "embedded"] },
    contentMode: { control: "inline-radio", options: ["padded", "prose", "full-bleed"] },
    initialTabCount: { control: { type: "range", min: 0, max: DEMO_TABS.length, step: 1 } },
    initialActiveTabId: { control: "select", options: DEMO_TABS.map((tab) => tab.id) },
  },
} satisfies Meta<typeof SidePanelStoryHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultDocked: Story = {};

export const MixedResourceTabs: Story = {
  args: { width: 680, initialTabCount: 6, initialActiveTabId: "document:review" },
};

export const NarrowOverflow: Story = {
  args: { width: 260, initialTabCount: 6, initialActiveTabId: "file:driver" },
};

export const EmptyPanel: Story = {
  args: { empty: true, initialTabCount: 0 },
};

export const LauncherOpen: Story = {
  args: { launcherOpen: true, initialTabCount: 4 },
};

export const MaximizedDocument: Story = {
  args: { maximized: true, contentMode: "prose", initialTabCount: 4, initialActiveTabId: "document:review" },
};

export const FullBleedFile: Story = {
  args: { width: 620, initialTabCount: 6, initialActiveTabId: "file:driver", contentMode: "full-bleed" },
};

export const DarkAppearance: Story = {
  args: { dark: true, width: 560, initialTabCount: 5 },
};

export const MobileSheet: Story = {
  args: { presentation: "sheet", width: 390, initialTabCount: 6, initialActiveTabId: "document:plan" },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

export const KeyboardNavigationAndClose: Story = {
  args: { width: 620, initialTabCount: 4, initialActiveTabId: "properties" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const properties = await canvas.findByRole("tab", { name: "Properties" });
    properties.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("tab", { name: "Plan" })).toHaveFocus();
    await userEvent.click(canvas.getByRole("button", { name: "Close Plan" }));
    await expect(canvas.queryByRole("tab", { name: "Plan" })).not.toBeInTheDocument();
  },
};

function LauncherEdgeStatesHarness() {
  return (
    <div className="grid min-h-screen gap-6 bg-background p-6 text-foreground md:grid-cols-3">
      <SidePanelLauncher
        title="Loading section"
        sections={[{ id: "loading", label: "Recent files", loading: true, items: [] }]}
        onSelect={() => {}}
      />
      <SidePanelLauncher
        title="Partial failure"
        sections={[
          { id: "open", label: "Open", items: LAUNCHER_SECTIONS[0]!.items },
          { id: "error", label: "Recent files", error: "Recent files are temporarily unavailable.", items: [] },
        ]}
        onSelect={() => {}}
      />
      <SidePanelLauncher
        title="Disabled and open items"
        sections={[{
          id: "states",
          items: [
            { id: "open", label: "Properties", alreadyOpen: true, icon: <SlidersHorizontal /> },
            { id: "disabled", label: "Files", disabled: true, disabledReason: "No workspace is attached.", icon: <FolderOpen /> },
          ],
        }]}
        onSelect={() => {}}
      />
    </div>
  );
}

export const LauncherLoadingErrorAndDisabled: StoryObj = {
  render: () => <LauncherEdgeStatesHarness />,
};

function NonTaskHarness() {
  const tabs: SidePanelTabRecord<DemoPayload>[] = [
    { id: "details", type: "info", label: "Details", payload: { body: "Reusable outside task pages." }, closable: false },
    { id: "activity", type: "activity", label: "Activity", payload: { body: "Application activity." } },
    { id: "history", type: "history", label: "History", payload: { body: "Version history." } },
    { id: "settings", type: "settings", label: "Settings", payload: { body: "Local settings." } },
  ];
  const controller = useSidePanelTabs({ initialState: { tabs, activeTabId: "details" } });
  const active = controller.tabs.find((tab) => tab.id === controller.activeTabId)!;
  return (
    <div className="mx-auto h-screen max-w-xl bg-background p-6 text-foreground">
      <SidePanelFrame
        presentation="embedded"
        header={(
          <SidePanelTabs
            tabs={visualTabs(controller.tabs)}
            activeTabId={controller.activeTabId}
            onActiveTabChange={controller.selectTab}
            onCloseTab={controller.closeTab}
            onReorderTabs={controller.reorderTabs}
          />
        )}
      >
        <DemoContent tab={active} />
      </SidePanelFrame>
    </div>
  );
}

export const NonTaskComposition: StoryObj = {
  render: () => <NonTaskHarness />,
};
