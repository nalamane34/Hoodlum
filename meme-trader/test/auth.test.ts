import { describe, expect, it } from "vitest";
import { LoginLimiter, clientAddress, cookieValue, isSecure, safeNext, sessionCookie } from "../src/dashboard/auth.js";

describe("dashboard auth helpers", () => {
  it("reads the session cookie", () => {
    expect(cookieValue("a=1; mt=abc%20d; b=2")).toBe("abc d");
    expect(cookieValue("mt=xyz")).toBe("xyz");
    expect(cookieValue("other=1")).toBeNull();
    expect(cookieValue(undefined)).toBeNull();
  });
  it("detects https directly or via X-Forwarded-Proto", () => {
    expect(isSecure({}, true)).toBe(true);
    expect(isSecure({ "x-forwarded-proto": "https" }, false)).toBe(true);
    expect(isSecure({ "x-forwarded-proto": "https, http" }, false)).toBe(true);
    expect(isSecure({ "x-forwarded-proto": "http" }, false)).toBe(false);
    expect(isSecure({}, false)).toBe(false);
  });
  it("sets Secure only on https", () => {
    expect(sessionCookie("t", true)).toContain("; Secure");
    expect(sessionCookie("t", false)).not.toContain("Secure");
    expect(sessionCookie("t", false)).toContain("HttpOnly");
  });
  it("rate-limits login attempts per client", () => {
    const l = new LoginLimiter(3, 1000);
    expect(l.allow("a", 0)).toBe(true);
    expect(l.allow("a", 10)).toBe(true);
    expect(l.allow("a", 20)).toBe(true);
    expect(l.allow("a", 30)).toBe(false);
    expect(l.allow("b", 30)).toBe(true);
    expect(l.allow("a", 1100)).toBe(true); // window passed
  });
  it("uses X-Forwarded-For only when the proxy is trusted", () => {
    expect(clientAddress({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }, "127.0.0.1", true)).toBe("1.2.3.4");
    expect(clientAddress({ "x-forwarded-for": "1.2.3.4" }, "127.0.0.1", false)).toBe("127.0.0.1");
  });
  it("only redirects to same-site paths", () => {
    expect(safeNext("/x?y=1")).toBe("/x?y=1");
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
});
