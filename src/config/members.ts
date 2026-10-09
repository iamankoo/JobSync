export const MEMBER_IDS = ["anni", "lukky", "rishii"] as const;
export type MemberId = (typeof MEMBER_IDS)[number];

export interface Member {
  id: MemberId;
  name: string;
  photo: string;
  /** Accent colour (hex) used for the member's themed UI. */
  accent: string;
  /** Lighter variant for text on dark backgrounds (WCAG AA). */
  accentText: string;
}

/** Public member profile data. Contains no secrets. */
export const MEMBERS: readonly Member[] = [
  { id: "anni", name: "Anni", photo: "/assets/anni.jpeg", accent: "#2f6bff", accentText: "#7ba3ff" },
  { id: "lukky", name: "Lukky", photo: "/assets/lukky.jpeg", accent: "#f5c518", accentText: "#f5c518" },
  { id: "rishii", name: "Rishii", photo: "/assets/rishii.jpeg", accent: "#ff4d5e", accentText: "#ff7a87" },
];

export function getMember(id: string): Member | undefined {
  return MEMBERS.find((m) => m.id === id);
}
