import {
  AlertTriangle,
  Bot,
  CheckSquare,
  Clock,
  Download,
  Filter,
  Layers,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  Upload,
  Users,
  Zap,
} from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { AlertMessage } from "@/components/alert-message";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LoadingOverlay } from "@/components/layout/loading-overlay";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AccountGridCard } from "@/features/accounts/components/account-grid-card";
import { AccountsSkeleton } from "@/features/accounts/components/accounts-skeleton";
import { AddAccountDialog } from "@/features/accounts/components/add-account-dialog";
import { AuthExportDialog } from "@/features/accounts/components/auth-export-dialog";
import { ImportDialog } from "@/features/accounts/components/import-dialog";
import { ReauthCredentialsDialog } from "@/features/accounts/components/reauth-credentials-dialog";
import { ResetCreditConfirmDialog } from "@/features/accounts/components/reset-credit-confirm-dialog";
import { launchCodexCli } from "@/features/accounts/api";
import { useAccounts, useCodexActiveAccount } from "@/features/accounts/hooks/use-accounts";
import { useOauth } from "@/features/accounts/hooks/use-oauth";
import type {
  AccountAuthExportResponse,
  AccountRoutingPolicy,
  AccountSummary,
} from "@/features/accounts/schemas";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { useDialogState } from "@/hooks/use-dialog-state";
import { cn } from "@/lib/utils";
import { normalizeStatus } from "@/utils/account-status";
import { getErrorMessageOrNull } from "@/utils/errors";

const OauthDialog = lazy(() =>
  import("@/features/accounts/components/oauth-dialog").then((m) => ({
    default: m.OauthDialog,
  })),
);

const AutoLoginDialog = lazy(() =>
  import("@/features/accounts/components/auto-login-dialog").then((m) => ({
    default: m.AutoLoginDialog,
  })),
);

type StatusFilter = "all" | "active" | "exceeded" | "paused" | "401";
type PlanFilter = "all" | "plus" | "team" | "pro" | "free";
type SortOption = "quota_desc" | "quota_asc" | "credits_desc" | "newest" | "name_asc";

