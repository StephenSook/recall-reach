import { describe, expect, it } from "vitest";
import { nartsLine } from "./nartsList";

describe("what the resale trade group says about an item typed in", () => {
  it.each([
    ["Nuna car seat", "says car seats should never be resold."],
    ["carseat", "says car seats should never be resold."],
    ["drop side crib", 'lists "Drop side cribs under any circumstance" among items that should never be taken in resale, recalled or not.'],
    ["Graco Baby Walker", 'lists "Baby walkers" among items that should never be taken in resale, recalled or not.'],
    ["infant walkers", 'lists "Baby walkers" among items that should never be taken in resale, recalled or not.'],
    ["inclined sleeper", 'lists "Inclined sleepers for babies" among items that should never be taken in resale, recalled or not.'],
    ["kids bike helmet", 'lists "Used helmets for bikes, motorcycles, sports" among items that should never be taken in resale, recalled or not.'],
    ["cedar chest", 'lists "Cedar chests with latch style locks" among items that should never be taken in resale, recalled or not.'],
    ["Pack n Play crib", 'lists "Cribs that do not meet current safety standards or are missing hardware" among items that should never be taken in resale, recalled or not.'],
  ])("%s", (typed, says) => {
    expect(nartsLine(typed)).toBe(says);
  });

  it.each(["high chair", "stroller", "walker for adults", "walkie talkie", "cribbage board", "", "car seat cover"])("says nothing about %s, unless NARTS names it", (typed) => {
    const line = nartsLine(typed);
    if (typed === "car seat cover") expect(line).toBe("says car seats should never be resold.");
    else expect(line).toBeNull();
  });
});
