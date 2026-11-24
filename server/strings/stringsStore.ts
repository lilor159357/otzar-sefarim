import fs from "fs";
import path from "path";
import {
  STRINGS_DICTIONARY_VERSION,
  type StringKey,
} from "../../shared/strings/dictionary.ts";
import {
  createStringsTranslator,
  getDefaultString,
  getDefaultStringsMap,
  mergeStringsWithOverrides,
  validateOverrideEntry,
  type FlatStringsMap,
  type OverrideRejectedItem,
  type StringOverrideRecord,
  type StringsTranslateFn,
} from "../../shared/strings/engine.ts";

export interface StringsSnapshot {
  version: number;
  resolved: FlatStringsMap;
  defaults: FlatStringsMap;
  overrides: Record<string, string>;
  localOverrides: Record<string, StringOverrideRecord>;
  cloudOverrides: Record<string, StringOverrideRecord>;
  rejected: OverrideRejectedItem[];
  diskParseError: string | null;
}

function readJsonRecordFile(filePath: string): {
  records: Record<string, StringOverrideRecord>;
  mtimeMs: number;
  parseError: string | null;
} {
  if (!fs.existsSync(filePath)) {
    return { records: {}, mtimeMs: 0, parseError: null };
  }
  try {
    const stat = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return { records: {}, mtimeMs: stat.mtimeMs, parseError: null };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { records: {}, mtimeMs: stat.mtimeMs, parseError: "invalid_root_object" };
    }
    const normalized: Record<string, StringOverrideRecord> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") {
        normalized[k] = { value: v };
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        if (typeof obj.value === "string") {
          normalized[k] = {
            value: obj.value,
            defaultValueSnapshot:
              typeof obj.defaultValueSnapshot === "string" ? obj.defaultValueSnapshot : undefined,
            updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : undefined,
            promoted_desktop:
              typeof obj.promoted_desktop === "boolean" ? obj.promoted_desktop : undefined,
            promoted_mobile:
              typeof obj.promoted_mobile === "boolean" ? obj.promoted_mobile : undefined,
          };
        }
      }
    }
    return { records: normalized, mtimeMs: stat.mtimeMs, parseError: null };
  } catch (err) {
    return {
      records: {},
      mtimeMs: 0,
      parseError: err instanceof Error ? err.message : "json_parse_error",
    };
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

export class DesktopStringsStore {
  private readonly localPath: string;
  private readonly cloudCachePath: string;
  private localMtimeMs = -1;
  private cloudMtimeMs = -1;
  private localOverrides: Record<string, StringOverrideRecord> = {};
  private cloudOverrides: Record<string, StringOverrideRecord> = {};
  private resolved: FlatStringsMap = getDefaultStringsMap();
  private appliedOverrides: Record<string, string> = {};
  private rejected: OverrideRejectedItem[] = [];
  private diskParseError: string | null = null;

  public readonly t: StringsTranslateFn;

  constructor(dataDir: string) {
    this.localPath = path.join(dataDir, "strings.override.json");
    this.cloudCachePath = path.join(dataDir, "strings.cloud-cache.json");
    this.reloadFromDisk();
    this.t = createStringsTranslator(() => {
      this.refreshIfChangedOnDisk();
      return this.resolved;
    });
  }

  private getMtime(filePath: string): number {
    try {
      return fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
    } catch {
      return 0;
    }
  }

  public refreshIfChangedOnDisk(): void {
    const localMtime = this.getMtime(this.localPath);
    const cloudMtime = this.getMtime(this.cloudCachePath);
    if (localMtime !== this.localMtimeMs || cloudMtime !== this.cloudMtimeMs) {
      this.reloadFromDisk();
    }
  }

  public reloadFromDisk(): StringsSnapshot {
    const localRes = readJsonRecordFile(this.localPath);
    const cloudRes = readJsonRecordFile(this.cloudCachePath);

    this.localOverrides = localRes.records;
    this.localMtimeMs = localRes.mtimeMs;
    this.cloudOverrides = cloudRes.records;
    this.cloudMtimeMs = cloudRes.mtimeMs;
    this.diskParseError = localRes.parseError || cloudRes.parseError;

    const merged = mergeStringsWithOverrides(this.localOverrides, this.cloudOverrides);
    this.resolved = merged.resolved;
    this.appliedOverrides = merged.appliedOverrides;
    this.rejected = merged.rejected;

    return this.getSnapshot(false);
  }

  public getSnapshot(checkDisk = true): StringsSnapshot {
    if (checkDisk) this.refreshIfChangedOnDisk();
    return {
      version: STRINGS_DICTIONARY_VERSION,
      resolved: { ...this.resolved },
      defaults: getDefaultStringsMap(),
      overrides: { ...this.appliedOverrides },
      localOverrides: { ...this.localOverrides },
      cloudOverrides: { ...this.cloudOverrides },
      rejected: [...this.rejected],
      diskParseError: this.diskParseError,
    };
  }

  public getResolvedMap(): FlatStringsMap {
    this.refreshIfChangedOnDisk();
    return { ...this.resolved };
  }

  public saveLocalOverride(
    key: string,
    rawValue: unknown
  ): { ok: true; record: StringOverrideRecord; snapshot: StringsSnapshot } | { ok: false; reason: string; error: string } {
    const check = validateOverrideEntry(key, rawValue);
    if (!check.valid) {
      const missingPrefix = "missing_param:";
      const errorMsg = check.reason.startsWith(missingPrefix)
        ? this.t("errors.overrideMissingParam", {
            key,
            param: `{${check.reason.slice(missingPrefix.length)}}`,
          })
        : this.t("errors.overrideInvalidJson");
      return { ok: false, reason: check.reason, error: errorMsg };
    }

    this.refreshIfChangedOnDisk();
    const record: StringOverrideRecord = {
      value: check.value,
      defaultValueSnapshot: getDefaultString(key as StringKey),
      updatedAt: new Date().toISOString(),
      promoted_desktop: false,
      promoted_mobile: false,
    };

    const nextLocal = { ...this.localOverrides, [key]: record };
    writeJsonAtomic(this.localPath, nextLocal);
    const snapshot = this.reloadFromDisk();
    return { ok: true, record, snapshot };
  }

  public resetLocalOverride(key: string): StringsSnapshot {
    this.refreshIfChangedOnDisk();
    if (Object.prototype.hasOwnProperty.call(this.localOverrides, key)) {
      const nextLocal = { ...this.localOverrides };
      delete nextLocal[key];
      writeJsonAtomic(this.localPath, nextLocal);
    }
    return this.reloadFromDisk();
  }

  public getLocalOverrides(): Record<string, StringOverrideRecord> {
    this.refreshIfChangedOnDisk();
    return { ...this.localOverrides };
  }

  public getCloudOverrides(): Record<string, StringOverrideRecord> {
    this.refreshIfChangedOnDisk();
    return { ...this.cloudOverrides };
  }

  public replaceCloudCacheOverrides(records: Record<string, StringOverrideRecord>): StringsSnapshot {
    writeJsonAtomic(this.cloudCachePath, records);
    return this.reloadFromDisk();
  }

  public upsertCloudCacheEntry(key: string, record: StringOverrideRecord): StringsSnapshot {
    this.refreshIfChangedOnDisk();
    const nextCloud = { ...this.cloudOverrides, [key]: record };
    writeJsonAtomic(this.cloudCachePath, nextCloud);
    return this.reloadFromDisk();
  }

  public removeCloudCacheEntry(key: string): StringsSnapshot {
    this.refreshIfChangedOnDisk();
    if (Object.prototype.hasOwnProperty.call(this.cloudOverrides, key)) {
      const nextCloud = { ...this.cloudOverrides };
      delete nextCloud[key];
      writeJsonAtomic(this.cloudCachePath, nextCloud);
      return this.reloadFromDisk();
    }
    return this.getSnapshot(false);
  }
}