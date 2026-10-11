"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}

/**
 * Modal built on the native <dialog>: focus is trapped, Escape closes it, and focus returns to
 * the element that opened it. Render it only while open.
 */
export function Dialog({ title, onClose, children, wide = false }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opener = document.activeElement as HTMLElement | null;
    // Guarded so React StrictMode's extra effect run in development cannot throw or toggle it.
    if (typeof el.showModal === "function") {
      if (!el.open) el.showModal();
    } else el.setAttribute("open", "");
    return () => {
      // No close() here: unmounting removes the dialog (and its top layer) by itself, and a
      // programmatic close would fire "close" and tell the parent to dismiss it.
      opener?.focus?.();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={`m-auto w-[calc(100%-2rem)] ${wide ? "max-w-2xl" : "max-w-lg"} rounded-2xl border border-line bg-navy-900 p-0 text-ink shadow-2xl backdrop:bg-black/70`}
    >
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-muted hover:text-ink">
          <X size={20} aria-hidden />
        </button>
      </div>
      <div className="max-h-[75vh] overflow-y-auto px-5 py-4">{children}</div>
    </dialog>
  );
}
