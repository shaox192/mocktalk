"use client";

import { createContext, useContext, useState, useCallback } from "react";
import type { MockTalkSettings } from "./types";

const SettingsContext = createContext<{
  settings: MockTalkSettings | null;
  setSettings: (s: MockTalkSettings) => void;
  clearSettings: () => void;
  sessionActive: boolean;
  setSessionActive: (active: boolean) => void;
}>({
  settings: null,
  setSettings: () => {},
  clearSettings: () => {},
  sessionActive: false,
  setSessionActive: () => {},
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<MockTalkSettings | null>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const clearSettings = useCallback(() => {
    setSettings(null);
    setSessionActive(false);
  }, []);
  return (
    <SettingsContext.Provider value={{ settings, setSettings, clearSettings, sessionActive, setSessionActive }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
