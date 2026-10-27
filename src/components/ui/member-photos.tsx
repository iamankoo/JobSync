"use client";

import { createContext, useContext } from "react";
import type { MemberId } from "@/config/members";

/** Version (stored FileID) of each member's uploaded professional photo, decided on the server per request. */
export type PhotoVersions = Partial<Record<MemberId, string>>;

const PhotoVersionsContext = createContext<PhotoVersions>({});

export function MemberPhotosProvider({ versions, children }: { versions: PhotoVersions; children: React.ReactNode }) {
  return <PhotoVersionsContext.Provider value={versions}>{children}</PhotoVersionsContext.Provider>;
}

/** The uploaded photo's URL for `memberId`, or null to use the built-in photo (also outside the signed-in app). */
export function useUploadedPhoto(memberId: MemberId): string | null {
  const v = useContext(PhotoVersionsContext)[memberId];
  return v ? `/api/members/${memberId}/photo?v=${encodeURIComponent(v)}` : null;
}
