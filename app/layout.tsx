import type { Metadata } from "next";
import { Jost } from "next/font/google";
import "./globals.css";

const jost = Jost({
  variable: "--font-jost",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Recall Reach",
  description: "Check past sales for recalls and reach the families who bought them.",
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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
