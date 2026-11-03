"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { isRoleCategory, ROLE_CATEGORIES, rolesFor, type RoleCategory } from "@/lib/connections/apply-role";

/**
 * Role to Apply as ONE two-step dropdown: the categories first, then (same panel) that category's roles with a Back item
 * on top. Choosing a role closes the panel; "Other" closes it and the form shows the custom role input. The value is the same
 * pair the form always saved ({ roleCategory, applyRole }); validation lives in lib/connections/apply-role.ts.
 */
export interface RolePickerProps {
  id: string;
  labelId: string;
  category: string;
  role: string;
  invalid?: boolean;
  describedBy?: string;
  onChange: (next: { category: string; role: string }) => void;
}

const item = "block w-full px-3 py-2 text-left text-sm text-ink outline-none transition hover:bg-navy-800 focus-visible:bg-navy-800";

export function RolePicker({ id, labelId, category, role, invalid, describedBy, onChange }: RolePickerProps) {
  const [open, setOpen] = useState(false);
  // Which list the panel shows, and the category whose roles are listed. Nothing is saved until a role (or Other) is chosen.
  const [pending, setPending] = useState<RoleCategory | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The menu opens ABOVE the field; its height is capped to the room between the field and the top of the modal
  // (or the screen), and longer lists scroll inside it.
  const [maxHeight, setMaxHeight] = useState(288);

  const close = (refocus = false) => {
    setOpen(false);
    setPending(null);
    if (refocus) triggerRef.current?.focus();
  };

  // Clicking outside closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    // The nearest scrolling ancestor (the modal body) is what would clip the menu.
    let scroller: HTMLElement | null = rootRef.current?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const room = () => triggerRef.current!.getBoundingClientRect().top - Math.max(scroller?.getBoundingClientRect().top ?? 0, 0) - 12;
    const fit = () => {
      // Scrolled so far down that little room is left above the field: scroll back up a little to make room.
      if (scroller && room() < 200 && scroller.scrollTop > 0) scroller.scrollTop -= Math.min(scroller.scrollTop, 200 - room());
      setMaxHeight(Math.max(120, Math.min(288, room())));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);

  // Focus moves into the panel whenever a list is shown (first item: Back, or the first category).
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, pending]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopPropagation(); // do not also close the surrounding dialog
      close(true);
      return;
    }
    if (!open || (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End")) return;
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next].focus();
  }

  function chooseCategory(c: RoleCategory) {
    if (c === "Other") {
      // Keep a custom role already typed under Other; any other previous role is reset.
      onChange({ category: "Other", role: category === "Other" ? role : "" });
      close(true);
    } else setPending(c);
  }

  function chooseRole(c: RoleCategory, r: string) {
    onChange({ category: c, role: r });
    close(true);
  }

  const shown = role || (category === "Other" ? "Other" : "");
  const hasCategory = isRoleCategory(category);

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown} onBlur={(e) => open && !rootRef.current?.contains(e.relatedTarget as Node | null) && close()}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${id}`}
        aria-describedby={describedBy}
        onClick={() => (open ? close() : setOpen(true))}
        className={`flex h-11 w-full items-center justify-between gap-2 rounded-lg border ${invalid ? "border-red-400/70" : "border-line"} bg-navy-950/60 px-3 text-left text-sm text-ink outline-none transition focus-visible:border-electric-soft`}
      >
        <span className={`truncate ${shown ? "" : "text-muted"}`}>
          {shown || "Select role…"}
          {hasCategory && role && category !== "Other" ? <span className="text-muted"> · {category}</span> : null}
        </span>
        <ChevronDown size={16} aria-hidden className={`shrink-0 text-muted transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div ref={panelRef} role="menu" aria-label={pending ? `${pending} roles` : "Role categories"} style={{ maxHeight }} className="absolute bottom-full left-0 right-0 z-30 mb-1 overflow-y-auto overscroll-contain rounded-lg border border-line bg-navy-900 py-1 shadow-lg">
          {pending ? (
            <>
              <button type="button" role="menuitem" onClick={() => setPending(null)} className={`${item} flex items-center gap-2 border-b border-line font-medium`}>
                <ArrowLeft size={14} aria-hidden /> Back
              </button>
              {rolesFor(pending).map((r) => (
                <button key={r} type="button" role="menuitem" onClick={() => chooseRole(pending, r)} className={`${item} ${role === r && category === pending ? "text-electric-soft" : ""}`}>
                  {r}
                </button>
              ))}
            </>
          ) : (
            ROLE_CATEGORIES.map((c) => (
              <button key={c} type="button" role="menuitem" onClick={() => chooseCategory(c)} className={`${item} ${category === c ? "text-electric-soft" : ""}`}>
                {c}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
