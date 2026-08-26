import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const TILE_COLORS = [
  "bg-(--app-logo-tile-1)",
  "bg-(--app-logo-tile-2)",
  "bg-(--app-logo-tile-3)",
  "bg-(--app-logo-tile-4)",
  "bg-(--app-logo-tile-5)",
  "bg-(--app-logo-tile-6)",
  "bg-(--app-logo-tile-7)",
  "bg-(--app-logo-tile-8)",
];

function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length]!;
}

interface AppLogoProps {
  name: string;
  logoUrl?: string | null;
  darkLogoUrl?: string | null;
  size?: number;
  className?: string;
}

/**
 * App icon for the gallery and connected-apps surfaces. Renders the manifest
 * official local provider mark when available, including a dark-mode variant.
 * The deterministic letter tile is reserved for runtime image failures.
 */
export function AppLogo({ name, logoUrl, darkLogoUrl, size = 36, className }: AppLogoProps) {
  const [failed, setFailed] = useState(false);
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  const dimension = { width: size, height: size };

  useEffect(() => setFailed(false), [darkLogoUrl, logoUrl]);

  if (logoUrl && !failed) {
    return (
      <span
        className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted", className)}
        style={dimension}
      >
        <img
          src={logoUrl}
          alt=""
          width={size}
          height={size}
          className={cn("h-full w-full object-contain p-1.5", darkLogoUrl && "dark:hidden")}
          onError={() => setFailed(true)}
        />
        {darkLogoUrl ? (
          <img
            src={darkLogoUrl}
            alt=""
            width={size}
            height={size}
            className="hidden h-full w-full object-contain p-1.5 dark:block"
            onError={() => setFailed(true)}
          />
        ) : null}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white",
        colorFor(name),
        className,
      )}
      style={dimension}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}
