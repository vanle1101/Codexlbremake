import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { normalizeSupportedLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/i18n";

const LANGUAGE_LABEL_KEY: Record<SupportedLanguage, string> = {
  vi: "Tiếng Việt",
  en: "English",
};

export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const current = normalizeSupportedLanguage(i18n.resolvedLanguage ?? i18n.language);

  const toggleLanguage = () => {
    const next: SupportedLanguage = current === "vi" ? "en" : "vi";
    void i18n.changeLanguage(next);
    toast.success(next === "vi" ? "Đã chuyển sang Tiếng Việt" : "Switched to English", {
      duration: 1500,
    });
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={toggleLanguage}
      aria-label={t("common.language")}
      title={current === "vi" ? "Ngôn ngữ: Tiếng Việt (Bấm để chuyển sang English)" : "Language: English (Click to switch to Tiếng Việt)"}
      className="press-scale hidden h-8 items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 px-2.5 text-xs font-semibold text-foreground transition-all duration-200 hover:bg-muted hover:border-border sm:inline-flex"
    >
      <Languages className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
      <span className="font-mono text-[11px] font-bold uppercase">{current === "vi" ? "VI" : "EN"}</span>
    </Button>
  );
}

export function LanguageToggleMobile() {
  const { t, i18n } = useTranslation();
  const current = normalizeSupportedLanguage(i18n.resolvedLanguage ?? i18n.language);

  return (
    <div className="flex flex-col gap-0.5">
      {SUPPORTED_LANGUAGES.map((lng) => (
        <button
          key={lng}
          type="button"
          onClick={() => {
            if (lng !== current) {
              void i18n.changeLanguage(lng);
            }
          }}
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${
            lng === current
              ? "font-semibold text-foreground"
              : "font-medium text-muted-foreground hover:text-foreground"
          }`}
        >
          <Languages className="h-3.5 w-3.5" aria-hidden="true" />
          {LANGUAGE_LABEL_KEY[lng]}
        </button>
      ))}
    </div>
  );
}
