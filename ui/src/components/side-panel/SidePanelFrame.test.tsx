// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidePanelFrame, SidePanelToggleButton, SidePanelWindowControls } from "./SidePanelFrame";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("side-panel shell controls", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("exposes controlled presentation, visibility, maximize, and content layout state", async () => {
    await act(async () => root.render(
      <SidePanelFrame presentation="sheet" open={false} maximized resizing contentMode="full-bleed">
        Body
      </SidePanelFrame>,
    ));
    const frame = container.querySelector("section")!;
    expect(frame.getAttribute("data-presentation")).toBe("sheet");
    expect(frame.getAttribute("data-maximized")).toBe("true");
    expect(frame.getAttribute("data-resizing")).toBe("true");
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.firstElementChild?.className).toContain("overflow-hidden");
  });

  it("reports toggle, maximize, restore, and panel-toggle actions", async () => {
    const onToggle = vi.fn();
    const onMaximizedChange = vi.fn();
    const onWindowToggle = vi.fn();
    await act(async () => root.render(
      <TooltipProvider>
        <SidePanelToggleButton open={false} onToggle={onToggle} shortcut="]" />
        <SidePanelWindowControls maximized={false} onMaximizedChange={onMaximizedChange} onToggle={onWindowToggle} />
      </TooltipProvider>,
    ));
    const toggleButtons = container.querySelectorAll<HTMLButtonElement>('[aria-label="Toggle side panel"]');
    expect(toggleButtons).toHaveLength(2);
    expect(toggleButtons[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(toggleButtons[1]?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => toggleButtons[0]?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Maximize side panel"]')?.click());
    await act(async () => toggleButtons[1]?.click());
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onMaximizedChange).toHaveBeenCalledWith(true);
    expect(onWindowToggle).toHaveBeenCalledOnce();
  });
});
