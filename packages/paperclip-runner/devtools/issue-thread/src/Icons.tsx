export type IconName =
  | "activity" | "branch" | "close" | "download" | "evidence" | "pause"
  | "play" | "reset" | "spark" | "stop" | "terminal";

const PATHS: Record<IconName, string> = {
  activity: "M3 12h3l2-6 4 12 3-9 2 5h4",
  branch: "M6 3v12a3 3 0 0 0 3 3h6M15 18l-3-3m3 3-3 3M6 7h6a3 3 0 0 0 3-3V3",
  close: "M5 5l14 14M19 5 5 19",
  download: "M12 3v12m-5-5 5 5 5-5M5 21h14",
  evidence: "M4 5h16v14H4zM8 9h8M8 13h5",
  pause: "M8 5v14M16 5v14",
  play: "M8 5v14l11-7z",
  reset: "M5 8a8 8 0 1 1-1 7M5 8V3m0 5h5",
  spark: "M12 2l1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  stop: "M7 7h10v10H7z",
  terminal: "M5 7l4 5-4 5m7 0h7",
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="pit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
