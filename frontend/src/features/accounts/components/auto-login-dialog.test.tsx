import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutoLoginDialog } from "@/features/accounts/components/auto-login-dialog";
import * as accountsApi from "@/features/accounts/api";

vi.mock("@/features/accounts/api", () => ({
  startAutoLogin: vi.fn(),
  getAutoLoginStatus: vi.fn(),
  pauseAutoLogin: vi.fn(),
  resumeAutoLogin: vi.fn(),
  cancelAutoLogin: vi.fn(),
}));

describe("AutoLoginDialog", () => {
  beforeEach(() => {
    vi.mocked(accountsApi.getAutoLoginStatus).mockResolvedValue({
      status: "idle",
      current_index: 0,
      queue: [],
      logs: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders properly when opened", () => {
    render(<AutoLoginDialog open={true} onOpenChange={() => {}} />);
    expect(screen.getByText("Auto Login Accounts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Auto Login/i })).toBeInTheDocument();
  });

  it("parses account inputs correctly and calls startAutoLogin on start", async () => {
    const user = userEvent.setup();
    vi.mocked(accountsApi.startAutoLogin).mockResolvedValue({
      status: "running",
      current_index: 0,
      queue: [
        {
          email: "test@example.com",
          password: "mypassword123",
          two_factor_secret: "JBSWY3DPEHPK3PXP",
          status: "PROCESSING",
          error: null,
        },
      ],
      logs: [
        {
          timestamp: "12:00:00",
          message: "Starting login...",
          level: "info",
        },
      ],
    });

    render(<AutoLoginDialog open={true} onOpenChange={() => {}} />);

    const textarea = screen.getByPlaceholderText(/email1@domain.com\|pass1\|2FA_SECRET/i);
    await user.type(
      textarea,
      "test@example.com|mypassword123|JBSWY3DPEHPK3PXP\nuser2@example.com|pass456",
    );

    expect(screen.getByText("2 accounts")).toBeInTheDocument();

    const startBtn = screen.getByRole("button", { name: /Start Auto Login/i });
    await user.click(startBtn);

    expect(accountsApi.startAutoLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: [
          expect.objectContaining({
            email: "test@example.com",
            password: "mypassword123",
            two_factor_secret: "JBSWY3DPEHPK3PXP",
          }),
          expect.objectContaining({
            email: "user2@example.com",
            password: "pass456",
          }),
        ],
        headless: true,
      }),
    );
  });
});
