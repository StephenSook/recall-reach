"use client";

import dynamic from "next/dynamic";
import { Component, useSyncExternalStore, type ReactNode } from "react";
import type { GridRow, GridTab } from "./gridRows";

const MatchGrid = dynamic(() => import("./MatchGrid"), { ssr: false });

const WIDE = "(min-width: 768px)";
const subscribe = (change: () => void) => {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

/** Wide screens hide the windows until a row opens one. If the grid can't load, they all come back. */
class ShowWindowsIfItFails extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    document.documentElement.dataset.noGrid = "true";
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** A table this wide does not fit a phone, and a phone has the windows, so it never downloads the grid. */
export function MatchGridLoader({ rows, startOn, listings, licenseKey }: { rows: GridRow[]; startOn?: GridTab; listings?: boolean; licenseKey?: string | null }) {
  const wide = useSyncExternalStore(subscribe, () => window.matchMedia(WIDE).matches, () => false);
  return wide ? (
    <ShowWindowsIfItFails>
      <MatchGrid rows={rows} startOn={startOn} listings={listings} licenseKey={licenseKey} />
    </ShowWindowsIfItFails>
  ) : null;
}
