/** Playwright `storageState` output ({ cookies, origins }). Contains live session material. */
import type { SessionArtifact, SessionCookie } from "../types.js";

export interface StorageState {
  cookies: SessionCookie[];
  origins: [];
}

export function toStorageState(artifact: SessionArtifact): StorageState {
  return {
    cookies: artifact.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    })),
    origins: [],
  };
}
