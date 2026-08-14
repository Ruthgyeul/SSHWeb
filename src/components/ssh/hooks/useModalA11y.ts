"use client";

import { useEffect, useRef, type RefObject } from "react";

/** Elements that can hold keyboard focus inside a modal. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), ' +
  'input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared accessibility behaviour for the app's overlay modals: focus moves into
 * the dialog on open, is trapped inside it while open (Tab / Shift+Tab wrap),
 * Escape closes it, and focus returns to whatever was focused before the dialog
 * opened once it closes.
 *
 * Returns a ref to attach to the dialog container (also give it
 * `role="dialog" aria-modal="true"` and a label). Pass `closeOnEscape: false`
 * for a dialog that owns a richer Escape (e.g. a preview with its own keyboard
 * map, or an editor that must confirm discarding unsaved changes first) — the
 * focus trap + restore still apply. Pass `trapFocus: false` for a dialog that
 * manages its own focus and needs Tab for its own purpose (e.g. a code editor
 * whose textarea inserts a tab) — only focus **restore** on close is kept.
 */
export function useModalA11y<T extends HTMLElement = HTMLDivElement>(options: {
  onClose: () => void;
  closeOnEscape?: boolean;
  trapFocus?: boolean;
  enabled?: boolean;
}): RefObject<T | null> {
  const {
    onClose,
    closeOnEscape = true,
    trapFocus = true,
    enabled = true,
  } = options;
  const ref = useRef<T | null>(null);
  // Keep the latest onClose without re-running the effect (which would re-grab
  // focus mid-interaction).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const node = ref.current;
    if (!enabled || !node) return;

    const focusable = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.tabIndex !== -1 && !el.hasAttribute("disabled"),
      );

    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Move focus in: the first focusable, or the container itself. Skipped when
    // the dialog manages its own focus (trapFocus: false).
    if (trapFocus) {
      const initial = focusable()[0];
      if (initial) {
        initial.focus();
      } else {
        if (!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "-1");
        node.focus();
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closeOnEscape) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !trapFocus) return;
      const els = focusable();
      if (els.length === 0) {
        e.preventDefault();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement;
      if (!node.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      // Return focus to the opener, if it's still in the document.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [enabled, closeOnEscape, trapFocus]);

  return ref;
}
