import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRightLeft, ArrowUpCircle, RefreshCw, Tag } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { getDashboardOverview } from "@/features/dashboard/api";
import { DEFAULT_OVERVIEW_TIMEFRAME } from "@/features/dashboard/schemas";
import { getServiceReadiness } from "@/features/health/api";
import { getRuntimeVersion } from "@/features/runtime/api";
import { getSettings } from "@/features/settings/api";
import { getAutoLoginStatus } from "@/features/accounts/api";
import { useDateDisplayFormatStore } from "@/hooks/use-date-format";
import { formatTimeLong } from "@/utils/formatters";
import { cn } from "@/lib/utils";

const GITHUB_REPOSITORY_URL = "https://github.com/soju06/codex-lb";
const STATUS_REFRESH_INTERVAL_MS = 60_000;
const USAGE_FRESHNESS_THRESHOLD_MS = 60_000;
export const STATUS_BAR_DEFAULT_HEIGHT_PX = 40;

export interface StatusBarProps {
  onHeightChange?: (height: number) => void;
}

type RoutingStrategy =
  | "usage_weighted"
  | "round_robin"
  | "capacity_weighted"
  | "relative_availability"
  | "fill_first"
  | "single_account"
  | "sequential_drain"
  | "reset_drain";

const ROUTING_STRATEGY_LABEL_KEYS: Record<RoutingStrategy, string> = {
  usage_weighted: "settings.routing.strategy.usageWeighted",
  round_robin: "settings.routing.strategy.roundRobin",
  capacity_weighted: "settings.routing.strategy.capacityWeighted",
  relative_availability: "settings.routing.strategy.relativeAvailability",
  fill_first: "settings.routing.strategy.fillFirst",
  single_account: "settings.routing.strategy.singleAccount",
  sequential_drain: "settings.routing.strategy.sequentialDrain",
  reset_drain: "settings.routing.strategy.resetDrain",
};

const EARLY_RESET_STRATEGIES: ReadonlySet<RoutingStrategy> = new Set([
  "usage_weighted",
  "capacity_weighted",
  "fill_first",
]);

function getRoutingLabel(
  t: TFunction,
  strategy: RoutingStrategy,
  sticky: boolean,
  preferEarlier: boolean,
  preferEarlierWindow: "primary" | "secondary",
): string {
  const strategyLabel = t(ROUTING_STRATEGY_LABEL_KEYS[strategy]);
  const stickyLabel = t("statusBar.routingLabels.stickyThreads");
  const stickyShortLabel = t("statusBar.routingLabels.sticky");
  const supportsEarlyReset = EARLY_RESET_STRATEGIES.has(strategy);
  const showEarlyReset = preferEarlier && supportsEarlyReset;
  if (strategy === "single_account") {
    return strategyLabel;
  }
  const earlyResetLabel =
    preferEarlierWindow === "secondary"
      ? t("statusBar.routingLabels.earlyWeeklyReset")
      : t("statusBar.routingLabels.earlyFiveHourReset");
  if (sticky && showEarlyReset) {
    return t("statusBar.routingLabels.withStickyAndEarlyReset", {
      strategy: strategyLabel,
      sticky: stickyShortLabel,
      reset: earlyResetLabel,
    });
  }
  if (sticky) {
    return t("statusBar.routingLabels.withSticky", {
      strategy: strategyLabel,
      sticky: stickyLabel,
    });
  }
  if (showEarlyReset) {
    return t("statusBar.routingLabels.withEarlyReset", {
      strategy: strategyLabel,
      reset: earlyResetLabel,
    });
  }
  return strategyLabel;
}

