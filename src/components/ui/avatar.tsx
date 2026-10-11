import Image from "next/image";
import type { Member } from "@/config/members";

/** Round profile photo framed by the member's configured crop (see `photoCrop` in config/members.ts). */
export function Avatar({ member, size, ring = false }: { member: Member; size: number; ring?: boolean }) {
  const { photoSize, photoCrop } = member;
  const scale = size / photoCrop.size;
  const outside =
    photoCrop.x < 0 ||
    photoCrop.y < 0 ||
    photoCrop.x + photoCrop.size > photoSize.width ||
    photoCrop.y + photoCrop.size > photoSize.height;

  return (
    <span
      className="relative block shrink-0 overflow-hidden rounded-full bg-navy-800"
      style={{ width: size, height: size, boxShadow: ring ? `0 0 0 2px ${member.accent}` : undefined }}
    >
      {outside && (
        // Margin fill: the same photo, vertically aligned with the main image and stretched
        // across the circle's width, so side margins continue the photo's own edge colours.
        <Image
          src={member.photo}
          alt=""
          aria-hidden
          width={size}
          height={Math.round(photoSize.height * scale)}
          className="absolute max-w-none blur-[6px]"
          style={{ left: 0, top: -photoCrop.y * scale, width: size, height: Math.round(photoSize.height * scale) }}
        />
      )}
      <Image
        src={member.photo}
        alt=""
        width={Math.round(photoSize.width * scale)}
        height={Math.round(photoSize.height * scale)}
        className="absolute max-w-none"
        style={{
          left: -photoCrop.x * scale,
          top: -photoCrop.y * scale,
          width: Math.round(photoSize.width * scale),
          height: Math.round(photoSize.height * scale),
        }}
      />
    </span>
  );
}
