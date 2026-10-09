import { Briefcase } from "lucide-react";

export function Logo({ size = "md", tagline = false }: { size?: "md" | "lg"; tagline?: boolean }) {
  const lg = size === "lg";
  return (
    <div className="flex items-center gap-3">
      <span className="grid place-items-center rounded-xl border-2 border-electric text-electric" style={{ width: lg ? 56 : 40, height: lg ? 56 : 40 }}>
        <Briefcase size={lg ? 30 : 22} aria-hidden />
      </span>
      <span>
        <span className={`block font-bold leading-none ${lg ? "text-5xl" : "text-2xl"}`}>
          Job<span className="text-electric-soft">Sync</span>
        </span>
        {tagline && <span className="mt-1 block text-xs text-muted">Your Team&apos;s Job Hunt, Together</span>}
      </span>
    </div>
  );
}
