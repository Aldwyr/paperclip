// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileText, SlidersHorizontal } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidePanelTabs } from "./SidePanelTabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

describe("SidePanelTabs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.scrollIntoView = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function renderTabs(
    activeTabId = "properties",
    onCloseTab = vi.fn(),
    onActiveTabChange = vi.fn(),
    onReorderTabs = vi.fn(),
  ) {
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
            onActiveTabChange={onActiveTabChange}
            onCloseTab={onCloseTab}
            onReorderTabs={onReorderTabs}
            onAddTab={vi.fn()}
          />
        </TooltipProvider>,
      );
    });
    return { tabs, onCloseTab, onActiveTabChange, onReorderTabs };
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

  it("navigates with Arrow, Home, and End keys", () => {
    const onActiveTabChange = vi.fn();
    renderTabs("properties", vi.fn(), onActiveTabChange);
    const properties = container.querySelector<HTMLButtonElement>('[data-side-panel-tab-target="properties"]')!;
    act(() => properties.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })));
    expect(onActiveTabChange).toHaveBeenCalledWith("document:plan");

    const plan = container.querySelector<HTMLButtonElement>('[data-side-panel-tab-target="document:plan"]')!;
    act(() => plan.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" })));
    expect(onActiveTabChange).toHaveBeenLastCalledWith("properties");
  });

  it("announces and performs keyboard reordering", () => {
    const onReorderTabs = vi.fn();
    renderTabs("document:plan", vi.fn(), vi.fn(), onReorderTabs);
    const plan = container.querySelector<HTMLButtonElement>('[data-side-panel-tab-target="document:plan"]')!;
    act(() => plan.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "ArrowLeft",
      altKey: true,
      shiftKey: true,
    })));
    expect(onReorderTabs).toHaveBeenCalledWith(["document:plan", "properties"]);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("Moved Plan to position 1 of 2");
  });

  it("recovers focus to the right neighbor after close", () => {
    renderTabs("properties");
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close Properties"]')!;
    act(() => close.click());
    expect(document.activeElement).toBe(container.querySelector('[data-side-panel-tab-target="document:plan"]'));
  });
});