export function AccountsGridPage() {
  const { t } = useTranslation();
  const {
    accountsQuery,
    importMutation,
    pauseMutation,
    resumeMutation,
    setAliasMutation,
    probeMutation,
    deleteMutation,
    routingPolicyMutation,
    exportAuthMutation,
    switchToCodexMutation,
    autoReauthMutation,
  } = useAccounts();

  const oauth = useOauth();
  const { data: codexActive } = useCodexActiveAccount();
  const canWrite = useAuthStore((state) => state.canWrite);

  // Filter & Search states
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [planFilter, setPlanFilter] = useState<PlanFilter>("all");
  const [sortOption, setSortOption] = useState<SortOption>("quota_desc");

  // Selection states for bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Dialog states
  const addAccountDialog = useDialogState();
  const importDialog = useDialogState();
  const oauthDialog = useDialogState();
  const autoLoginDialog = useDialogState();
  const reauthDialog = useDialogState<AccountSummary>();
  const deleteDialog = useDialogState<string>();
  const bulkDeleteDialog = useDialogState();
  const exportDialog = useDialogState<AccountAuthExportResponse>();

  type ResetCreditTarget = { accountId: string; availableResetCredits: number };
  const resetCreditDialog = useDialogState<ResetCreditTarget>();

  type AliasTarget = { accountId: string; email: string; currentAlias: string };
  const [aliasTarget, setAliasTarget] = useState<AliasTarget | null>(null);
  const [aliasInputValue, setAliasInputValue] = useState("");

  const [oauthAccountId, setOauthAccountId] = useState<string | null>(null);

  // Global event listener to open auto login dialog from Footer
  useEffect(() => {
    const handleOpenAutoLogin = () => {
      autoLoginDialog.show();
    };
    window.addEventListener("open-auto-login-dialog", handleOpenAutoLogin);
    return () => {
      window.removeEventListener("open-auto-login-dialog", handleOpenAutoLogin);
    };
  }, [autoLoginDialog]);

  const rawAccounts = accountsQuery.data ?? [];

  // Filtered & Sorted accounts
  const accounts = useMemo(() => {
    let list = [...rawAccounts];

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (a) =>
          a.email.toLowerCase().includes(q) ||
          (a.alias && a.alias.toLowerCase().includes(q)) ||
          a.accountId.toLowerCase().includes(q) ||
          (a.workspaceLabel && a.workspaceLabel.toLowerCase().includes(q)),
      );
    }

    // Status filter
    if (statusFilter !== "all") {
      list = list.filter((a) => {
        const s = normalizeStatus(a.status);
        if (statusFilter === "401") return s === "reauth" || s === "deactivated" || a.status === "reauth_required" || s === "error";
        if (statusFilter === "active") return s === "active";
        if (statusFilter === "exceeded") return s === "exceeded" || s === "limited";
        if (statusFilter === "paused") return s === "paused";
        return true;
      });
    }

    // Plan filter
    if (planFilter !== "all") {
      list = list.filter((a) => (a.planType || "").toLowerCase() === planFilter);
    }

    // Sorting
    list.sort((a, b) => {
      if (sortOption === "quota_desc") {
        const qA = a.usage?.secondaryRemainingPercent ?? a.usage?.primaryRemainingPercent ?? 0;
        const qB = b.usage?.secondaryRemainingPercent ?? b.usage?.primaryRemainingPercent ?? 0;
        return qB - qA;
      }
      if (sortOption === "quota_asc") {
        const qA = a.usage?.secondaryRemainingPercent ?? a.usage?.primaryRemainingPercent ?? 0;
        const qB = b.usage?.secondaryRemainingPercent ?? b.usage?.primaryRemainingPercent ?? 0;
        return qA - qB;
      }
      if (sortOption === "credits_desc") {
        const cA = a.capacityCreditsSecondary ?? a.capacityCreditsPrimary ?? 0;
        const cB = b.capacityCreditsSecondary ?? b.capacityCreditsPrimary ?? 0;
        return cB - cA;
      }
      if (sortOption === "newest") {
        const tA = new Date(a.createdAt || 0).getTime();
        const tB = new Date(b.createdAt || 0).getTime();
        return tB - tA;
      }
      if (sortOption === "name_asc") {
        return (a.alias || a.email).localeCompare(b.alias || b.email);
      }
      return 0;
    });

    return list;
  }, [rawAccounts, search, statusFilter, planFilter, sortOption]);

  // Multi-select handlers
  const handleToggleSelect = useCallback((accountId: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(accountId);
      } else {
        next.delete(accountId);
      }
      return next;
    });
  }, []);

  const handleSelectAll = () => {
    if (selectedIds.size === accounts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(accounts.map((a) => a.accountId)));
    }
  };

  // Bulk actions
  const handleBulkPause = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    toast.info(`Đang tạm dừng ${ids.length} tài khoản...`);
    await Promise.all(ids.map((id) => pauseMutation.mutateAsync(id).catch(() => null)));
    toast.success(`Đã tạm dừng ${ids.length} tài khoản`);
  };

  const handleBulkResume = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    toast.info(`Đang kích hoạt ${ids.length} tài khoản...`);
    await Promise.all(ids.map((id) => resumeMutation.mutateAsync(id).catch(() => null)));
    toast.success(`Đã kích hoạt ${ids.length} tài khoản`);
  };

  const handleBulkProbe = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    toast.info(`Đang đồng bộ ${ids.length} tài khoản...`);
    await Promise.all(ids.map((id) => probeMutation.mutateAsync({ accountId: id }).catch(() => null)));
    toast.success(`Đã hoàn tất đồng bộ ${ids.length} tài khoản`);
  };

  const handleBulkDeleteConfirm = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    bulkDeleteDialog.hide();
    toast.info(`Đang xóa ${ids.length} tài khoản...`);
    await Promise.all(ids.map((id) => deleteMutation.mutateAsync({ accountId: id }).catch(() => null)));
    setSelectedIds(new Set());
    toast.success(`Đã xóa ${ids.length} tài khoản`);
  };

  // Single card actions
  const handleReauth = (account: AccountSummary) => {
    setOauthAccountId(account.accountId);
    oauthDialog.show();
  };

  const handleSetAlias = (account: AccountSummary) => {
    setAliasTarget({
      accountId: account.accountId,
      email: account.email,
      currentAlias: account.alias || "",
    });
    setAliasInputValue(account.alias || "");
  };

  const handleSaveAlias = async () => {
    if (!aliasTarget) return;
    try {
      await setAliasMutation.mutateAsync({
        accountId: aliasTarget.accountId,
        alias: aliasInputValue.trim() || null,
      });
      toast.success("Đã cập nhật tên đại diện (Alias)");
      setAliasTarget(null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Lỗi đổi tên");
    }
  };

  const handleExportAuth = async (accountId: string) => {
    try {
      const result = await exportAuthMutation.mutateAsync(accountId);
      exportDialog.show(result);
    } catch {
      // Handled by hook toast
    }
  };

  const handleAutoReauth = async (account: AccountSummary) => {
    try {
      const res = await autoReauthMutation.mutateAsync(account.accountId);
      if (res.needs_credentials || res.needsCredentials) {
        reauthDialog.show(account);
      }
    } catch {
      reauthDialog.show(account);
    }
  };

  const handleResetCredit = (accountId: string) => {
    const account = rawAccounts.find((item) => item.accountId === accountId);
    resetCreditDialog.show({
      accountId,
      availableResetCredits: account?.capacityCreditsSecondary ?? account?.capacityCreditsPrimary ?? 0,
    });
  };

  const handleRoutingPolicyChange = (accountId: string, policy: AccountRoutingPolicy) => {
    void routingPolicyMutation.mutateAsync({ accountId, routingPolicy: policy });
  };

  // Metrics breakdown
  const totalCount = rawAccounts.length;
  const activeCount = rawAccounts.filter((a) => normalizeStatus(a.status) === "active").length;
  const exceededCount = rawAccounts.filter(
    (a) => normalizeStatus(a.status) === "exceeded" || normalizeStatus(a.status) === "limited",
  ).length;
  const pausedCount = rawAccounts.filter((a) => normalizeStatus(a.status) === "paused").length;
  const error401Count = rawAccounts.filter(
    (a) =>
      normalizeStatus(a.status) === "reauth" ||
      normalizeStatus(a.status) === "deactivated" ||
      a.status === "reauth_required" ||
      normalizeStatus(a.status) === "error",
  ).length;

  const mutationBusy =
    pauseMutation.isPending ||
    resumeMutation.isPending ||
    probeMutation.isPending ||
    deleteMutation.isPending ||
    setAliasMutation.isPending ||
    routingPolicyMutation.isPending ||
    exportAuthMutation.isPending;

  const errorMessage =
    getErrorMessageOrNull(accountsQuery.error) ||
    getErrorMessageOrNull(pauseMutation.error) ||
    getErrorMessageOrNull(resumeMutation.error) ||
    getErrorMessageOrNull(probeMutation.error) ||
    getErrorMessageOrNull(deleteMutation.error) ||
    getErrorMessageOrNull(setAliasMutation.error) ||
    getErrorMessageOrNull(routingPolicyMutation.error) ||
    getErrorMessageOrNull(exportAuthMutation.error);

  const isSwitchingAny = switchToCodexMutation.isPending;
  const switchingAccountId = switchToCodexMutation.isPending ? switchToCodexMutation.variables : null;

  return (
    <div className="space-y-6">
      {/* 1. Header & Summary Stats */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" />
            Tài khoản (Thẻ)
          </h1>
          <p className="text-sm text-muted-foreground">
            Quản lý danh sách tài khoản theo giao diện thẻ trực quan, theo dõi hạn mức, gói cước và thao tác nhanh.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="border-indigo-500/40 bg-indigo-500/10 text-indigo-600 hover:bg-indigo-500/20 dark:text-indigo-400 font-semibold"
            onClick={async () => {
              try {
                await launchCodexCli();
                toast.success("Đã mở cửa sổ Codex CLI thành công!");
              } catch (e: any) {
                toast.error(e?.message || "Không thể mở Codex CLI");
              }
            }}
          >
            <Zap className="mr-2 h-4 w-4 fill-indigo-500 text-indigo-500" />
            Mở ChatGPT / Codex
          </Button>

          <Button
            type="button"
            variant="outline"
            className="border-primary/40 text-primary hover:bg-primary/10"
            onClick={() => autoLoginDialog.show()}
          >
            <Bot className="mr-2 h-4 w-4 text-primary" />
            Đăng nhập tự động
          </Button>

          <Button
            type="button"
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => addAccountDialog.show()}
          >
            <Plus className="mr-2 h-4 w-4" />
            Thêm tài khoản
          </Button>

          <Button
            type="button"
            variant="outline"
            disabled={mutationBusy}
            onClick={() => void accountsQuery.refetch()}
            title="Tải lại danh sách"
          >
            <RefreshCw className={cn("h-4 w-4", accountsQuery.isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* 2. Stat badges */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="text-xs text-muted-foreground font-medium">Tổng tài khoản</div>
          <div className="text-xl font-bold text-foreground mt-1">{totalCount}</div>
        </div>
        <div className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">Còn hạn mức (Khả dụng)</div>
          <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">{activeCount}</div>
        </div>
        <div className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="text-xs text-amber-600 dark:text-amber-400 font-medium">Hết hạn mức (Chờ reset)</div>
          <div className="text-xl font-bold text-amber-600 dark:text-amber-400 mt-1">{exceededCount}</div>
        </div>
        <div className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="text-xs text-muted-foreground font-medium">Tạm dừng</div>
          <div className="text-xl font-bold text-foreground/80 mt-1">{pausedCount}</div>
        </div>
        <div className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="text-xs text-red-600 dark:text-red-400 font-medium">Lỗi / Cần xác thực lại (401)</div>
          <div className="text-xl font-bold text-red-600 dark:text-red-400 mt-1">{error401Count}</div>
        </div>
      </div>

      {/* 3. Filter & Search Toolbar */}
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm md:flex-row md:items-center md:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <div className="relative min-w-[240px] flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Tìm theo email, alias, ID, team..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 text-xs"
            />
          </div>

          <Select value={statusFilter} onValueChange={(val) => setStatusFilter(val as StatusFilter)}>
            <SelectTrigger className="w-[170px] text-xs">
              <SelectValue placeholder="Trạng thái" />
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="all">Tất cả trạng thái ({totalCount})</SelectItem>
              <SelectItem value="active">Còn hạn mức ({activeCount})</SelectItem>
              <SelectItem value="exceeded">Hết hạn mức - Chờ reset ({exceededCount})</SelectItem>
              <SelectItem value="paused">Tạm dừng ({pausedCount})</SelectItem>
              <SelectItem value="401">Lỗi 401 / Cần xác thực ({error401Count})</SelectItem>
            </SelectContent>
          </Select>

          <Select value={planFilter} onValueChange={(val) => setPlanFilter(val as PlanFilter)}>
            <SelectTrigger className="w-[130px] text-xs">
              <SelectValue placeholder="Gói cước" />
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="all">Tất cả gói</SelectItem>
              <SelectItem value="plus">PLUS</SelectItem>
              <SelectItem value="team">TEAM</SelectItem>
              <SelectItem value="pro">PRO</SelectItem>
              <SelectItem value="free">FREE</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Select value={sortOption} onValueChange={(val) => setSortOption(val as SortOption)}>
            <SelectTrigger className="w-[170px] text-xs">
              <SelectValue placeholder="Sắp xếp" />
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="quota_desc">Hạn mức tuần (Cao → Thấp)</SelectItem>
              <SelectItem value="quota_asc">Hạn mức tuần (Thấp → Cao)</SelectItem>
              <SelectItem value="credits_desc">Lượt Reset nhiều nhất</SelectItem>
              <SelectItem value="newest">Mới thêm gần đây</SelectItem>
              <SelectItem value="name_asc">Tên tài khoản (A-Z)</SelectItem>
            </SelectContent>
          </Select>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleSelectAll}
            className="text-xs shrink-0"
          >
            <CheckSquare className="mr-1.5 h-3.5 w-3.5" />
            {selectedIds.size === accounts.length && accounts.length > 0 ? "Bỏ chọn tất cả" : "Chọn tất cả"}
          </Button>
        </div>
      </div>

      {/* 4. Bulk Action Floating Bar (when items selected) */}
      {selectedIds.size > 0 ? (
        <div className="sticky top-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-background/95 p-3 shadow-lg backdrop-blur">
          <div className="flex items-center gap-2 text-xs font-semibold text-primary">
            <span>Đã chọn: {selectedIds.size} / {accounts.length} tài khoản</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleBulkResume}
              className="h-8 text-xs text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
            >
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Kích hoạt ({selectedIds.size})
            </Button>

            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleBulkPause}
              className="h-8 text-xs text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
            >
              <Pause className="mr-1.5 h-3.5 w-3.5" />
              Tạm dừng ({selectedIds.size})
            </Button>

            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleBulkProbe}
              className="h-8 text-xs"
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Đồng bộ ({selectedIds.size})
            </Button>

            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => bulkDeleteDialog.show()}
              className="h-8 text-xs"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Xóa ({selectedIds.size})
            </Button>
          </div>
        </div>
      ) : null}

      {/* Error alert message */}
      {errorMessage ? (
        <AlertMessage variant="error" message={errorMessage} />
      ) : null}

      {/* 5. Account Cards Grid */}
      {accountsQuery.isPending ? (
        <AccountsSkeleton />
      ) : accounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed p-12 text-center">
          <Users className="h-10 w-10 text-muted-foreground" />
          <h3 className="mt-3 text-base font-semibold text-foreground">Không tìm thấy tài khoản nào</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {search || statusFilter !== "all" || planFilter !== "all"
              ? "Hãy thử điều chỉnh bộ lọc hoặc từ khóa tìm kiếm."
              : "Bấm nút 'Thêm tài khoản' hoặc 'Đăng nhập tự động' để bắt đầu thêm tài khoản."}
          </p>
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={() => autoLoginDialog.show()}>
              <Bot className="mr-2 h-4 w-4" />
              Đăng nhập tự động
            </Button>
            <Button size="sm" variant="outline" onClick={() => addAccountDialog.show()}>
              <Plus className="mr-2 h-4 w-4" />
              Thêm tài khoản
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-4">
          {accounts.map((account) => (
            <AccountGridCard
              key={account.accountId}
              account={account}
              isSelected={selectedIds.has(account.accountId)}
              isCodexActive={
                !!codexActive?.email &&
                (codexActive.email === account.email ||
                  codexActive.accountId === account.accountId ||
                  codexActive.account_id === account.accountId)
              }
              isSwitching={switchingAccountId === account.accountId}
              isSwitchingAny={isSwitchingAny}
              isAutoReauthing={autoReauthMutation.isPending && autoReauthMutation.variables === account.accountId}
              onAutoReauth={() => void handleAutoReauth(account)}
              onToggleSelect={handleToggleSelect}
              busy={mutationBusy}
              readOnly={!canWrite}
              onSwitchToCodex={(id) => void switchToCodexMutation.mutateAsync(id)}
              onPause={(id) => void pauseMutation.mutateAsync(id)}
              onResume={(id) => void resumeMutation.mutateAsync(id)}
              onProbe={(id) => void probeMutation.mutateAsync({ accountId: id })}
              onDelete={(id) => deleteDialog.show(id)}
              onReauth={handleReauth}
              onExportAuth={handleExportAuth}
              onResetCredit={handleResetCredit}
              onRoutingPolicyChange={handleRoutingPolicyChange}
              onSetAlias={handleSetAlias}
            />
          ))}
        </div>
      )}

      {/* 6. Modals & Dialogs */}
      <AddAccountDialog
        open={addAccountDialog.open}
        onOpenChange={addAccountDialog.onOpenChange}
        onImport={() => importDialog.show()}
        onAddAccount={() => {
          setOauthAccountId(null);
          oauthDialog.show();
        }}
        onAutoLogin={() => autoLoginDialog.show()}
      />

      <ImportDialog
        open={importDialog.open}
        busy={importMutation.isPending}
        onOpenChange={importDialog.onOpenChange}
        onImport={async (file) => {
          await importMutation.mutateAsync(file);
          importDialog.hide();
        }}
      />

      {oauthDialog.open ? (
        <Suspense fallback={null}>
          <OauthDialog
            open={oauthDialog.open}
            onOpenChange={oauthDialog.onOpenChange}
            accountId={oauthAccountId}
            startFlow={oauth.startFlow}
            checkStatus={oauth.checkStatus}
            completeFlow={oauth.completeFlow}
            manualCallback={oauth.manualCallback}
          />
        </Suspense>
      ) : null}

      {autoLoginDialog.open ? (
        <Suspense fallback={null}>
          <AutoLoginDialog
            open={autoLoginDialog.open}
            onOpenChange={autoLoginDialog.onOpenChange}
          />
        </Suspense>
      ) : null}

      <ReauthCredentialsDialog
        open={reauthDialog.open}
        onOpenChange={reauthDialog.onOpenChange}
        account={reauthDialog.data}
        onSuccess={() => void accountsQuery.refetch()}
        onSwitchToOauth={() => {
          if (reauthDialog.data) {
            handleReauth(reauthDialog.data);
          }
        }}
      />

      <AuthExportDialog
        open={exportDialog.open}
        onOpenChange={exportDialog.onOpenChange}
        data={exportDialog.data}
      />

      {resetCreditDialog.data ? (
        <ResetCreditConfirmDialog
          open={resetCreditDialog.open}
          onOpenChange={resetCreditDialog.onOpenChange}
          accountId={resetCreditDialog.data.accountId}
          availableResetCredits={resetCreditDialog.data.availableResetCredits}
        />
      ) : null}

      {/* Single Account Delete Dialog */}
      <ConfirmDialog
        open={deleteDialog.open}
        onOpenChange={deleteDialog.onOpenChange}
        title={t("accounts.deleteDialog.title")}
        description={t("accounts.deleteDialog.description")}
        confirmLabel={t("accounts.deleteDialog.confirm")}
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={async () => {
          if (deleteDialog.data) {
            await deleteMutation.mutateAsync({
              accountId: deleteDialog.data,
              deleteHistory: false,
            });
            deleteDialog.hide();
          }
        }}
      />

      {/* Bulk Delete Confirm Dialog */}
      <ConfirmDialog
        open={bulkDeleteDialog.open}
        onOpenChange={bulkDeleteDialog.onOpenChange}
        title={`Xác nhận xóa ${selectedIds.size} tài khoản?`}
        description="Thao tác này sẽ xóa tất cả tài khoản đã chọn khỏi hệ thống. Bạn có chắc chắn muốn tiếp tục không?"
        confirmLabel="Xóa tất cả đã chọn"
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={handleBulkDeleteConfirm}
      />

      {/* Edit Alias / Tag Dialog */}
      <Dialog open={!!aliasTarget} onOpenChange={(open) => !open && setAliasTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Đổi tên đại diện (Alias)</DialogTitle>
            <DialogDescription>
              Đặt tên nhận diện hoặc tag cho tài khoản <strong>{aliasTarget?.email}</strong>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <Input
              value={aliasInputValue}
              onChange={(e) => setAliasInputValue(e.target.value)}
              placeholder="Nhập tên đại diện / Alias..."
              autoFocus
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAliasTarget(null)}>
              Hủy
            </Button>
            <Button type="button" onClick={handleSaveAlias} disabled={setAliasMutation.isPending}>
              Lưu thay đổi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}