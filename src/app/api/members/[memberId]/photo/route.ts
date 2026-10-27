import { MEMBER_IDS, type MemberId } from "@/config/members";
import { protectedRoute } from "@/lib/api/protected-route";
import { ApiError } from "@/lib/api/responses";
import { loadPhoto } from "@/lib/google-sheets/member-files-service";

/**
 * A member's uploaded professional photo, for avatars across the app. Viewable by any signed-in, active teammate
 * (avatars are shown team-wide, like the built-in photos); only the owner can change it (POST /api/profile/photo).
 */
export const GET = protectedRoute<{ memberId: string }>(async ({ params }) => {
  if (!(MEMBER_IDS as readonly string[]).includes(params.memberId)) throw new ApiError(404, "member_file_not_found", "No photo uploaded.");
  const { mimeType, bytes } = await loadPhoto(params.memberId as MemberId);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      // The URL carries the photo's version (?v=), so a replaced photo is a new URL.
      "Cache-Control": "private, max-age=86400",
    },
  });
});
