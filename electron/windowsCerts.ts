import fs from "fs";
import https from "https";
import path from "path";
import tls from "tls";
import { execFileSync } from "child_process";

export interface CertLoadSummary {
  loadedCount: number;
  mode: "node-system-ca" | "powershell-store" | "default";
}

function readWindowsCertsViaPowerShell(cachePath: string): string[] {
  try {
    // Reuse recent cache (within 12h) to keep startup instant
    if (fs.existsSync(cachePath)) {
      const stat = fs.statSync(cachePath);
      if (Date.now() - stat.mtimeMs < 12 * 60 * 60 * 1000) {
        const cached = fs.readFileSync(cachePath, "utf8");
        const pems = cached.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
        if (pems.length > 0) return pems;
      }
    }

    const psScript = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$certs = @()",
      "$certs += Get-ChildItem Cert:\LocalMachine\Root",
      "$certs += Get-ChildItem Cert:\CurrentUser\Root",
      "$out = New-Object System.Text.StringBuilder",
      "foreach ($c in $certs) {",
      "  if ($c.RawData) {",
      "    $b64 = [Convert]::ToBase64String($c.RawData, [Base64FormattingOptions]::InsertLineBreaks)",
      "    [void]$out.AppendLine('-----BEGIN CERTIFICATE-----')",
      "    [void]$out.AppendLine($b64)",
      "    [void]$out.AppendLine('-----END CERTIFICATE-----')",
      "  }",
      "}",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "Write-Output $out.ToString()",
    ].join("; ");

    const raw = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript],
      { encoding: "utf8", timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    );
    const pems = raw.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    if (pems.length > 0) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, pems.join("\n") + "\n", "utf8");
    }
    return pems;
  } catch {
    return [];
  }
}

export function loadWindowsRootCertificates(dataDir: string): CertLoadSummary {
  if (process.platform !== "win32") {
    return { loadedCount: 0, mode: "default" };
  }

  try {
    const tlsAny = tls as unknown as {
      getCACertificates?: (type?: "default" | "system" | "bundled" | "extra") => string[];
      setDefaultCACertificates?: (certs: string[]) => void;
    };

    if (typeof tlsAny.getCACertificates === "function" && typeof tlsAny.setDefaultCACertificates === "function") {
      const defaults = tlsAny.getCACertificates("default") || [];
      const system = tlsAny.getCACertificates("system") || [];
      if (system.length > 0) {
        const merged = Array.from(new Set([...defaults, ...system]));
        tlsAny.setDefaultCACertificates(merged);
        https.globalAgent.options.ca = merged;
        return { loadedCount: system.length, mode: "node-system-ca" };
      }
    }

    const cachePath = path.join(dataDir, "win-root-cas.pem");
    const winPems = readWindowsCertsViaPowerShell(cachePath);
    if (winPems.length > 0) {
      const merged = Array.from(new Set([...tls.rootCertificates, ...winPems]));
      if (typeof tlsAny.setDefaultCACertificates === "function") {
        tlsAny.setDefaultCACertificates(merged);
      }
      https.globalAgent.options.ca = merged;
      return { loadedCount: winPems.length, mode: "powershell-store" };
    }
  } catch {
    // Non-fatal fallback
  }

  return { loadedCount: 0, mode: "default" };
}
