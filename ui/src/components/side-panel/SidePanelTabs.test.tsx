// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileText, SlidersHorizontal } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidePanelTabs } from "./SidePanelTabs";

describe("SidePanelTabs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function renderTabs(activeTabId = "properties", onCloseTab = vi.fn()) {
    const tabs = [
      { id: "properties", type: "view", label: "Properties", icon: <SlidersHorizontal />, closable: true },
      { id: "document:plan", type: "document", label: "Plan", icon: <FileText />, closable: true },
    ];
    act(() => {
      root.render(
        <TooltipProvider>
          <SidePanelTabs
            tabs={tabs}
            activeTabId={activeTabId}
            onActiveTabChange={vi.fn()}
            onCloseTab={onCloseTab}
            onReorderTabs={vi.fn()}
            onAddTab={vi.fn()}
          />
        </TooltipProvider>,
      );
    });
    return { tabs, onCloseTab };
  }

  it("renders accessible tabs and the anchored add action", () => {
    renderTabs();
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");
    expect(container.querySelector('button[aria-label="Open a new tab"]')).not.toBeNull();
  });

  it("closes a tab with its named close action", () => {
    const onCloseTab = vi.fn();
    renderTabs("properties", onCloseTab);
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close Properties"]');
    act(() => close?.click());
    expect(onCloseTab).toHaveBeenCalledWith("properties");
  });

  it("supports middle-click close", () => {
    const onCloseTab = vi.fn();
    renderTabs("properties", onCloseTab);
    const tab = container.querySelector<HTMLButtonElement>('#side-panel-tab-document\\:plan');
    act(() => tab?.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 })));
    expect(onCloseTab).toHaveBeenCalledWith("document:plan");
  });
});
