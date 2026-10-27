export const MEMBER_IDS = ["anni", "lukky", "rishii"] as const;
export type MemberId = (typeof MEMBER_IDS)[number];

export interface Member {
  id: MemberId;
  name: string;
  /** Full name used to sign Network Finder email drafts (the app itself shows `name`). */
  fullName: string;
  /** Public profile links appended to the signature of this member's email drafts. */
  linkedinUrl: string;
  githubUrl: string;
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
  { id: "anni", name: "Anni", fullName: "Aniket Raj", linkedinUrl: "https://www.linkedin.com/in/raj-aniket/", githubUrl: "https://github.com/iamankoo", photo: "/assets/anni.jpeg", photoSize: { width: 577, height: 1280 }, photoCrop: { x: -60, y: 139, size: 680 }, accent: "#2f6bff", accentText: "#7ba3ff" },
  { id: "lukky", name: "Lukky", fullName: "Lakshya Singh", linkedinUrl: "https://www.linkedin.com/in/lakshya-singh-243510302/", githubUrl: "https://github.com/lukkydiwan", photo: "/assets/lukky.jpeg", photoSize: { width: 1300, height: 1600 }, photoCrop: { x: 0, y: 0, size: 1150 }, accent: "#f5c518", accentText: "#f5c518" },
  { id: "rishii", name: "Rishii", fullName: "Rishi Raj", linkedinUrl: "https://www.linkedin.com/in/rishi-raj-8bb5a8366/", githubUrl: "https://github.com/Rishi-Ra-1j4", photo: "/assets/rishii.jpeg", photoSize: { width: 899, height: 1599 }, photoCrop: { x: 0, y: 349, size: 899 }, accent: "#ff4d5e", accentText: "#ff7a87" },
];

export function getMember(id: string): Member | undefined {
  return MEMBERS.find((m) => m.id === id);
}
