/**
 * Per-strategy schemas for `profile.options`.
 *
 * Options are non-secret configuration, but they steer where a strategy sends
 * the secret. Every option that names an endpoint must therefore be a plain
 * path on the profile's own origin ("/..."), never an absolute or
 * protocol-relative URL. Unknown keys are rejected so a typo cannot silently
 * fall back to a default, and so nothing unvetted reaches a strategy.
 *
 * profiles.ts applies these at load time (path-qualified invalid-profile
 * errors); strategies re-check the path options before any request.
 */
import { z } from "zod";
import { PROFILE_NAME_RE, type StrategyName } from "../types.js";

/** An option path: starts with "/", no whitespace, query or fragment. */
export const OPTION_PATH_RE = /^\/[^\s?#]*$/;

/**
 * True when `value` is safe to append to a baseUrl: matches OPTION_PATH_RE and
 * is not protocol-relative ("//host") and contains no backslash (which WHATWG
 * URL parsing treats as "/").
 */
export function isSafeOptionPath(value: string): boolean {
  return OPTION_PATH_RE.test(value) && !value.startsWith("//") && !value.includes("\\");
}

const pathOption = z
  .string()
  .refine(isSafeOptionPath, {
    message: 'must be a path on the profile origin starting with "/" (no scheme, host, "//", "\\", whitespace, query or fragment)',
  });

/** RFC 7230 token: cookie names and header names. */
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const tokenOption = (what: string) => z.string().regex(TOKEN_RE, `must be a valid ${what}`);

/** HTML form field names used by the strategies. */
const fieldOption = z.string().regex(/^[A-Za-z0-9_.[\]-]{1,64}$/, "must be a form field name ([A-Za-z0-9_.[]-], 1-64 chars)");

/** Dot path into a JSON value, e.g. "user.role"; numeric segments index arrays ("workspaces.0.role"). */
const dotPathOption = z
  .string()
  .regex(
    /^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,7}$/,
    'must be a dot path such as "user.role" or "workspaces.0.role"',
  );

/** `fields` for form-post: a JSON object of string fields (form fields, or JSON body keys with bodyFormat "json"). */
const jsonFieldsOption = z.string().superRefine((value, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a JSON object string" });
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a JSON object string" });
    return;
  }
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.[\]-]{1,64}$/.test(k) || typeof v !== "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must map form field names to string values",
      });
      return;
    }
  }
});

/** OAuth scope: space-separated printable ASCII, no control characters. */
const scopeOption = z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/, "must be a space-separated OAuth scope list");

// ---------------------------------------------------------------------------
// dependent-token options
// ---------------------------------------------------------------------------

/** Placeholders allowed in dependent-token `fields` values; {{secret}} is required. */
export const DEPENDENT_TOKEN_PLACEHOLDERS = ["secret", "email", "identifier"] as const;
export type DependentTokenPlaceholder = (typeof DEPENDENT_TOKEN_PLACEHOLDERS)[number];
const TEMPLATE_FIELD_NAME_RE = /^[A-Za-z0-9_.[\]-]{1,64}$/;
const ANY_PLACEHOLDER_RE = /\{\{([A-Za-z0-9_]*)\}\}/g;

/**
 * Parse a dependent-token `fields` template: a JSON object string mapping
 * field names to string values that may contain {{secret}} (required
 * somewhere), {{email}} and {{identifier}}. Returns the entries, or a
 * message naming the rule that failed (never the value).
 */
export function parseTemplateFields(raw: string): { entries: [string, string][] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "must be a JSON object string" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "must be a JSON object string" };
  }
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!TEMPLATE_FIELD_NAME_RE.test(k) || typeof v !== "string") {
      return { error: "must map field names ([A-Za-z0-9_.[]-], 1-64 chars) to string values" };
    }
    for (const m of v.matchAll(ANY_PLACEHOLDER_RE)) {
      if (!(DEPENDENT_TOKEN_PLACEHOLDERS as readonly string[]).includes(m[1] ?? "")) {
        return { error: "may only use the placeholders {{secret}}, {{email}} and {{identifier}}" };
      }
    }
    entries.push([k, v]);
  }
  if (!entries.some(([, v]) => v.includes("{{secret}}"))) {
    return { error: "must contain the {{secret}} placeholder" };
  }
  return { entries };
}

const templateFieldsOption = z.string().superRefine((value, ctx) => {
  const result = parseTemplateFields(value);
  if ("error" in result) ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
});

/** Maximum length of a secretPattern source. */
export const MAX_SECRET_PATTERN_LENGTH = 256;

/**
 * Compile a secretPattern (JavaScript syntax, "u" flag), or undefined when it
 * is too long or does not compile. The pattern is used as written, so anchor
 * it ("^...$") to constrain the whole secret.
 */
