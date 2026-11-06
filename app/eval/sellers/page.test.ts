import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
const tally = vi.hoisted(() => vi.fn());
vi.mock("@/server/match/sellerAnswers", () => ({ sellerTally: tally }));

import { renderToStaticMarkup } from "react-dom/server";
import SellerAnswersPage from "./page";

const html = async () => renderToStaticMarkup(await SellerAnswersPage());

describe("the page of seller answers", () => {
  afterEach(() => tally.mockReset());

  it("says so when there are none, and doesn't pass that off as agreement", async () => {
    tally.mockResolvedValue({ answers: 0, sameProduct: 0, differentProduct: 0, matcherAgrees: 0, stillRaised: 0, nowCleared: 0 });
    const page = await html();
    expect(page).toContain("No shop using its own file or address has answered yet.");
    expect(page).not.toContain("agrees");
  });

  it("gives the counts, and says nobody checked them and that they aren't the eval", async () => {
    tally.mockResolvedValue({ answers: 4, sameProduct: 2, differentProduct: 2, matcherAgrees: 2, stillRaised: 1, nowCleared: 1 });
    const page = (await html()).replace(/<!-- -->/g, "");
    expect(page).toContain("4 answers: 2 said it&#x27;s the recalled product, 2 said it&#x27;s different.");
    expect(page).toContain("agrees with 2 of them");
    expect(page).toContain("still raises 1");
    expect(page).toContain("clears 1");
    expect(page).toContain("nobody checked these answers");
    expect(page).toContain("aren&#x27;t in the held-out numbers");
  });

  it("says the answers couldn't be read, rather than that there are none", async () => {
    tally.mockRejectedValue(new Error("down"));
    const page = await html();
    expect(page).toContain("could not be read");
    expect(page).not.toContain("has answered yet");
  });
});
