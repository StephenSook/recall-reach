import type { Metadata } from "next";
import { Jost } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "./SiteHeader";

const jost = Jost({
  variable: "--font-jost",
  subsets: ["latin"],
});

const DESCRIPTION = "Check past sales for recalls and reach the families who bought them.";

export const metadata: Metadata = {
  metadataBase: new URL("https://recall-reach-web-e022.onrender.com"),
  title: "Recall Reach",
  description: DESCRIPTION,
  openGraph: {
    title: "Recall Reach",
    description: DESCRIPTION,
    siteName: "Recall Reach",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Recall Reach. Check past sales for recalls and reach the families who bought them." }],
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${jost.variable} h-full antialiased`}
    >
      <head>
        <link rel="ai-catalog" href="/.well-known/ai-catalog.json" />
      </head>
      <body className="min-h-full flex flex-col">
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
