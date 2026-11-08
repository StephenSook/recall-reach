"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { loadPayPalSdk, startShelfCheckout, type PayPalSdk } from "./paypalSdk";

export function PayPalButton({ clientId, shopItemId, stopped, onBusy }: {
  clientId: string; shopItemId: string; stopped: boolean; onBusy(busy: boolean): void;
}) {
  const router = useRouter();
  const [sdk, setSdk] = useState<PayPalSdk | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    if (!clientId) return;
    let active = true;
    void loadPayPalSdk(clientId).then(async (instance) => {
      const methods = await instance.findEligibleMethods({ currencyCode: "USD" });
      if (active && methods.isEligible("paypal")) setSdk(instance);
    }).catch(() => {});
    return () => { active = false; };
  }, [clientId]);

  const start = () => {
    if (!sdk || stopped || busy.current) return;
    busy.current = true;
    onBusy(true);
    const release = () => { busy.current = false; onBusy(false); };
    void startShelfCheckout(sdk, shopItemId, {
      onCaptured: () => { release(); router.refresh(); }, // WatchForSale takes over until the webhook lands.
      onCancel: release,
      onError: () => { setSdk(null); release(); router.refresh(); },
    }).catch(() => { setSdk(null); release(); });
  };

  if (!sdk) return null;
  return (
    <div hidden={stopped}>
      <paypal-button type="pay" onClick={start} />
      <p className="note">PayPal&apos;s own button: log in with a sandbox buyer.</p>
    </div>
  );
}
