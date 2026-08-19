import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatusValue = "active" | "paused" | "limited" | "exceeded" | "reauth" | "deactivated";

const statusClassMap: Record<StatusValue, string> = {
  active: "bg-emerald-500/15 text-emerald-700 border-emerald-500/20 hover:bg-emerald-500/20 dark:text-emerald-400",
  paused: "bg-amber-500/15 text-amber-700 border-amber-500/20 hover:bg-amber-500/20 dark:text-amber-400",
  limited: "bg-emerald-500/15 text-emerald-700 border-emerald-500/20 hover:bg-emerald-500/20 dark:text-emerald-400",
  exceeded: "bg-emerald-500/15 text-emerald-700 border-emerald-500/20 hover:bg-emerald-500/20 dark:text-emerald-400",
  reauth: "bg-sky-500/15 text-sky-700 border-sky-500/20 hover:bg-sky-500/20 dark:text-sky-300",
  deactivated: "bg-zinc-500/15 text-zinc-600 border-zinc-500/20 hover:bg-zinc-500/20 dark:text-zinc-400",
};

export type StatusBadgeProps = {
  status: StatusValue;
  title?: string;
};

export function StatusBadge({ status, title }: StatusBadgeProps) {
  const { t } = useTranslation();
  const className = statusClassMap[status] ?? statusClassMap.deactivated;
  const displayKey = status === "exceeded" || status === "limited" || status === "active" ? "active" : status;
  const label = t(`common.status.${displayKey}`, { defaultValue: "Active" });

  return (
    <Badge className={cn("gap-1.5", className)} variant="outline" title={title}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </Badge>
  );
}
