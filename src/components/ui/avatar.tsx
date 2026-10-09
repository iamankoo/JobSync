import Image from "next/image";
import type { Member } from "@/config/members";

export function Avatar({ member, size, ring = false }: { member: Member; size: number; ring?: boolean }) {
  return (
    <Image
      src={member.photo}
      alt=""
      width={size}
      height={size}
      className="rounded-full object-cover"
      style={{ width: size, height: size, boxShadow: ring ? `0 0 0 2px ${member.accent}` : undefined }}
    />
  );
}
