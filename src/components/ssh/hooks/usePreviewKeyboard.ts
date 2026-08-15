import { useEffect, useRef, type RefObject } from "react";

import type { PreviewMode } from "../FilePreview";
import { ZOOM_STEP } from "./useImageTransform";

/**
 * The window keyboard shortcuts for the preview modal, extracted from
 * `FilePreview`.
 *
 * One cohesive concern: every key the modal listens for — Ctrl/⌘+F to open the
 * text find bar, Esc to dismiss the find bar then the modal, ←/→ (and Shift+←/→)
 * to step the gallery, the full `<video>` transport (play/seek/volume/mute/
 * fullscreen/speed/frame-step), and image zoom/reset/rotate. The routing is
 * order-sensitive (find-bar and typing guards first, video seeking reserves the
 * plain arrows, etc.), so it lives together rather than scattered per view.
 *
 * The listener subscribes once and reads the latest options from a ref, so the
 * caller can pass fresh closures every render without re-binding the handler.
 * Covered by a `renderHook` suite that dispatches real `keydown` events.
 */
export interface PreviewKeyboardOptions {
  kind: PreviewMode;
  isImage: boolean;
  isText: boolean;
  /** Whether the text find bar is currently open (Esc dismisses it first). */
  findOpen: boolean;
  /** Whether there is more than one previewable sibling to step through. */
  hasGallery: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  findInputRef: RefObject<HTMLInputElement | null>;
  setFindOpen: (open: boolean) => void;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  zoomBy: (factor: number) => void;
  resetView: () => void;
  rotate: () => void;
  setSpeed: (rate: number) => void;
}

export function usePreviewKeyboard(options: PreviewKeyboardOptions): void {
  // Keep the latest options in a ref so the single window listener always sees
  // current closures without re-subscribing every render. Updated after each
  // render (not during) so the listener below can subscribe just once.
  const optsRef = useRef(options);
  useEffect(() => {
    optsRef.current = options;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const {
        kind,
        isImage,
        isText,
        findOpen,
        hasGallery,
        videoRef,
        findInputRef,
        setFindOpen,
        onClose,
        onPrev,
        onNext,
        zoomBy,
        resetView,
        rotate,
        setSpeed,
      } = optsRef.current;

      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement;
      // Ctrl/⌘+F opens (and focuses) the find bar for a text preview.
      if (
        isText &&
        (e.ctrlKey || e.metaKey) &&
        (e.key === "f" || e.key === "F")
      ) {
        e.preventDefault();
        setFindOpen(true);
        requestAnimationFrame(() => findInputRef.current?.focus());
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Esc dismisses the find bar first, only then the whole modal.
        if (findOpen) {
          setFindOpen(false);
          return;
        }
        onClose();
        return;
      }
      // While typing in the find input, leave the rest of the keys to it.
      if (typing) return;
      // Shift+←/→ always steps the gallery, on every kind — including video/audio,
      // where the plain arrows are reserved for seeking. Lets the keyboard step
      // through a folder of clips without reaching for the on-screen ‹ › buttons.
      if (
        hasGallery &&
        e.shiftKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        e.preventDefault();
        (e.key === "ArrowLeft" ? onPrev : onNext)?.();
        return;
      }
      // Let a focused <video>/<audio> keep its own arrow-key seeking; gallery
      // stepping for those is via Shift+←/→ (above) or the on-screen ‹ › buttons.
      const mediaFocused = kind === "video" || kind === "audio";
      if (
        !mediaFocused &&
        hasGallery &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        e.preventDefault();
        (e.key === "ArrowLeft" ? onPrev : onNext)?.();
        return;
      }
      // Video transport controls (Space/k play-pause, ←/→ or j/l seek ±5s,
      // ↑/↓ volume, m mute, f fullscreen). Gallery stepping for video is on the
      // ‹ › buttons instead, so the arrows are free to seek here.
      if (kind === "video" && videoRef.current) {
        const v = videoRef.current;
        switch (e.key) {
          case " ":
          case "k":
            e.preventDefault();
            if (v.paused) void v.play();
            else v.pause();
            return;
          case "ArrowLeft":
          case "j":
            e.preventDefault();
            v.currentTime = Math.max(0, v.currentTime - 5);
            return;
          case "ArrowRight":
          case "l":
            e.preventDefault();
            v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 5);
            return;
          case "ArrowUp":
            e.preventDefault();
            v.volume = Math.min(1, v.volume + 0.1);
            return;
          case "ArrowDown":
            e.preventDefault();
            v.volume = Math.max(0, v.volume - 0.1);
            return;
          case "m":
          case "M":
            e.preventDefault();
            v.muted = !v.muted;
            return;
          case "f":
          case "F":
            e.preventDefault();
            if (document.fullscreenElement) void document.exitFullscreen();
            else void v.requestFullscreen?.();
            return;
          case "]":
          case ">":
            e.preventDefault(); // speed up
            setSpeed(v.playbackRate + 0.25);
            return;
          case "[":
          case "<":
            e.preventDefault(); // slow down
            setSpeed(v.playbackRate - 0.25);
            return;
          case ".":
            e.preventDefault(); // step one frame forward
            v.pause();
            v.currentTime = v.currentTime + 1 / 30;
            return;
          case ",":
            e.preventDefault(); // step one frame back
            v.pause();
            v.currentTime = Math.max(0, v.currentTime - 1 / 30);
            return;
          default:
            return;
        }
      }
      if (!isImage) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomBy(ZOOM_STEP);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomBy(1 / ZOOM_STEP);
      } else if (e.key === "0") {
        e.preventDefault();
        resetView();
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        rotate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
