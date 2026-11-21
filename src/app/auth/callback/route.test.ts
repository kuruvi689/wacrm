import { beforeEach, describe, expect, it, vi } from "vitest";

const { exchangeCodeForSession } = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession } }),
}));

import { GET } from "./route";

const origin = "https://crm.example.test";

function callback(query: string) {
  return GET(new Request(`${origin}/auth/callback?${query}`));
}

beforeEach(() => exchangeCodeForSession.mockReset());

describe("PKCE callback", () => {
  it("takes a valid password recovery session to the password form", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await callback("code=one-time-code&next=%2Freset-password");

    expect(exchangeCodeForSession).toHaveBeenCalledWith("one-time-code");
    expect(response.headers.get("location")).toBe(`${origin}/reset-password`);
  });

  it("offers a new reset link when the recovery code is missing or invalid", async () => {
    const missingCode = await callback("next=%2Freset-password");
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(missingCode.headers.get("location")).toBe(`${origin}/forgot-password?expired=1`);

    exchangeCodeForSession.mockResolvedValue({ data: null, error: { message: "Invalid code" } });
    const invalidCode = await callback("code=expired&next=%2Freset-password");
    expect(invalidCode.headers.get("location")).toBe(`${origin}/forgot-password?expired=1`);
  });

  it("keeps the safe redirect for normal sign-in", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await callback("code=valid&next=%2Finbox");
    expect(response.headers.get("location")).toBe(`${origin}/inbox`);
  });
});
