import { AuthCancelledError, LastSignInMethodError } from "@/auth/errors";

describe("auth error types", () => {
  it("AuthCancelledError is identifiable by instanceof and name", () => {
    const e = new AuthCancelledError();
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AuthCancelledError);
    expect(e.name).toBe("AuthCancelledError");
  });

  it("LastSignInMethodError is identifiable by instanceof and name", () => {
    const e = new LastSignInMethodError();
    expect(e).toBeInstanceOf(LastSignInMethodError);
    expect(e.name).toBe("LastSignInMethodError");
  });

  it("the two are not interchangeable", () => {
    expect(new AuthCancelledError()).not.toBeInstanceOf(LastSignInMethodError);
  });
});
