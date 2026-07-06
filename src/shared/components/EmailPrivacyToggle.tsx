"use client";

import { useTranslations } from "next-intl";
import useEmailPrivacyStore from "@/store/emailPrivacyStore";

export default function EmailPrivacyToggle({ size = "sm" }: { size?: "sm" | "md" }) {
  const { emailsVisible, toggleEmailVisibility } = useEmailPrivacyStore();
  const t = useTranslations("providers");

  const iconSize = size === "md" ? "text-[20px]" : "text-[16px]";
  const sizeClass = size === "md" ? "h-10 w-10" : "h-8 w-8";
  const label = emailsVisible ? t("hideEmails") : t("showEmails");

  return (
    <button
      type="button"
      onClick={toggleEmailVisibility}
      className={`inline-flex ${sizeClass} items-center justify-center rounded transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
        emailsVisible
          ? "bg-primary/15 text-primary hover:bg-primary/25"
          : "text-text-muted hover:bg-sidebar hover:text-primary"
      }`}
      title={label}
      aria-label={label}
      aria-pressed={emailsVisible}
    >
      <span className={`material-symbols-outlined ${iconSize} leading-none`}>
        {emailsVisible ? "visibility" : "visibility_off"}
      </span>
    </button>
  );
}
