import { deviceContext } from "../deviceContext";

describe("deviceContext", () => {
  it("returns string values for every field", () => {
    const ctx = deviceContext();

    expect(typeof ctx.app_version).toBe("string");
    expect(typeof ctx.platform).toBe("string");
    expect(typeof ctx.os_version).toBe("string");
    expect(typeof ctx.device_model).toBe("string");
  });

  it("never returns null or undefined even when native values are missing", () => {
    const ctx = deviceContext();

    for (const value of Object.values(ctx)) {
      expect(value).not.toBeNull();
      expect(value).not.toBeUndefined();
    }
  });
});
