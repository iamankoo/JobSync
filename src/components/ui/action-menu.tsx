"use client";

import { useEffect, useRef, useState } from "react";
import { EllipsisVertical } from "lucide-react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/** Row actions menu. The popup is fixed-positioned so scrolling table containers cannot clip it. */
export function ActionMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = pos !== null;

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const close = () => setPos(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPos(null);
        button.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function toggle() {
    if (open) return setPos(null);
    const r = button.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: Math.max(8, r.right - 208) });
  }

  function onMenuKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const els = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    els[(i + (e.key === "ArrowDown" ? 1 : els.length - 1)) % els.length]?.focus();
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-navy-900 text-ink transition hover:border-electric-soft"
      >
        <EllipsisVertical size={18} aria-hidden />
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: 208 }}
          className="z-50 rounded-lg border border-line bg-navy-800 p-1 shadow-xl"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setPos(null);
                item.onSelect();
              }}
              className="block w-full rounded-md px-3 py-2 text-left text-sm text-ink hover:bg-navy-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
