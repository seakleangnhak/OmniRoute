"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface EmailPrivacyState {
  /** When true, all email addresses are shown in full (unmasked). Default: false (masked). */
  emailsVisible: boolean;
  /** Set the global email visibility state. */
  setEmailsVisible: (visible: boolean) => void;
  /** Toggle the global email visibility state. */
  toggleEmailVisibility: () => void;
}

const useEmailPrivacyStore = create<EmailPrivacyState>()(
  persist(
    (set, get) => ({
      emailsVisible: false,
      setEmailsVisible: (visible) => set({ emailsVisible: visible }),
      toggleEmailVisibility: () => set({ emailsVisible: !get().emailsVisible }),
    }),
    {
      name: "omniroute-email-privacy",
    }
  )
);

export default useEmailPrivacyStore;
