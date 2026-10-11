import { shouldOfferConnect } from "../useHealth";

// kora#406. Three screens branched on whether the DATA existed, so a user who
// had connected Apple Health but had nothing recorded for the period was shown
// "Connect Apple Health" — and tapping it started a permission flow that could
// not help, because the real reason was an absent measurement.
//
// The distinction this predicate exists to hold: absence of a MEASUREMENT is
// not absence of PERMISSION.
describe("shouldOfferConnect", () => {
  it("does not offer to connect what is already connected", () => {
    expect(shouldOfferConnect("authorized")).toBe(false);
  });

  it("offers when access was denied — re-granting IS the remedy there", () => {
    expect(shouldOfferConnect("denied")).toBe(true);
  });

  it("offers when Health is unavailable, which includes the pre-read initial state", () => {
    expect(shouldOfferConnect("unavailable")).toBe(true);
  });
});
