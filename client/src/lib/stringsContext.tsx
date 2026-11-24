import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { STRINGS_DICTIONARY_VERSION, type StringKey } from "../../../shared/strings/dictionary.ts";
import {
  createStringsTranslator,
  getDefaultStringsMap,
  mergeStringsWithOverrides,
  type FlatStringsMap,
  type StringOverrideRecord,
  type StringsTranslateFn,
} from "../../../shared/strings/engine.ts";

const CACHE_STORAGE_KEY = "otzar_desktop_strings_cache_v1";

interface StringsContextValue {
  version: number;
  t: StringsTranslateFn;
  resolved: FlatStringsMap;
  defaults: FlatStringsMap;
  overrides: Record<string, string>;
  localOverrides: Record<string, StringOverrideRecord>;
  cloudOverrides: Record<string, StringOverrideRecord>;
  cloudConnected: boolean;
  isLoadedFromServer: boolean;
  reloadStrings: () => Promise<void>;
  applyRemoteOverrides: (remote: Record<string, StringOverrideRecord | string>) => void;
}

function readCachedOverrides(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {}
  return {};
}

function writeCachedOverrides(overrides: Record<string, string>): void {
  try {
    window.localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(overrides));
  } catch {}
}

const initialMerged = mergeStringsWithOverrides(
  typeof window !== "undefined" ? readCachedOverrides() : {}
);

const defaultTranslate = createStringsTranslator(() => initialMerged.resolved);

const StringsContext = createContext<StringsContextValue>({
  version: STRINGS_DICTIONARY_VERSION,
  t: defaultTranslate,
  resolved: initialMerged.resolved,
  defaults: getDefaultStringsMap(),
  overrides: initialMerged.appliedOverrides,
  localOverrides: {},
  cloudOverrides: {},
  cloudConnected: false,
  isLoadedFromServer: false,
  reloadStrings: async () => {},
  applyRemoteOverrides: () => {},
});

export function StringsProvider({ children }: { children: React.ReactNode }) {
  const [resolved, setResolved] = useState<FlatStringsMap>(() => initialMerged.resolved);
  const [overrides, setOverrides] = useState<Record<string, string>>(
    () => initialMerged.appliedOverrides
  );
  const [localOverrides, setLocalOverrides] = useState<Record<string, StringOverrideRecord>>({});
  const [cloudOverrides, setCloudOverrides] = useState<Record<string, StringOverrideRecord>>({});
  const [cloudConnected, setCloudConnected] = useState(false);
  const [isLoadedFromServer, setIsLoadedFromServer] = useState(false);

  const resolvedRef = useRef<FlatStringsMap>(resolved);
  resolvedRef.current = resolved;

  const reloadStrings = useCallback(async () => {
    try {
      const res = await fetch("/api/strings", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        ok?: boolean;
        cloudConnected?: boolean;
        resolved?: FlatStringsMap;
        overrides?: Record<string, string>;
        localOverrides?: Record<string, StringOverrideRecord>;
        cloudOverrides?: Record<string, StringOverrideRecord>;
      };
      if (data && data.ok && data.resolved) {
        const merged = mergeStringsWithOverrides(data.overrides || data.resolved);
        setResolved(merged.resolved);
        setOverrides(data.overrides || merged.appliedOverrides);
        setLocalOverrides(data.localOverrides || {});
        setCloudOverrides(data.cloudOverrides || {});
        setCloudConnected(Boolean(data.cloudConnected));
        writeCachedOverrides(data.overrides || merged.appliedOverrides);
        setIsLoadedFromServer(true);
      }
    } catch {
      // Non-blocking: fallback silently to cached + built-in defaults
    }
  }, []);

  const applyRemoteOverrides = useCallback(
    (remote: Record<string, StringOverrideRecord | string>) => {
      const merged = mergeStringsWithOverrides(localOverrides, remote);
      setResolved(merged.resolved);
      setOverrides(merged.appliedOverrides);
      writeCachedOverrides(merged.appliedOverrides);
    },
    [localOverrides]
  );

  useEffect(() => {
    void reloadStrings();
  }, [reloadStrings]);

  const t = useMemo<StringsTranslateFn>(
    () => createStringsTranslator(() => resolvedRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolved]
  );

  const defaults = useMemo(() => getDefaultStringsMap(), []);

  const value = useMemo<StringsContextValue>(
    () => ({
      version: STRINGS_DICTIONARY_VERSION,
      t,
      resolved,
      defaults,
      overrides,
      localOverrides,
      cloudOverrides,
      cloudConnected,
      isLoadedFromServer,
      reloadStrings,
      applyRemoteOverrides,
    }),
    [
      t,
      resolved,
      defaults,
      overrides,
      localOverrides,
      cloudOverrides,
      cloudConnected,
      isLoadedFromServer,
      reloadStrings,
      applyRemoteOverrides,
    ]
  );

  return <StringsContext.Provider value={value}>{children}</StringsContext.Provider>;
}

export function useStrings(): StringsContextValue {
  return useContext(StringsContext);
}

export type { StringKey };