import type { HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "paypal-button": HTMLAttributes<HTMLElement> & { type: "pay" };
    }
  }
}
