// src/panel/live-timeline.ts
// SPEC-6-4 — tail-follow state for the live timeline overlay. Pure logic (unit-tested);
// the panel owns the SelectList and consults this on forwarded keys + live appends.
export class LiveTimelineState {
  /** 0-based cursor into the RENDERED (message/tool-filtered) event list. */
  index = 0;
  /** True while the cursor rides the newest row (live appends move the view). */
  pinned = true;

  /** Handle a forwarded scroll key. Returns true when the view must re-render. */
  onKey(key: "up" | "down", total: number): boolean {
    if (total === 0) return false;
    if (key === "up") {
      if (this.index <= 0) return false;
      this.index--;
      this.pinned = false;
      return true;
    }
    // down
    if (this.index >= total - 1) return false;
    this.index++;
    this.pinned = this.index === total - 1;
    return true;
  }

  /** A new event arrived (list now has `total` rendered rows). Returns the cursor to restore:
   *  the newest row while pinned, unchanged otherwise. */
  append(total: number): number {
    if (this.pinned) this.index = total - 1;
    return this.index;
  }
}
