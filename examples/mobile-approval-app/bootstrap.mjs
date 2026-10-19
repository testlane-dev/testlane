/** The proof accepts a single local cookie, never credentials or remote targets. */
export function validateBootstrap(text) {
  try {
    if (typeof text !== 'string' || text.length > 4096) throw Error();
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'cookie,origin,schemaVersion' ||
        value.schemaVersion !== 1 || typeof value.origin !== 'string' || typeof value.cookie !== 'string') throw Error();
    const origin = new URL(value.origin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.origin !== value.origin ||
        origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
        !origin.port || Number(origin.port) < 1 || !/^tldemo_session=[a-zA-Z0-9_-]{32,128}$/.test(value.cookie)) throw Error();
    return Object.freeze({ origin: origin.origin, cookie: value.cookie });
  } catch { throw new Error('BOOTSTRAP_INVALID'); }
}

/** Delete before parsing, accepting the session or making any HTTP request. */
export function consumeBootstrap({ read, remove }) {
  let text;
  try { text = read(); }
  catch { throw new Error('BOOTSTRAP_READ_FAILED'); }
  finally {
    try { remove(); } catch { throw new Error('BOOTSTRAP_DELETE_FAILED'); }
  }
  return validateBootstrap(text);
}
