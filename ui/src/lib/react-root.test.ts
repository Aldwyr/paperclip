import { beforeEach, describe, expect, it, vi } from "vitest";

const createRootMock = vi.hoisted(() => vi.fn());

vi.mock("react-dom/client", () => ({
  createRoot: createRootMock,
}));

import { getOrCreateReactRoot } from "./react-root";

describe("getOrCreateReactRoot", () => {
  beforeEach(() => {
    createRootMock.mockReset();
  });

  it("reuses the root when the application entry module is evaluated again", () => {
    const root = { render: vi.fn(), unmount: vi.fn() };
    createRootMock.mockReturnValue(root);
    const container = {} as HTMLElement;

    expect(getOrCreateReactRoot(container)).toBe(root);
    expect(getOrCreateReactRoot(container)).toBe(root);
    expect(createRootMock).toHaveBeenCalledOnce();
    expect(createRootMock).toHaveBeenCalledWith(container);
  });
});
