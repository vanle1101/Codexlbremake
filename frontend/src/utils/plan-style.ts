export function getPlanBadgeStyle(planType: string | null | undefined): string {
  const plan = (planType || "").toLowerCase().trim();
  switch (plan) {
    case "plus":
      return "border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.2)]";
    case "pro":
      return "border-purple-500/40 bg-purple-500/15 text-purple-600 dark:text-purple-400 shadow-[0_0_8px_rgba(168,85,247,0.25)]";
    case "team":
      return "border-sky-500/40 bg-sky-500/15 text-sky-600 dark:text-sky-400 shadow-[0_0_8px_rgba(14,165,233,0.25)]";
    case "enterprise":
    case "business":
      return "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.25)]";
    case "edu":
      return "border-teal-500/40 bg-teal-500/15 text-teal-600 dark:text-teal-400 shadow-[0_0_8px_rgba(20,184,166,0.25)]";
    case "free":
      return "border-zinc-500/40 bg-zinc-500/15 text-zinc-600 dark:text-zinc-400";
    default:
      return "border-zinc-500/40 bg-zinc-500/15 text-zinc-600 dark:text-zinc-400";
  }
}