import { Bot, Eye, EyeOff, Globe, KeyRound, Loader2, Lock, Mail } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { autoReauthAccount, saveAccountCredentials } from "@/features/accounts/api";
import type { AccountSummary } from "@/features/accounts/schemas";

export type ReauthCredentialsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: AccountSummary | null;
  onSuccess?: () => void;
  onSwitchToOauth?: () => void;
};

export function ReauthCredentialsDialog({
  open,
  onOpenChange,
  account,
  onSuccess,
  onSwitchToOauth,
}: ReauthCredentialsDialogProps) {
  const [password, setPassword] = useState("");
  const [twoFactorSecret, setTwoFactorSecret] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!account) return null;

  const handleAutoLogin = async () => {
    if (!password.trim()) {
      toast.error("Vui lòng nhập mật khẩu tài khoản.");
      return;
    }

    setLoading(true);
    try {
      // 1. Save credentials to Vault
      await saveAccountCredentials(account.accountId, {
        email: account.email,
        password: password.trim(),
        two_factor_secret: twoFactorSecret.trim() ? twoFactorSecret.trim().replace(/\s+/g, "") : null,
      });

      // 2. Trigger auto re-auth
      const result = await autoReauthAccount(account.accountId);
      if (result.success) {
        toast.success(result.message || `Đã đăng nhập lại thành công cho ${account.email}!`);
        onOpenChange(false);
        setPassword("");
        setTwoFactorSecret("");
        onSuccess?.();
      } else {
        toast.error(result.message || "Tự động đăng nhập thất bại. Vui lòng kiểm tra lại mật khẩu hoặc 2FA.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Lỗi tự động đăng nhập";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
            <Bot className="h-5 w-5" />
            <DialogTitle>Tự động đăng nhập lại tài khoản</DialogTitle>
          </div>
          <DialogDescription className="text-xs">
            Nhập thông tin đăng nhập của <span className="font-semibold text-foreground">{account.email}</span> để hệ thống tự động lưu vào Vault và đăng nhập ngầm khôi phục Token.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5 py-2">
          {/* Email field */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" /> Email
            </label>
            <Input
              value={account.email}
              disabled
              className="bg-muted/50 font-mono text-xs"
            />
          </div>

          {/* Password field */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5 text-primary" /> Mật khẩu <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                placeholder="Nhập mật khẩu OpenAI / ChatGPT"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                className="pr-9 text-xs"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void handleAutoLogin();
                  }
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {/* 2FA Secret field */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5" /> Khóa 2FA Secret <span className="text-[11px] font-normal text-muted-foreground/80">(Tùy chọn nếu có mã 2FA)</span>
            </label>
            <Input
              type="text"
              placeholder="VD: JBSWY3DPEHPK3PXP"
              value={twoFactorSecret}
              onChange={(e) => setTwoFactorSecret(e.target.value)}
              disabled={loading}
              className="font-mono text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleAutoLogin();
                }
              }}
            />
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between sm:gap-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onOpenChange(false);
              onSwitchToOauth?.();
            }}
            disabled={loading}
            className="text-xs text-muted-foreground hover:text-foreground gap-1.5"
          >
            <Globe className="h-3.5 w-3.5" />
            Ủy quyền OAuth qua trình duyệt
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={handleAutoLogin}
            disabled={loading || !password.trim()}
            className="text-xs font-semibold gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
            {loading ? "Đang đăng nhập ngầm..." : "Đăng nhập ngay"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
