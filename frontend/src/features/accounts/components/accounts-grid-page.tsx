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
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { AlertMessage } from "@/components/alert-message";
import { ConfirmDialog } from "@/components/confirm-dialog";
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
    toast.info(t("accounts.grid.bulk.pausing", { count: ids.length }));
    await Promise.all(ids.map((id) => pauseMutation.mutateAsync(id).catch(() => null)));
    toast.success(t("accounts.grid.bulk.paused", { count: ids.length }));
  };

  const handleBulkResume = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    toast.info(t("accounts.grid.bulk.resuming", { count: ids.length }));
    await Promise.all(ids.map((id) => resumeMutation.mutateAsync(id).catch(() => null)));
    toast.success(t("accounts.grid.bulk.resumed", { count: ids.length }));
  };

  const handleBulkProbe = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    toast.info(t("accounts.grid.bulk.probing", { count: ids.length }));
    await Promise.all(ids.map((id) => probeMutation.mutateAsync({ accountId: id }).catch(() => null)));
    toast.success(t("accounts.grid.bulk.probed", { count: ids.length }));
  };

  const handleBulkDeleteConfirm = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    bulkDeleteDialog.hide();
    toast.info(t("accounts.grid.bulk.deleting", { count: ids.length }));
    await Promise.all(ids.map((id) => deleteMutation.mutateAsync({ accountId: id }).catch(() => null)));
    setSelectedIds(new Set());
    toast.success(t("accounts.grid.bulk.deleted", { count: ids.length }));
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
      toast.success(t("accounts.grid.aliasDialog.success"));
      setAliasTarget(null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Error");
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
            {t("accounts.grid.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("accounts.grid.description")}
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
                toast.success(t("accounts.grid.codexLaunched"));
              } catch (e: any) {
                toast.error(e?.message || t("accounts.grid.codexLaunchError"));
              }
            }}
          >
            <Zap className="mr-2 h-4 w-4 fill-indigo-500 text-indigo-500" />
            {t("accounts.grid.openCodex")}
          </Button>

          <Button
            type="button"
            variant="outline"
            className="border-primary/40 text-primary hover:bg-primary/10"
            onClick={() => autoLoginDialog.show()}
          >
            <Bot className="mr-2 h-4 w-4 text-primary" />
            {t("accounts.grid.autoLogin")}
          </Button>

          <Button
            type="button"
            variant="outline"
            className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400 font-semibold"
            onClick={() => {
              window.open("/api/accounts/export-all-json", "_blank");
              toast.success(t("accounts.grid.exportAllSuccess"));
            }}
            title={t("accounts.grid.exportAllJson")}
          >
            <Download className="mr-2 h-4 w-4" />
            {t("accounts.grid.exportAllJson")}
          </Button>

          <Button
            type="button"
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => addAccountDialog.show()}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t("accounts.grid.addAccount")}
          </Button>

          <Button
            type="button"
            variant="outline"
            disabled={mutationBusy}
            onClick={() => void accountsQuery.refetch()}
            title={t("accounts.grid.refreshList")}
          >
            <RefreshCw className={cn("h-4 w-4", accountsQuery.isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* 2. Stat badges */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="text-xs text-muted-foreground font-medium">{t("accounts.grid.stats.total")}</div>
          <div className="text-xl font-bold text-foreground mt-1">{totalCount}</div>
        </div>
        <div className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">{t("accounts.grid.stats.active")}</div>
          <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">{activeCount}</div>
        </div>
        <div className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="text-xs text-amber-600 dark:text-amber-400 font-medium">{t("accounts.grid.stats.exceeded")}</div>
          <div className="text-xl font-bold text-amber-600 dark:text-amber-400 mt-1">{exceededCount}</div>
        </div>
        <div className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="text-xs text-muted-foreground font-medium">{t("accounts.grid.stats.paused")}</div>
          <div className="text-xl font-bold text-foreground/80 mt-1">{pausedCount}</div>
        </div>
        <div className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="text-xs text-red-600 dark:text-red-400 font-medium">{t("accounts.grid.stats.reauth")}</div>
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
              placeholder={t("accounts.grid.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 text-xs"
            />
          </div>

          <Select value={statusFilter} onValueChange={(val) => setStatusFilter(val as StatusFilter)}>
            <SelectTrigger className="w-[170px] text-xs">
              <SelectValue placeholder={t("accounts.grid.statusPlaceholder")} />
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="all">{t("accounts.grid.status.all", { count: totalCount })}</SelectItem>
              <SelectItem value="active">{t("accounts.grid.status.active", { count: activeCount })}</SelectItem>
              <SelectItem value="exceeded">{t("accounts.grid.status.exceeded", { count: exceededCount })}</SelectItem>
              <SelectItem value="paused">{t("accounts.grid.status.paused", { count: pausedCount })}</SelectItem>
              <SelectItem value="401">{t("accounts.grid.status.reauth", { count: error401Count })}</SelectItem>
            </SelectContent>
          </Select>

          <Select value={planFilter} onValueChange={(val) => setPlanFilter(val as PlanFilter)}>
            <SelectTrigger className="w-[130px] text-xs">
              <SelectValue placeholder={t("accounts.grid.planPlaceholder")} />
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="all">{t("accounts.grid.plan.all")}</SelectItem>
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
              <SelectValue placeholder={t("accounts.grid.sortPlaceholder")} />
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="quota_desc">{t("accounts.grid.sort.quotaDesc")}</SelectItem>
              <SelectItem value="quota_asc">{t("accounts.grid.sort.quotaAsc")}</SelectItem>
              <SelectItem value="credits_desc">{t("accounts.grid.sort.creditsDesc")}</SelectItem>
              <SelectItem value="newest">{t("accounts.grid.sort.newest")}</SelectItem>
              <SelectItem value="name_asc">{t("accounts.grid.sort.nameAsc")}</SelectItem>
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
            {selectedIds.size === accounts.length && accounts.length > 0 ? t("accounts.grid.deselectAll") : t("accounts.grid.selectAll")}
          </Button>
        </div>
      </div>

      {/* 4. Bulk Action Floating Bar (when items selected) */}
      {selectedIds.size > 0 ? (
        <div className="sticky top-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-background/95 p-3 shadow-lg backdrop-blur">
          <div className="flex items-center gap-2 text-xs font-semibold text-primary">
            <span>{t("accounts.grid.bulk.selectedCount", { count: selectedIds.size, total: accounts.length })}</span>
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
              {t("accounts.grid.bulk.resume", { count: selectedIds.size })}
            </Button>

            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleBulkPause}
              className="h-8 text-xs text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
            >
              <Pause className="mr-1.5 h-3.5 w-3.5" />
              {t("accounts.grid.bulk.pause", { count: selectedIds.size })}
            </Button>

            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleBulkProbe}
              className="h-8 text-xs"
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t("accounts.grid.bulk.probe", { count: selectedIds.size })}
            </Button>

            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => bulkDeleteDialog.show()}
              className="h-8 text-xs"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {t("accounts.grid.bulk.delete", { count: selectedIds.size })}
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
          <h3 className="mt-3 text-base font-semibold text-foreground">{t("accounts.grid.empty.title")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {search || statusFilter !== "all" || planFilter !== "all"
              ? t("accounts.grid.empty.descFilter")
              : t("accounts.grid.empty.descEmpty")}
          </p>
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={() => autoLoginDialog.show()}>
              <Bot className="mr-2 h-4 w-4" />
              {t("accounts.grid.autoLogin")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => addAccountDialog.show()}>
              <Plus className="mr-2 h-4 w-4" />
              {t("accounts.grid.addAccount")}
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
        title={t("accounts.grid.bulk.deleteConfirmTitle", { count: selectedIds.size })}
        description={t("accounts.grid.bulk.deleteConfirmDesc")}
        confirmLabel={t("accounts.grid.bulk.deleteConfirmBtn")}
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={handleBulkDeleteConfirm}
      />

      {/* Edit Alias / Tag Dialog */}
      <Dialog open={!!aliasTarget} onOpenChange={(open) => !open && setAliasTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("accounts.grid.aliasDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("accounts.grid.aliasDialog.desc")} <strong>{aliasTarget?.email}</strong>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <Input
              value={aliasInputValue}
              onChange={(e) => setAliasInputValue(e.target.value)}
              placeholder={t("accounts.grid.aliasDialog.placeholder")}
              autoFocus
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAliasTarget(null)}>
              {t("accounts.grid.aliasDialog.cancel")}
            </Button>
            <Button type="button" onClick={handleSaveAlias} disabled={setAliasMutation.isPending}>
              {t("accounts.grid.aliasDialog.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
