export const MEMBER_IDS = ["anni", "lukky", "rishii"] as const;
export type MemberId = (typeof MEMBER_IDS)[number];

export interface Member {
  id: MemberId;
  name: string;
  photo: string;
  /** Natural pixel size of the photo file. */
  photoSize: { width: number; height: number };
  /**
   * Square region of the photo (in source pixels) shown inside the round avatar. It may extend
   * beyond the image edges (zoom-out); the overflow is filled with a blurred copy of the photo.
   */
  photoCrop: { x: number; y: number; size: number };
  /** Accent colour (hex) used for the member's themed UI. */
  accent: string;
  /** Lighter variant for text on dark backgrounds (WCAG AA). */
  accentText: string;
}

/** Public member profile data. Contains no secrets. */
export const MEMBERS: readonly Member[] = [
  { id: "anni", name: "Anni", photo: "/assets/anni.jpeg", photoSize: { width: 577, height: 1280 }, photoCrop: { x: -60, y: 139, size: 680 }, accent: "#2f6bff", accentText: "#7ba3ff" },
  { id: "lukky", name: "Lukky", photo: "/assets/lukky.jpeg", photoSize: { width: 1300, height: 1600 }, photoCrop: { x: 0, y: 0, size: 1150 }, accent: "#f5c518", accentText: "#f5c518" },
  { id: "rishii", name: "Rishii", photo: "/assets/rishii.jpeg", photoSize: { width: 899, height: 1599 }, photoCrop: { x: 0, y: 349, size: 899 }, accent: "#ff4d5e", accentText: "#ff7a87" },
];

export function getMember(id: string): Member | undefined {
  return MEMBERS.find((m) => m.id === id);
}
