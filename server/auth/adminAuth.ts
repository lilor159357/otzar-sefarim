import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";

const activeAdminTokens = new Map<string, number>();

export function issueAdminToken(): string {
  const token = crypto.randomBytes(24).toString("hex");
  activeAdminTokens.set(token, Date.now());
  return token;
}

export function revokeAdminToken(token: string): void {
  if (token) activeAdminTokens.delete(token);
}

export function extractTokenFromRequest(req: Request): string {
  const header = req.headers["x-admin-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const q = req.query.adminToken;
  if (typeof q === "string" && q.trim()) return q.trim();
  return "";
}

export function isAdminRequest(req: Request): boolean {
  const token = extractTokenFromRequest(req);
  if (!token) return false;
  return activeAdminTokens.has(token);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: "נדרשת הרשאת מנהל (Admin PIN) לביצוע פעולה זו" });
  }
  next();
}
