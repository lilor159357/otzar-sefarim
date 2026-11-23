const STORAGE_KEY = "otzar_admin_token";
let installed = false;

export function getAdminToken(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function setAdminToken(token: string): void {
  try {
    if (token) {
      sessionStorage.setItem(STORAGE_KEY, token);
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {}
}

export function installFetchAdminInterceptor(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith("/api/")) {
      const t = getAdminToken();
      if (t) {
        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
        if (!headers.has("x-admin-token")) {
          headers.set("x-admin-token", t);
        }
        return origFetch(input, { ...init, headers });
      }
    }
    return origFetch(input, init);
  };
}
