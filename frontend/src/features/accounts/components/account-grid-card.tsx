import {
  Calendar,
  Check,
  ChevronDown,
  CircleAlert,
  Clipboard,
  Clock,
  Download,
  Fingerprint,
  Link as LinkIcon,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Tag,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  AccountRoutingPolicy,
  AccountSummary,
} from "@/features/accounts/schemas";
import { usePrivacyStore } from "@/hooks/use-privacy";
import { cn } from "@/lib/utils";
import { formatCompactAccountId } from "@/utils/account-identifiers";
import { normalizeStatus } from "@/utils/account-status";
import { getPlanBadgeStyle } from "@/utils/plan-style";
import {
  formatDateTimeInline,
  formatPercentNullable,
  formatQuotaResetLabel,
  formatSlug,
} from "@/utils/formatters";

export type AccountGridCardProps = {
  account: AccountSummary;
  isSelected: boolean;
  onToggleSelect: (accountId: string, checked: boolean) => void;
  busy?: boolean;
  readOnly?: boolean;
  isCodexActive?: boolean;
  isSwitching?: boolean;
  isSwitchingAny?: boolean;
  isAutoReauthing?: boolean;
  onAutoReauth?: (accountId: string) => void;
  onSwitchToCodex: (accountId: string) => void;
  onPause: (accountId: string) => void;
  onResume: (accountId: string) => void;
  onProbe: (accountId: string) => void;
  onDelete: (accountId: string) => void;
  onReauth: (account: AccountSummary) => void;
  onExportAuth: (accountId: string) => void;
  onResetCredit: (accountId: string) => void;
  onRoutingPolicyChange: (accountId: string, policy: AccountRoutingPolicy) => void;
  onSetAlias: (account: AccountSummary) => void;
};

