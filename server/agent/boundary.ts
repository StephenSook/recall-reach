// What may reach Claude. A tool result can only be built from these types, so a number, a date or a plain
// string read from anywhere else does not compile. publicText and shopOwnedText are used in sources.ts only.
declare const brand: unique symbol;
type Branded<K extends string> = string & { readonly [brand]: K };

/** Words CPSC published. */
export type PublicText = Branded<"public">;
/** Words from the shop's own file: what it called an item and how it described it. */
export type ShopOwnedText = Branded<"shop-owned">;
/** Words this app wrote in its source. */
export type OurText = Branded<"ours">;

export type AllowedText = PublicText | ShopOwnedText | OurText;
export type AllowedValue = AllowedText | null | readonly AllowedValue[] | { readonly [key: string]: AllowedValue };

export const publicText = (text: string) => text as PublicText;
export const shopOwnedText = (text: string) => text as ShopOwnedText;

/** Takes only text fixed in the source. A string read at run time does not compile. */
export function ourText<T extends string>(text: T & (string extends T ? never : unknown)): OurText {
  return text as unknown as OurText;
}

export function toolResult(value: AllowedValue): string {
  return JSON.stringify(value);
}