export function compileSecretPattern(source: string): RegExp | undefined {
  if (source.length === 0 || source.length > MAX_SECRET_PATTERN_LENGTH) return undefined;
  try {
    return new RegExp(source, "u");
  } catch {
    return undefined;
  }
}

const secretPatternOption = z.string().refine((v) => compileSecretPattern(v) !== undefined, {
  message: `must be a valid regular expression (JavaScript syntax with the "u" flag, 1-${MAX_SECRET_PATTERN_LENGTH} characters)`,
});

/**
 * Header names a strategy never sets from configuration or forwards from a
 * dependency session: they belong to the transport or to the cookie jar.
 */
export const RESERVED_HEADER_RE =
  /^(cookie|set-cookie|host|content-length|content-type|origin|transfer-encoding|connection|te|upgrade|keep-alive|proxy-authorization|proxy-connection)$/i;

const tokenHeaderOption = tokenOption("HTTP header name").refine((v) => !RESERVED_HEADER_RE.test(v), {
  message: "must not be a reserved header (Cookie, Set-Cookie, Host, Content-Length, Content-Type, Origin, ...)",
});

/** Cross-field rules for dependent-token that a strict object cannot express. */
function checkDependentTokenOptions(options: Record<string, unknown>, ctx: z.RefinementCtx): void {
  if (options["tokenField"] !== undefined && options["sessionCookieName"] !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sessionCookieName"],
      message: "cannot be combined with tokenField (set exactly one of tokenField / sessionCookieName)",
    });
  }
  if (options["tokenHeader"] !== undefined && options["tokenField"] === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tokenHeader"],
      message: "requires tokenField (the header carries the token read from tokenField)",
    });
  }
}

// ---------------------------------------------------------------------------
// Rotation options (`testlane rotate`), shared by the password strategies
// ---------------------------------------------------------------------------

export const ROTATE_METHODS = ["POST", "PUT", "PATCH"] as const;
export type RotateMethod = (typeof ROTATE_METHODS)[number];
export const ROTATE_BODY_FORMATS = ["json", "form"] as const;
export type RotateBodyFormat = (typeof ROTATE_BODY_FORMATS)[number];

/** Placeholders allowed in rotateBody values; {{newSecret}} is required. */
export const ROTATE_PLACEHOLDERS = ["email", "secret", "newSecret"] as const;
export type RotatePlaceholder = (typeof ROTATE_PLACEHOLDERS)[number];
const PLACEHOLDER_RE = /\{\{([A-Za-z0-9_]*)\}\}/g;
const ROTATE_FIELD_NAME_RE = /^[A-Za-z0-9_.[\]-]{1,64}$/;
/** Upper bound for rotateEveryDays (100 years). */
export const MAX_ROTATE_EVERY_DAYS = 36_500;

/**
 * Parse a rotateBody template: a JSON object string mapping field names to
 * string values that may contain {{email}}, {{secret}} (the current secret)
 * and {{newSecret}} (required somewhere). Returns the entries, or a message
 * naming the rule that failed (never the value).
 */
export function parseRotateBody(raw: string): { entries: [string, string][] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "must be a JSON object string" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "must be a JSON object string" };
  }
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ROTATE_FIELD_NAME_RE.test(k) || typeof v !== "string") {
      return { error: "must map field names ([A-Za-z0-9_.[]-], 1-64 chars) to string values" };
    }
    for (const m of v.matchAll(PLACEHOLDER_RE)) {
      if (!(ROTATE_PLACEHOLDERS as readonly string[]).includes(m[1] ?? "")) {
        return { error: "may only use the placeholders {{email}}, {{secret}} and {{newSecret}}" };
      }
    }
    entries.push([k, v]);
  }
  if (!entries.some(([, v]) => v.includes("{{newSecret}}"))) {
    return { error: "must contain the {{newSecret}} placeholder" };
  }
  return { entries };
}

const rotateBodyOption = z.string().superRefine((value, ctx) => {
  const result = parseRotateBody(value);
  if ("error" in result) ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
});

/** A positive whole number of days, as a string (options are strings). */
export const ROTATE_EVERY_DAYS_RE = /^[1-9][0-9]{0,4}$/;
const rotateEveryDaysOption = z
  .string()
  .regex(ROTATE_EVERY_DAYS_RE, "must be a positive whole number of days")
  .refine((v) => Number(v) <= MAX_ROTATE_EVERY_DAYS, { message: `must be at most ${MAX_ROTATE_EVERY_DAYS}` });