export function StatusBar({ onHeightChange }: StatusBarProps = {}) {
  const { t } = useTranslation();
  const footerRef = useRef<HTMLElement>(null);
  const readinessQuery = useQuery({
    queryKey: ["health", "ready"],
    queryFn: getServiceReadiness,
    refetchInterval: STATUS_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const { data: lastSyncAt = null } = useQuery({
    queryKey: ["dashboard", "overview", DEFAULT_OVERVIEW_TIMEFRAME],
    queryFn: () => getDashboardOverview({ timeframe: DEFAULT_OVERVIEW_TIMEFRAME }),
    refetchInterval: STATUS_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    select: (data) => data.lastSyncAt,
  });

  const { data: settings } = useQuery({
    queryKey: ["settings", "detail"],
    queryFn: getSettings,
  });
  const { data: runtimeVersion } = useQuery({
    queryKey: ["runtime", "version"],
    queryFn: getRuntimeVersion,
    retry: false,
    staleTime: 6 * 60 * 60 * 1000,
  });
  const dateDisplayFormat = useDateDisplayFormatStore((state) => state.dateDisplayFormat);
  const lastSync = formatTimeLong(lastSyncAt, dateDisplayFormat);
  const [isUsageSynced, setIsUsageSynced] = useState(false);
  useEffect(() => {
    function check() {
      setIsUsageSynced(
        lastSyncAt
          ? Date.now() - new Date(lastSyncAt).getTime() < USAGE_FRESHNESS_THRESHOLD_MS
          : false,
      );
    }
    check();
    const id = setInterval(check, 10_000);
    return () => clearInterval(id);
  }, [lastSyncAt]);
  const serviceReadiness = readinessQuery.isPending
    ? "checking"
    : !readinessQuery.isError && readinessQuery.data?.status === "ok"
      ? "ready"
      : "notReady";
  const serviceStatusLabel = t(`statusBar.${serviceReadiness}`);
  const usageStatusLabel = t(isUsageSynced ? "statusBar.synced" : "statusBar.stale");

  const routingLabel = settings
    ? getRoutingLabel(
        t,
        settings.routingStrategy,
        settings.stickyThreadsEnabled,
        settings.preferEarlierResetAccounts,
        settings.preferEarlierResetWindow,
      )
    : "—";
  const currentVersion = runtimeVersion?.currentVersion ?? __APP_VERSION__;
  const latestVersion = runtimeVersion?.latestVersion ?? null;
  const showUpdateAvailable = runtimeVersion?.updateAvailable === true && latestVersion;
  const updateLabel = latestVersion
    ? t("statusBar.updateAvailableWithVersion", { version: latestVersion })
    : t("statusBar.updateAvailable");

  const autoLoginQuery = useQuery({
    queryKey: ["auto-login", "status"],
    queryFn: getAutoLoginStatus,
    refetchInterval: 1500,
    refetchIntervalInBackground: true,
  });
  const autoLoginState = autoLoginQuery.data;

  const autoLoginMetrics = useMemo(() => {
    if (!autoLoginState || autoLoginState.queue.length === 0) {
      return null;
    }
    const total = autoLoginState.queue.length;
    const success = autoLoginState.queue.filter((a) => a.status === "SUCCESS").length;
    const failed = autoLoginState.queue.filter((a) => a.status === "FAILED").length;
    const processed = success + failed;
    const currentNum = Math.min(total, processed + 1);
    const percent = Math.min(100, Math.round((processed / total) * 100));
    return { total, success, failed, processed, currentNum, percent };
  }, [autoLoginState]);

  useLayoutEffect(() => {
    const footer = footerRef.current;
    if (!footer || !onHeightChange) {
      return;
    }

    const reportHeight = () => {
      onHeightChange(Math.max(STATUS_BAR_DEFAULT_HEIGHT_PX, footer.offsetHeight));
    };
    reportHeight();

    const observer = new ResizeObserver(reportHeight);
    observer.observe(footer);
    return () => observer.disconnect();
  }, [onHeightChange]);

  return (
    <footer
      ref={footerRef}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border/80 bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <div className="mx-auto flex w-full max-w-[1500px] items-center gap-4 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                serviceReadiness === "ready"
                  ? "bg-emerald-500"
                  : serviceReadiness === "checking"
                    ? "bg-amber-500"
                    : "bg-red-500"
              }`}
            />
            <span className="font-medium">{t("statusBar.serviceReady")}</span>{" "}
            <span>{serviceStatusLabel}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                isUsageSynced ? "bg-emerald-500" : "bg-amber-500"
              }`}
            />
            <span className="font-medium">{t("statusBar.usageSynced")}</span>{" "}
            <span>{usageStatusLabel}</span> · {lastSync.time}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ArrowRightLeft className="h-3 w-3" aria-hidden="true" />
            <span className="font-medium">{t("statusBar.routing")}</span> {routingLabel}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Tag className="h-3 w-3" aria-hidden="true" />
            <span className="font-medium">{t("statusBar.version")}</span> {currentVersion}
            {showUpdateAvailable ? (
              <a
                aria-label={updateLabel}
                className="inline-flex h-4 w-4 items-center justify-center rounded-full text-amber-500 transition-colors hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 focus-visible:ring-offset-2"
                href={runtimeVersion.releaseUrl}
                rel="noreferrer"
                target="_blank"
                title={updateLabel}
              >
                <ArrowUpCircle className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            ) : null}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {autoLoginState && autoLoginMetrics && (autoLoginState.status === "running" || autoLoginState.status === "paused") ? (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("open-auto-login-dialog"))}
              className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary transition-all hover:bg-primary/20 hover:scale-105"
              title="Bấm để mở Live Log Console"
            >
              <RefreshCw className={cn("h-3 w-3", autoLoginState.status === "running" ? "animate-spin" : "")} />
              <span>
                {autoLoginState.status === "running" ? "Đăng nhập ngầm" : "Tạm dừng"}: [{autoLoginMetrics.currentNum}/{autoLoginMetrics.total}]
              </span>
              <span className="rounded bg-primary/20 px-1.5 py-0.2 text-[10px] font-bold">
                {autoLoginMetrics.percent}%
              </span>
            </button>
          ) : null}

          <a
            aria-label={t("statusBar.repositoryLabel")}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/70 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            href={GITHUB_REPOSITORY_URL}
            rel="noreferrer"
            target="_blank"
            title="GitHub"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.63 7.63 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
        </div>
      </div>
    </footer>
  );
}