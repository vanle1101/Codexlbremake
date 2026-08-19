import { AlertCircle, Bot, CheckCircle2, Download, Pause, Play, Plus, RefreshCw, Square, Terminal, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { cn } from "@/lib/utils";
import {
  appendAutoLogin,
  cancelAutoLogin,
  getAutoLoginStatus,
  pauseAutoLogin,
  resumeAutoLogin,
  startAutoLogin,
} from "@/features/accounts/api";
import type {
  AutoLoginAccountItem,
  AutoLoginLogItem,
  AutoLoginStateResponse,
} from "@/features/accounts/schemas";

export type AutoLoginDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccountAdded?: () => void;
};

export function AutoLoginDialog({ open, onOpenChange, onAccountAdded }: AutoLoginDialogProps) {
  const { t } = useTranslation();

  const [accountsText, setAccountsText] = useState("");
  const [delaySeconds, setDelaySeconds] = useState(2);
  const [concurrency, setConcurrency] = useState<number>(() => {
    const saved = localStorage.getItem("codex_auto_login_concurrency");
    return saved ? parseInt(saved, 10) || 5 : 5;
  });
  const [submitting, setSubmitting] = useState(false);

  const [sessionState, setSessionState] = useState<AutoLoginStateResponse>({
    status: "idle",
    current_index: 0,
    queue: [],
    logs: [],
  });

  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs to bottom
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [sessionState.logs]);

  // Parse accounts text into structured array with deduplication & Gmail dot normalization
  const { parsedAccounts, rawTotalCount, duplicateCount } = useMemo(() => {
    if (!accountsText.trim()) {
      return { parsedAccounts: [], rawTotalCount: 0, duplicateCount: 0 };
    }
    const lines = accountsText.split("\n");
    const accountsMap = new Map<string, AutoLoginAccountItem>();
    let validLines = 0;

    for (const rawLine of lines) {
      let line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;

      // Tự động loại bỏ phần ghi chú / mã lỗi ở đuôi dòng (vd: # Lỗi: ... hoặc // ...)
      if (line.includes("#")) {
        line = line.split("#")[0].trim();
      }
      if (line.includes("//")) {
        line = line.split("//")[0].trim();
      }
      if (!line) continue;

      let parts: string[] = [];
      if (line.includes("|")) {
        parts = line.split("|");
      } else if (line.includes("\t")) {
        parts = line.split("\t");
      } else if (line.includes(":")) {
        parts = line.split(":");
      }

      if (parts.length >= 2) {
        const email = parts[0].trim();
        const password = parts[1].trim();
        const twoFactorSecret = parts[2] ? parts[2].trim().replace(/\s+/g, "") : null;

        if (email.includes("@")) {
          validLines += 1;
          // Lọc trùng theo email, giữ nguyên 100% email gốc và mật khẩu gốc
          const normKey = email.toLowerCase();

          accountsMap.set(normKey, {
            email,
            password,
            two_factor_secret: twoFactorSecret,
            status: "PENDING",
            error: null,
          });
        }
      }
    }

    const uniqueList = Array.from(accountsMap.values());
    return {
      parsedAccounts: uniqueList,
      rawTotalCount: validLines,
      duplicateCount: Math.max(0, validLines - uniqueList.length),
    };
  }, [accountsText]);

  // Fetch initial status when dialog opens
  useEffect(() => {
    if (!open) return;
    void getAutoLoginStatus()
      .then((state) => {
        setSessionState(state);
        if (state.concurrency) {
          setConcurrency(state.concurrency);
        }
      })
      .catch(() => {});
  }, [open]);

  // Poll backend status when running
  useEffect(() => {
    if (!open || sessionState.status !== "running") return;

    const interval = setInterval(async () => {
      try {
        const nextState = await getAutoLoginStatus();
        if (nextState.concurrency && nextState.concurrency !== concurrency) {
          setConcurrency(nextState.concurrency);
        }
        setSessionState((prev) => {
          const prevSuccessCount = prev.queue.filter((a) => a.status === "SUCCESS").length;
          const nextSuccessCount = nextState.queue.filter((a) => a.status === "SUCCESS").length;
          if (nextSuccessCount > prevSuccessCount) {
            onAccountAdded?.();
          }
          return nextState;
        });
      } catch {
        // ignore transient poll error
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [open, sessionState.status, onAccountAdded]);

  const handleStart = async () => {
    const queueToRun = parsedAccounts.length > 0 ? parsedAccounts : sessionState.queue;
    if (queueToRun.length === 0) {
      toast.error("Vui lòng nhập ít nhất 1 tài khoản theo định dạng mail|pass|2fa.");
      return;
    }

    setSubmitting(true);
    try {
      const resp = await startAutoLogin({
        accounts: queueToRun,
        delay_seconds: delaySeconds,
        concurrency: concurrency,
        headless: true,
      });
      setSessionState(resp);
      toast.success(`Đã khởi động tiến trình đăng nhập ngầm (${concurrency} luồng song song)!`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Lỗi khởi động đăng nhập ngầm";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAppend = async () => {
    if (parsedAccounts.length === 0) {
      toast.error("Vui lòng nhập danh sách tài khoản cần thêm vào ô trên.");
      return;
    }

    setSubmitting(true);
    try {
      const resp = await appendAutoLogin({
        accounts: parsedAccounts,
        delay_seconds: delaySeconds,
        headless: true,
      });
      setSessionState(resp);
      setAccountsText("");
      toast.success(`Đã nối thêm ${parsedAccounts.length} tài khoản vào hàng đợi thành công!`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Lỗi thêm tài khoản vào hàng đợi";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handlePause = async () => {
    try {
      const resp = await pauseAutoLogin();
      setSessionState(resp);
      toast.info("Đã tạm dừng tiến trình");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Lỗi tạm dừng";
      toast.error(msg);
    }
  };

  const handleResume = async () => {
    try {
      const resp = await resumeAutoLogin();
      setSessionState(resp);
      toast.success("Tiếp tục tiến trình");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Lỗi tiếp tục";
      toast.error(msg);
    }
  };

  const handleCancel = async () => {
    try {
      const resp = await cancelAutoLogin();
      setSessionState(resp);
      toast.info("Đã dừng tiến trình");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Lỗi hủy";
      toast.error(msg);
    }
  };

  const handleExportFailed = () => {
    const failed = sessionState.queue.filter((a) => a.status === "FAILED");
    if (failed.length === 0) {
      toast.info(t("accounts.autoLoginDialog.noFailed"));
      return;
    }

    const lines = failed.map((a) => {
      const twoFa = a.twoFactorSecret || a.two_factor_secret;
      return `${a.email}|${a.password}${twoFa ? `|${twoFa}` : ""}`;
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `failed_accounts_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Đã xuất ${lines.length} tài khoản lỗi (định dạng sạch mail|pass|2fa)!`);
  };

  const handleExportPhoneRequired = () => {
    const phoneList = sessionState.queue.filter((a) => a.status === "PHONE_REQUIRED");
    if (phoneList.length === 0) {
      toast.info("Không có tài khoản nào dính cờ SĐT.");
      return;
    }

    const lines = phoneList.map((a) => {
      const twoFa = a.twoFactorSecret || a.two_factor_secret;
      return `${a.email}|${a.password}${twoFa ? `|${twoFa}` : ""}`;
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `phone_required_accounts_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Đã xuất ${lines.length} tài khoản dính SĐT (định dạng sạch mail|pass|2fa)!`);
  };

  const handleClear = () => {
    setAccountsText("");
    void handleCancel();
  };

  const total = sessionState.queue.length > 0 ? sessionState.queue.length : parsedAccounts.length;
  const successCount = sessionState.queue.filter((a) => a.status === "SUCCESS").length;
  const phoneCount = sessionState.queue.filter((a) => a.status === "PHONE_REQUIRED").length;
  const failCount = sessionState.queue.filter((a) => a.status === "FAILED").length;
  const pendingCount = Math.max(0, total - successCount - phoneCount - failCount);
  const progressPercent = total > 0 ? Math.round(((successCount + phoneCount + failCount) / total) * 100) : 0;
  const isRunning = sessionState.status === "running";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl sm:max-w-5xl lg:max-w-6xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <Bot className="h-4 w-4" />
            </span>
            <div>
              <DialogTitle>{t("accounts.autoLoginDialog.title")}</DialogTitle>
              <DialogDescription>
                Hệ thống sử dụng Playwright chạy ngầm hoàn toàn (Headless) để tự động đăng nhập và nạp tài khoản vào Codex-LB.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Input Textarea Section */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <label htmlFor="auto-login-input" className="font-medium">
              {t("accounts.autoLoginDialog.accountsLabel")}
            </label>
            <div className="flex items-center gap-1.5">
              {duplicateCount > 0 ? (
                <span className="rounded bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 text-[11px] font-mono text-amber-600 dark:text-amber-400">
                  Đã lọc {duplicateCount} acc trùng
                </span>
              ) : null}
              <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-mono text-muted-foreground">
                {parsedAccounts.length} tài khoản hợp lệ
              </span>
            </div>
          </div>

          <textarea
            id="auto-login-input"
            rows={7}
            value={accountsText}
            onChange={(e) => setAccountsText(e.target.value)}
            disabled={isRunning}
            placeholder={t("accounts.autoLoginDialog.accountsPlaceholder")}
            className={cn(
              "w-full min-h-[140px] rounded-lg border bg-muted/20 p-3 font-mono text-xs outline-none transition-colors",
              "focus:border-ring focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />
          <p className="text-[11px] text-muted-foreground">{t("accounts.autoLoginDialog.hint")}</p>
        </div>

          {/* Stats & Progress */}
          <div className="space-y-3 rounded-lg border bg-muted/10 p-3">
            <div className="grid grid-cols-5 gap-1.5 text-center text-xs">
              <div className="rounded border bg-background/50 p-1.5">
                <span className="block text-[10px] text-muted-foreground">{t("accounts.autoLoginDialog.total")}</span>
                <span className="font-bold">{total}</span>
              </div>
              <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-1.5 text-emerald-600 dark:text-emerald-400">
                <span className="block text-[10px]">{t("accounts.autoLoginDialog.success")}</span>
                <span className="font-bold">{successCount}</span>
              </div>
              <div className="rounded border border-purple-500/30 bg-purple-500/5 p-1.5 text-purple-600 dark:text-purple-400">
                <span className="block text-[10px] flex items-center justify-center gap-0.5">📱 Dính SĐT</span>
                <span className="font-bold">{phoneCount}</span>
              </div>
              <div className="rounded border border-red-500/30 bg-red-500/5 p-1.5 text-red-600 dark:text-red-400">
                <span className="block text-[10px]">Lỗi khác</span>
                <span className="font-bold">{failCount}</span>
              </div>
              <div className="rounded border border-amber-500/30 bg-amber-500/5 p-1.5 text-amber-600 dark:text-amber-400">
                <span className="block text-[10px]">{t("accounts.autoLoginDialog.pending")}</span>
                <span className="font-bold">{pendingCount}</span>
              </div>
            </div>

          <div className="space-y-1">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-gradient-to-r from-primary to-emerald-500 transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                {isRunning
                  ? `Trình duyệt đang chạy ngầm (${concurrency} luồng song song)...`
                  : sessionState.status === "paused"
                  ? "Đã tạm dừng"
                  : sessionState.status === "finished"
                  ? "Đã hoàn thành"
                  : "Sẵn sàng"}
              </span>
              <span>{progressPercent}%</span>
            </div>
          </div>

          {/* Live Console Logs */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
              <Terminal className="h-3.5 w-3.5" />
              <span>Nhật ký báo cáo trực tiếp:</span>
            </div>
            <div className="h-36 overflow-y-auto rounded-lg border bg-zinc-950 p-2.5 font-mono text-[11px] text-zinc-100 shadow-inner">
              {sessionState.logs.length === 0 ? (
                <div className="text-zinc-500 italic">Chưa có nhật ký hoạt động. Bấm "Bắt đầu đăng nhập tự động" để chạy.</div>
              ) : (
                sessionState.logs.map((log, idx) => (
                  <div key={idx} className="leading-relaxed">
                    <span className="text-zinc-500 mr-2">[{log.timestamp}]</span>
                    <span
                      className={cn(
                        log.level === "error" && "text-red-400 font-medium",
                        log.level === "success" && "text-emerald-400 font-medium",
                        log.level === "warning" && "text-amber-400",
                        log.level === "info" && "text-zinc-300",
                      )}
                    >
                      {log.message}
                    </span>
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>

        <DialogFooter className="flex flex-wrap items-center justify-between gap-2 sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <label htmlFor="concurrency-select" className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                <Zap className="h-3.5 w-3.5" /> Luồng chạy:
              </label>
              <select
                id="concurrency-select"
                value={isRunning ? (sessionState.concurrency || concurrency) : concurrency}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10) || 5;
                  setConcurrency(val);
                  localStorage.setItem("codex_auto_login_concurrency", String(val));
                }}
                className="h-7 rounded border border-emerald-500/30 bg-background px-2 text-xs font-semibold"
                disabled={isRunning}
              >
                <option value={1}>1 luồng</option>
                <option value={2}>2 luồng</option>
                <option value={3}>3 luồng (⚡ Nhanh - Khuyên dùng)</option>
                <option value={4}>4 luồng (🚀 Rất nhanh)</option>
                <option value={5}>5 luồng (🚀 Siêu tốc)</option>
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <label htmlFor="delay-input" className="text-xs text-muted-foreground">
                Delay (s):
              </label>
              <input
                id="delay-input"
                type="number"
                min={0}
                max={60}
                value={delaySeconds}
                onChange={(e) => setDelaySeconds(parseInt(e.target.value, 10) || 0)}
                className="h-7 w-12 rounded border bg-muted/20 text-center font-mono text-xs"
                disabled={isRunning}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {phoneCount > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleExportPhoneRequired}
                className="gap-1 text-xs border-purple-500/30 text-purple-600 dark:text-purple-400 bg-purple-500/5 hover:bg-purple-500/10 px-2.5"
              >
                <Download className="h-3.5 w-3.5" />
                Xuất dính SĐT ({phoneCount})
              </Button>
            ) : null}

            {failCount > 0 ? (
              <Button type="button" size="sm" variant="outline" onClick={handleExportFailed} className="gap-1 text-xs text-red-600 dark:text-red-400 border-red-500/30 bg-red-500/5 hover:bg-red-500/10 px-2.5">
                <Download className="h-3.5 w-3.5" />
                Xuất lỗi ({failCount})
              </Button>
            ) : null}

            {sessionState.queue.length > 0 && !isRunning ? (
              <Button type="button" size="sm" variant="ghost" onClick={handleClear} className="gap-1 text-xs text-muted-foreground px-2">
                <Trash2 className="h-3.5 w-3.5" />
                Làm mới
              </Button>
            ) : null}

            {parsedAccounts.length > 0 && (isRunning || sessionState.status === "paused") ? (
              <Button
                type="button"
                size="sm"
                onClick={handleAppend}
                disabled={submitting}
                className="gap-1 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-sm px-2.5"
              >
                <Plus className="h-3.5 w-3.5" />
                Nối {parsedAccounts.length} acc
              </Button>
            ) : null}

            {isRunning ? (
              <>
                <Button type="button" size="sm" variant="outline" onClick={handlePause} className="gap-1 text-xs text-amber-600 px-2.5">
                  <Pause className="h-3.5 w-3.5" />
                  Tạm dừng
                </Button>
                <Button type="button" size="sm" variant="destructive" onClick={handleCancel} className="gap-1 text-xs px-2.5">
                  <Square className="h-3.5 w-3.5" />
                  Dừng
                </Button>
              </>
            ) : sessionState.status === "paused" ? (
              <>
                <Button type="button" size="sm" onClick={handleResume} className="gap-1 text-xs text-emerald-600 px-2.5">
                  <Play className="h-3.5 w-3.5" />
                  Tiếp tục
                </Button>
                <Button type="button" size="sm" variant="destructive" onClick={handleCancel} className="gap-1 text-xs px-2.5">
                  <Square className="h-3.5 w-3.5" />
                  Dừng
                </Button>
              </>
            ) : (
              <Button type="button" size="sm" onClick={handleStart} disabled={submitting} className="gap-1 text-xs px-3">
                {submitting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                {t("accounts.autoLoginDialog.start")}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
