"use client";

import { useState } from "react";

/** Copies the address of CPSC's public record here. The link stays readable if copying isn't allowed. */
export function CopyRecallLink({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <p>
      <button
        type="button"
        className="btn btn-outline"
        onClick={() => {
          void navigator.clipboard?.writeText(`${window.location.origin}${path}`).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : "Copy the recall link"}
      </button>{" "}
      <a href={path}>The recall link</a>
    </p>
  );
}
