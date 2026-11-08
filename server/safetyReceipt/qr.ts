import QRCode from "qrcode";

/** Generated here, so no outside QR service sees the shop's link. */
export async function receiptQr(link: string): Promise<string> {
  const svg = await QRCode.toString(link, { type: "svg", errorCorrectionLevel: "M", margin: 4, width: 240 });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
