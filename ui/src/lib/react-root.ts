import { createRoot, type Root } from "react-dom/client";

type PaperclipGlobal = typeof globalThis & {
  __paperclipReactRoots?: WeakMap<HTMLElement, Root>;
};

export function getOrCreateReactRoot(container: HTMLElement): Root {
  const sharedGlobal = globalThis as PaperclipGlobal;
  const roots = (sharedGlobal.__paperclipReactRoots ??= new WeakMap());
  const existingRoot = roots.get(container);
  if (existingRoot) return existingRoot;

  const root = createRoot(container);
  roots.set(container, root);
  return root;
}
