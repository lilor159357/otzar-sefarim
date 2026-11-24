import React, { useState } from "react";
import { BookOpen, CheckCircle2, X } from "lucide-react";
import { useStrings } from "../lib/stringsContext.tsx";

export interface RecentUpdateInfo {
  hasRecentUpdate: boolean;
  version: string;
  previousVersion?: string | null;
  highlights: string[];
  summary?: string;
}

interface WhatsNewModalProps {
  info: RecentUpdateInfo;
  onAcknowledge: () => Promise<void> | void;
}

export const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ info, onAcknowledge }) => {
  const { t } = useStrings();
  const [submitting, setSubmitting] = useState(false);

  const handleDone = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onAcknowledge();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-[2px] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="whats-new-title"
    >
      <div className="w-full max-w-lg max-h-[88vh] flex flex-col overflow-hidden rounded-2xl bg-[var(--otzar-bg)] border border-[var(--otzar-border-muted)] shadow-xl text-[var(--otzar-text)]">
        <div className="shrink-0 flex items-start justify-between gap-4 p-5 sm:p-6 pb-4 border-b border-[var(--otzar-border-muted)]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-[var(--otzar-surface)] border border-[var(--otzar-border)] flex items-center justify-center text-[var(--otzar-accent)] shrink-0">
              <BookOpen className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 id="whats-new-title" className="text-lg font-bold leading-snug text-balance">
                {t("updater.whatsNewTitle", { version: info.version })}
              </h2>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--otzar-text-muted)] mt-0.5">
                <span>{t("updater.whatsNewSubtitleDone")}</span>
                {info.previousVersion && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums" dir="ltr">
                      v{info.previousVersion} → v{info.version}
                    </span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span>{t("updater.whatsNewDataSafe")}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleDone}
            disabled={submitting}
            aria-label={t("updater.whatsNewAriaClose")}
            className="p-1.5 rounded-lg text-[var(--otzar-text-muted)] hover:bg-[var(--otzar-surface)] hover:text-[var(--otzar-text)] transition-colors cursor-pointer disabled:opacity-50 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 py-4">
          <div className="p-4 rounded-xl bg-[var(--otzar-surface)] border border-[var(--otzar-border-muted)] space-y-2.5">
            <div className="text-xs font-semibold text-[var(--otzar-text)]">
              {t("updater.whatsNewSectionTitle")}
            </div>
            <ul className="space-y-2 text-sm text-[var(--otzar-text)] leading-relaxed">
              {(info.highlights && info.highlights.length > 0
                ? info.highlights
                : [t("updater.whatsNewFallbackItem")]
              ).map((item, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <span className="min-w-0 break-words">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="shrink-0 flex items-center justify-end gap-3 px-5 sm:px-6 py-4 border-t border-[var(--otzar-border-muted)] bg-[var(--otzar-bg)]">
          <button
            type="button"
            onClick={handleDone}
            disabled={submitting}
            className="px-5 py-2.5 rounded-lg text-sm font-semibold text-white bg-[var(--otzar-accent)] hover:bg-[var(--otzar-accent-hover)] transition-colors cursor-pointer disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            {submitting ? t("updater.whatsNewClosing") : t("updater.whatsNewCloseButton")}
          </button>
        </div>
      </div>
    </div>
  );
};