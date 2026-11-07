"use client";

import { usePathname } from "next/navigation";

const PAGES = [
  { href: "/queue", label: "Queue" },
  { href: "/replay", label: "Replay" },
  { href: "/eval", label: "How well it works" },
  { href: "/safety", label: "Safety" },
  { href: "/check", label: "Check" },
];

const isHere = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

/**
 * On every page but a family's: a family holds a link to one notice, and gets no way into the seller's side.
 * Plain links on purpose: a full page load keeps one page's stylesheet (the timeline, the grid) off the next.
 */
export function SiteHeader() {
  const path = usePathname();
  if (path.startsWith("/r/")) return null;
  /* eslint-disable @next/next/no-html-link-for-pages */
  return (
    <header className="site-header">
      <div className="site-header-row">
        <a className="wordmark" href="/">
          Recall Reach
        </a>
        <nav aria-label="Main" className="site-nav">
          {PAGES.map((page) => (
            <a key={page.href} href={page.href} aria-current={isHere(path, page.href) ? "page" : undefined}>
              {page.label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
  /* eslint-enable @next/next/no-html-link-for-pages */
}
