import { describe, expect, it } from "vitest";

import { clientIp } from "@/lib/request-ip";

function reqWith(headers: Record<string, string>): Request {
  return new Request("https://crm.example.com/api/test", { headers });
}

describe("clientIp", () => {
  it("prefers x-real-ip over x-forwarded-for", () => {
    const req = reqWith({
      "x-real-ip": "203.0.113.7",
      "x-forwarded-for": "198.51.100.1, 203.0.113.7",
    });
    expect(clientIp(req)).toBe("203.0.113.7");
  });

  it("uses the rightmost x-forwarded-for entry, not the spoofable leftmost", () => {
    const req = reqWith({ "x-forwarded-for": "6.6.6.6, 10.0.0.1, 203.0.113.9" });
    expect(clientIp(req)).toBe("203.0.113.9");
  });

  it("trims whitespace around forwarded entries", () => {
    const req = reqWith({ "x-forwarded-for": "  1.1.1.1 ,   203.0.113.4  " });
    expect(clientIp(req)).toBe("203.0.113.4");
  });

  it("ignores empty x-forwarded-for segments", () => {
    const req = reqWith({ "x-forwarded-for": "1.1.1.1, , " });
    expect(clientIp(req)).toBe("1.1.1.1");
  });

  it("trims x-real-ip", () => {
    expect(clientIp(reqWith({ "x-real-ip": "  192.0.2.5  " }))).toBe("192.0.2.5");
  });

  it("returns 'unknown' when no proxy headers are present", () => {
    expect(clientIp(reqWith({}))).toBe("unknown");
  });

  it("falls back to 'unknown' for an empty x-forwarded-for", () => {
    expect(clientIp(reqWith({ "x-forwarded-for": " " }))).toBe("unknown");
  });
});