/**
 * Options that drive `testlane rotate` (strategy-agnostic; see rotateProfile in src/commands.ts):
 * rotatePath (same-origin path), rotateMethod, rotateBodyFormat, rotateBody,
 * rotateVia (a profile whose session authenticates the request), and
 * rotateEveryDays (used by `status`).
 */
const rotateOptions = {
  rotatePath: pathOption.optional(),
  rotateMethod: z.enum(ROTATE_METHODS).optional(),
  rotateBodyFormat: z.enum(ROTATE_BODY_FORMATS).optional(),
  rotateBody: rotateBodyOption.optional(),
  rotateVia: z.string().regex(PROFILE_NAME_RE, "must be a profile name").max(128).optional(),
  rotateEveryDays: rotateEveryDaysOption.optional(),
};

export const STRATEGY_OPTION_SCHEMAS = {
  "nextauth-credentials": z
    .object({
      csrfPath: pathOption.optional(),
      callbackPath: pathOption.optional(),
      sessionPath: pathOption.optional(),
      sessionCookieName: tokenOption("cookie name").optional(),
      emailField: fieldOption.optional(),
      passwordField: fieldOption.optional(),
      roleField: dotPathOption.optional(),
      ...rotateOptions,
    })
    .strict(),
  /**
   * form-post: loginPath, fields and sessionCookieName are required to sign in
   * (the strategy refuses before any request without them) but stay optional
   * here so a registry can be loaded and listed while a profile is still being
   * configured.
   */
  "form-post": z
    .object({
      loginPath: pathOption.optional(),
      fields: jsonFieldsOption.optional(),
      sessionCookieName: tokenOption("cookie name").optional(),
      bodyFormat: z.enum(["form", "json"]).optional(),
      primeCookies: z.enum(["true", "false"]).optional(),
      successPath: pathOption.optional(),
      successBodyField: dotPathOption.optional(),
      mePath: pathOption.optional(),
      roleField: dotPathOption.optional(),
      emailField: dotPathOption.optional(),
      ...rotateOptions,
    })
    .strict(),
  /**
   * dependent-token: dependsOn, tokenPath, fields and exactly one of
   * tokenField / sessionCookieName are required to sign in (the strategy
   * refuses before any request without them); like form-post they stay
   * optional here so a registry loads while a profile is being configured.
   * validateStrategyOptions adds the cross-field rules (not both tokenField
   * and sessionCookieName; tokenHeader only with tokenField).
   */
  "dependent-token": z
    .object({
      dependsOn: z.string().regex(PROFILE_NAME_RE, "must be a profile name").max(128).optional(),
      tokenPath: pathOption.optional(),
      bodyFormat: z.enum(["json", "form"]).optional(),
      fields: templateFieldsOption.optional(),
      secretPattern: secretPatternOption.optional(),
      tokenField: dotPathOption.optional(),
      tokenHeader: tokenHeaderOption.optional(),
      expiresAtField: dotPathOption.optional(),
      sessionCookieName: tokenOption("cookie name").optional(),
      mePath: pathOption.optional(),
      emailField: dotPathOption.optional(),
      roleField: dotPathOption.optional(),
    })
    .strict(),
  "oauth-client-credentials": z
    .object({ tokenPath: pathOption.optional(), scope: scopeOption.optional() })
    .strict(),
  "api-key": z.object({ headerName: tokenOption("HTTP header name").optional() }).strict(),
  /**
   * app-handoff: handoffPath is the app route `handoff` builds its URL on and
   * that `session` / `check` consume inside the broker. mePath, emailField and
   * roleField (same style as dependent-token) let the broker confirm the
   * handed-off identity before issuing anything; without mePath `session`
   * still works but `check` reports the identity as not confirmed.
   */
  "app-handoff": z
    .object({
      handoffPath: pathOption.optional(),
      mePath: pathOption.optional(),
      emailField: dotPathOption.optional(),
      roleField: dotPathOption.optional(),
    })
    .strict(),
} as const satisfies Record<StrategyName, z.ZodTypeAny>;

/** Documented option keys per strategy (for docs and error hints). */
export function optionKeysFor(strategy: StrategyName): string[] {
  return Object.keys(STRATEGY_OPTION_SCHEMAS[strategy].shape);
}

/** Validate `options` for `strategy`. Issue paths are relative to the options object. */
export function validateStrategyOptions(
  strategy: StrategyName,
  options: Record<string, string> | undefined,
): z.SafeParseReturnType<unknown, unknown> {
  if (strategy === "dependent-token") {
    return STRATEGY_OPTION_SCHEMAS[strategy].superRefine(checkDependentTokenOptions).safeParse(options ?? {});
  }
  return STRATEGY_OPTION_SCHEMAS[strategy].safeParse(options ?? {});
}
