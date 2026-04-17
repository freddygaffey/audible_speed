import { z } from "zod";

async function apiFetch<T>(schema: z.ZodType<T>, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const json: unknown = await res.json();
  if (!res.ok) {
    const msg = (json as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return schema.parse(json);
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const AuthStatusSchema = z.object({
  authenticated: z.boolean(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  marketplace: z.string().nullable(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

const LoginSuccessSchema = z.object({
  status: z.literal("success"),
  username: z.string(),
  email: z.string(),
  marketplace: z.string(),
});
const LoginOtpSchema = z.object({ status: z.literal("otp"), pendingId: z.string() });
const LoginErrorSchema = z.object({ status: z.literal("error"), error: z.string() });
const LoginCaptchaSchema = z.object({ status: z.literal("captcha"), error: z.string() });
const LoginResultSchema = z.discriminatedUnion("status", [
  LoginSuccessSchema,
  LoginOtpSchema,
  LoginErrorSchema,
  LoginCaptchaSchema,
]);
export type LoginResult = z.infer<typeof LoginResultSchema>;

// ---------------------------------------------------------------------------
// Auth API calls
// ---------------------------------------------------------------------------

export function getAuthStatus() {
  return apiFetch(AuthStatusSchema, "/audible/auth/status");
}

export function login(email: string, password: string, marketplace: string) {
  return apiFetch(LoginResultSchema, "/audible/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, marketplace }),
  });
}

export function submitOtp(pendingId: string, otp: string, marketplace: string) {
  return apiFetch(LoginResultSchema, "/audible/auth/otp", {
    method: "POST",
    body: JSON.stringify({ pendingId, otp, marketplace }),
  });
}

export function logout() {
  return apiFetch(z.object({ message: z.string() }), "/audible/auth/logout", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export const BookSchema = z.object({
  asin: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  authors: z.array(z.string()),
  narrators: z.array(z.string()),
  coverUrl: z.string().nullable(),
  runtimeMinutes: z.number().nullable(),
  purchaseDate: z.string().nullable(),
  seriesTitle: z.string().nullable(),
  seriesPosition: z.string().nullable(),
  releaseDate: z.string().nullable(),
  description: z.string().nullable(),
  status: z.enum(["available", "downloaded", "downloading"]),
});
export type Book = z.infer<typeof BookSchema>;

const LibraryResponseSchema = z.object({
  books: z.array(BookSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

export function fetchLibrary(page = 1, pageSize = 50) {
  return apiFetch(LibraryResponseSchema, `/audible/library?page=${page}&pageSize=${pageSize}`);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function setActivationBytes(activationBytes: string) {
  return apiFetch(
    z.object({ message: z.string() }),
    "/audible/settings/activation-bytes",
    { method: "POST", body: JSON.stringify({ activationBytes }) }
  );
}