export function AccountGridCard({
  account,
  isSelected,
  onToggleSelect,
  busy = false,
  readOnly = false,
  isCodexActive = false,
  isSwitching = false,
  isSwitchingAny = false,
  isAutoReauthing = false,
  onAutoReauth,
  onSwitchToCodex,
  onPause,
  onResume,
  onProbe,
  onDelete,
  onReauth,
  onExportAuth,
  onResetCredit,
  onRoutingPolicyChange,
  onSetAlias,
}: AccountGridCardProps) {
  const blurred = usePrivacyStore((s) => s.blurred);
  const [copied, setCopied] = useState(false);

  const status = normalizeStatus(account.status);
  const isPaused = status === "paused";
  const is401 =
    status === "reauth" ||
    status === "deactivated" ||
    account.status === "reauth_required" ||
    status === "error";

  // Quota computations
  const secondaryRemaining = account.usage?.secondaryRemainingPercent;
  const primaryRemaining = account.usage?.primaryRemainingPercent;
  const displayRemaining = secondaryRemaining ?? primaryRemaining ?? 0;
  const clampedRemaining = Math.max(0, Math.min(100, displayRemaining));

  const resetLabel = formatQuotaResetLabel(
    account.resetAtSecondary ?? account.resetAtPrimary ?? null,
  );

  const availableCredits =
    account.availableResetCredits ??
    (account.capacityCreditsSecondary ?? account.capacityCreditsPrimary ?? 0);

  // Expiration date
  const expiryInfo = useMemo(() => {
    const expiresAt = account.auth?.access?.expiresAt;
    if (!expiresAt) return null;
    const expDate = new Date(expiresAt);
    const now = new Date();
    const diffDays = Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    const dateStr = formatDateTimeInline(expiresAt, "YYYY-MM-DD HH:mm");
    if (diffDays <= 0) {
      return {
        label: "Hết hạn gói",
        dateStr,
        isExpired: true,
      };
    }
    return {
      label: `Hết hạn gói ${diffDays} ngày`,
      dateStr,
      isExpiringSoon: diffDays <= 3,
      isExpired: false,
    };
  }, [account.auth?.access?.expiresAt]);

  const handleCopyEmail = () => {
    navigator.clipboard.writeText(account.email);
    toast.success(`Đã sao chép: ${account.email}`);
  };

  const handleCopyAuthInfo = () => {
    const payload = JSON.stringify(
      {
        email: account.email,
        accountId: account.accountId,
        chatgptAccountId: account.chatgptAccountId,
        planType: account.planType,
      },
      null,
      2,
    );
    navigator.clipboard.writeText(payload);
    setCopied(true);
    toast.success("Đã sao chép thông tin xác thực!");
    setTimeout(() => setCopied(false), 2000);
  };

  const currentPolicy = (account.routingPolicy || "normal") as AccountRoutingPolicy;
  const policyLabels: Record<AccountRoutingPolicy, string> = {
    normal: "Chuẩn",
    burn_first: "Ưu tiên tiêu",
    preserve: "Bảo lưu",
  };

  const requestCount = account.requestUsage?.totalRequests ?? 0;
  const totalCostUsd = (account.requestUsage?.totalCostUsd ?? 0).toFixed(2);

  return (
    <div
      className={cn(
        "group relative flex flex-col justify-between rounded-xl border bg-card p-4 text-card-foreground shadow-sm transition-all duration-200 hover:shadow-md",
        isSelected && "border-primary/60 ring-2 ring-primary/20",
        isCodexActive && "ring-2 ring-emerald-500/50 border-emerald-500/60 bg-emerald-500/[0.02]",
        is401 && "border-red-500/40 bg-red-500/[0.02]",
        isPaused && "opacity-75 border-dashed",
      )}
    >
      {/* 1. Card Top Header */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <Checkbox
              checked={isSelected}
              onCheckedChange={(checked) => onToggleSelect(account.accountId, !!checked)}
              aria-label={`Select ${account.email}`}
              className="h-4.5 w-4.5 rounded transition-colors"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  onClick={handleCopyEmail}
                  className={cn(
                    "cursor-pointer truncate font-bold text-sm text-foreground transition-colors hover:text-primary",
                    blurred && "select-none blur-sm",
                  )}
                >
                  {account.alias || account.displayName || account.email}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="font-mono text-xs">{account.email}</p>
                {account.alias ? <p className="text-xs text-muted-foreground">Alias: {account.alias}</p> : null}
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {isCodexActive ? (
              <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/15 px-2 py-0.5 text-xs font-bold text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Hiện tại
              </span>
            ) : null}

            {is401 ? (
              <span className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-xs font-bold text-red-600 dark:text-red-400">
                <ShieldAlert className="h-3.5 w-3.5" />
                401
              </span>
            ) : null}

            <Badge
              variant="outline"
              className={cn(
                "px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider",
                getPlanBadgeStyle(account.planType),
              )}
            >
              {formatSlug(account.planType || "FREE")}
            </Badge>
          </div>
        </div>

        {/* 2. Team Name & Pill Badges */}
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <span className="shrink-0 font-medium">Team Name:</span>
            <span className="truncate font-semibold text-foreground/90">
              {account.workspaceLabel && account.workspaceLabel.trim()
                ? account.workspaceLabel
                : "Tài khoản cá nhân"}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => toast.info(`Thêm vào dịch vụ API: ${account.email}`)}
              className="inline-flex items-center gap-1 rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-1 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-500/20 dark:text-blue-400"
            >
              <LinkIcon className="h-3 w-3" />
              Thêm vào dịch vụ API
            </button>

            <button
              type="button"
              onClick={() => toast.info(`Dấu vân tay ID: ${formatCompactAccountId(account.accountId)}`)}
              className="inline-flex items-center gap-1 rounded-md border border-border/80 bg-muted/60 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Fingerprint className="h-3 w-3" />
              Dấu vân tay
            </button>

            <button
              type="button"
              onClick={() => onSetAlias(account)}
              className="inline-flex items-center gap-1 rounded-md border border-border/80 bg-muted/60 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Đổi tên / Thêm Alias"
            >
              <Plus className="h-3 w-3" />
              Thêm
            </button>

            <button
              type="button"
              onClick={() => onResetCredit(account.accountId)}
              className="inline-flex items-center gap-1 rounded-md border border-border/80 bg-muted/60 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Bấm để dùng lượt đặt lại hạn mức"
            >
              <RotateCcw className="h-3 w-3" />
              Lượt đặt lại {availableCredits}
            </button>
          </div>
        </div>

        {/* 3. Login method & User ID */}
        <div className="truncate text-xs text-muted-foreground">
          Đã đăng nhập bằng Password | ID người dùng:{" "}
          <span className="font-mono font-medium text-foreground/80">{formatCompactAccountId(account.accountId, 8, 4)}</span>
        </div>

        {/* 4. Special 401 Error Box (if 401 or error) */}
        {is401 ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs space-y-2">
            <div className="flex items-center justify-between text-red-600 dark:text-red-400 font-semibold text-xs">
              <span className="inline-flex items-center gap-1">
                <ShieldAlert className="h-4 w-4" />
                Lỗi API 401 (Cần xác thực lại)
              </span>
              <button
                type="button"
                onClick={() => toast.error(account.deactivationReason || `Lỗi 401: Token của ${account.email} đã hết hạn hoặc bị thu hồi.`)}
                className="text-xs underline hover:opacity-80"
              >
                Chi tiết
              </button>
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isAutoReauthing || busy}
                onClick={() => onAutoReauth?.(account.accountId)}
                className="h-8 gap-1 border-emerald-500/40 bg-background text-xs font-semibold text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
              >
                {isAutoReauthing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {isAutoReauthing ? "Đang xử lý..." : "Tự động đăng nhập lại"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onReauth(account)}
                className="h-8 border-red-500/40 bg-background text-xs font-semibold text-red-600 hover:bg-red-500/10 dark:text-red-400"
              >
                Ủy quyền OAuth
              </Button>
            </div>
          </div>
        ) : null}

        {/* 5. Weekly Quota Progress */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-foreground">Weekly</span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-muted-foreground">
                0 req &nbsp; 0 &nbsp; A $0.00
              </span>
              <span
                className={cn(
                  "font-mono font-bold text-xs",
                  clampedRemaining >= 70
                    ? "text-emerald-600 dark:text-emerald-400"
                    : clampedRemaining >= 30
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-red-600 dark:text-red-400",
                )}
              >
                {clampedRemaining}%
              </span>
            </div>
          </div>

          <div className="h-2 w-full overflow-hidden rounded-full bg-muted/80">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-300",
                clampedRemaining >= 70
                  ? "bg-emerald-500"
                  : clampedRemaining >= 30
                    ? "bg-amber-500"
                    : "bg-red-500",
              )}
              style={{ width: `${clampedRemaining}%` }}
            />
          </div>

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium pt-0.5">
            <Clock className="h-3 w-3 text-muted-foreground/80" />
            <span>{resetLabel}</span>
          </div>
        </div>

        {/* 6. Subscription / Token Expiry Banner */}
        {expiryInfo ? (
          <div
            className={cn(
              "flex items-center justify-between rounded-lg border px-3 py-2 text-xs",
              expiryInfo.isExpired
                ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
                : expiryInfo.isExpiringSoon
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
            )}
          >
            <div className="flex items-center gap-1.5 font-semibold">
              <Calendar className="h-4 w-4 shrink-0" />
              <span>{expiryInfo.label}</span>
            </div>
            <span className="font-mono text-xs opacity-90">{expiryInfo.dateStr}</span>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
            <div className="flex items-center gap-1.5 font-semibold">
              <Calendar className="h-4 w-4" />
              <span>Gói hoạt động bình thường</span>
            </div>
          </div>
        )}
      </div>

      {/* 7. Card Footer & Action Toolbar */}
      <div className="mt-3.5 space-y-2.5 border-t border-border/60 pt-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-mono text-[11px]">
            {formatDateTimeInline(account.createdAt, "DD/MM/YYYY HH:mm")}
          </span>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={readOnly || busy}
                className="inline-flex items-center gap-1 rounded-md border border-border/80 bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
              >
                <span>{policyLabels[currentPolicy]}</span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-xs">
              <DropdownMenuItem onClick={() => onRoutingPolicyChange(account.accountId, "normal")}>
                Chuẩn (Mặc định)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRoutingPolicyChange(account.accountId, "burn_first")}>
                Ưu tiên tiêu (Burn First)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRoutingPolicyChange(account.accountId, "preserve")}>
                Bảo lưu (Preserve)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Action Icon Row - 7 icons */}
        <div className="flex items-center justify-between gap-1 pt-0.5">
          {/* 1. Terminal / Probe */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                disabled={busy}
                onClick={() => onProbe(account.accountId)}
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                aria-label="Kiểm tra Endpoint / Probe"
              >
                <Terminal className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Kiểm tra kết nối / Endpoint</TooltipContent>
          </Tooltip>

          {/* 2. Tag / Alias */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                disabled={busy}
                onClick={() => onSetAlias(account)}
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                aria-label="Đổi tên / Alias"
              >
                <Tag className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Đổi tên / Alias</TooltipContent>
          </Tooltip>

          {/* 3. Copy Auth Info */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                disabled={busy}
                onClick={handleCopyAuthInfo}
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                aria-label="Sao chép Auth"
              >
                {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Clipboard className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Sao chép thông tin xác thực</TooltipContent>
          </Tooltip>

          {/* 4. Play / Start Switch to this Account */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                disabled={busy || isSwitchingAny}
                onClick={() => onSwitchToCodex(account.accountId)}
                className={cn(
                  "h-8 w-8 transition-colors",
                  isSwitching
                    ? "border border-emerald-500/50 bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 cursor-wait"
                    : isCodexActive
                      ? "text-emerald-600 bg-emerald-500/20 border border-emerald-500/40 dark:text-emerald-400"
                      : "text-muted-foreground hover:text-emerald-600 hover:bg-emerald-500/10",
                )}
                aria-label={isSwitching ? "Đang xoay tài khoản..." : "Bắt đầu chạy tài khoản này"}
              >
                {isSwitching ? (
                  <Loader2 className="h-4 w-4 animate-spin text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Play className={cn("h-4 w-4", isCodexActive && "fill-emerald-500 text-emerald-500")} />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isSwitching
                ? "Đang đóng ChatGPT cũ, nạp auth và khởi động lại..."
                : isCodexActive
                  ? "Tài khoản đang chạy trong ChatGPT Desktop"
                  : isSwitchingAny
                    ? "Đang xoay tài khoản khác, vui lòng đợi..."
                    : "Xoay sang tài khoản này (Khởi động lại ChatGPT Desktop)"}
            </TooltipContent>
          </Tooltip>

          {/* 5. Refresh Quota */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                disabled={busy}
                onClick={() => onProbe(account.accountId)}
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                aria-label="Đồng bộ hạn mức"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Đồng bộ hạn mức</TooltipContent>
          </Tooltip>

          {/* 6. Export auth.json */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                disabled={busy}
                onClick={() => onExportAuth(account.accountId)}
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                aria-label="Xuất Auth JSON"
              >
                <Download className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Xuất auth.json</TooltipContent>
          </Tooltip>

          {/* 7. Delete */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                disabled={busy || readOnly}
                onClick={() => onDelete(account.accountId)}
                className="h-8 w-8 text-red-500 hover:bg-red-500/10 hover:text-red-600"
                aria-label="Xóa tài khoản"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Xóa tài khoản này</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
