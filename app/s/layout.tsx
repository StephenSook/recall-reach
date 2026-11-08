import type { Metadata } from "next";

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function ReceiptLayout({ children }: { children: React.ReactNode }) { return children; }
