import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export interface ContactCipher {
  seal(plain: string): string;
  open(sealed: string): string;
}

/**
 * Encrypts a shop's own buyer contact details at rest (AES-256-GCM) under a key derived per shop
 * from the deployment's SHOP_DATA_KEY. One shop's key opens nothing of another's, and the shop id
 * is bound into every value. Deleting a shop's rows when it disconnects removes the data itself.
 */
export function createContactCipher(masterSecret: string, shopId: string): ContactCipher {
  if (masterSecret.length < 32) throw new Error("contact cipher secret must be at least 32 characters");
  const key = Buffer.from(hkdfSync("sha256", masterSecret, shopId, "recall-reach buyer contact v1", 32));
  const aad = Buffer.from(shopId);
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(aad);
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
    },
    open(sealed) {
      try {
        const [version, iv, tag, body] = sealed.split(".");
        if (version !== "v1" || !iv || !tag || !body) throw new Error("bad format");
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"))
          .setAAD(aad)
          .setAuthTag(Buffer.from(tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
      } catch {
        throw new Error("contact value could not be opened");
      }
    },
  };
}
