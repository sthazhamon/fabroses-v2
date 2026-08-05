// Wraps node:sqlite's synchronous API to look like Cloudflare D1's async API
// (prepare().bind().all()/first()/run()), and provides a trivial in-memory R2
// stand-in. This lets us import the real functions/api/*.js handler files
// and run them for real, against a real database, with zero mocking of the
// business logic itself — only the platform bindings are faked.

export function wrapD1(sqliteDb) {
  return {
    prepare(sql) {
      let boundArgs = [];
      const api = {
        bind(...args) {
          boundArgs = args.map((a) => (a === undefined ? null : a));
          return api;
        },
        async all() {
          const rows = sqliteDb.prepare(sql).all(...boundArgs);
          return { results: rows };
        },
        async first() {
          const row = sqliteDb.prepare(sql).get(...boundArgs);
          return row === undefined ? null : row;
        },
        async run() {
          const info = sqliteDb.prepare(sql).run(...boundArgs);
          return { meta: { last_row_id: info.lastInsertRowid } };
        },
      };
      return api;
    },
  };
}

export function makeFakeR2() {
  const store = new Map();
  return {
    async put(key, data, opts) {
      store.set(key, { data, httpMetadata: opts?.httpMetadata });
      return { key };
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return { body: entry.data, httpMetadata: entry.httpMetadata };
    },
    _store: store,
  };
}

// Minimal FormData-like builder for endpoints that read multipart uploads.
export function fakePhotoFormData(filename = "test.jpg", type = "image/jpeg") {
  const fd = new FormData();
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type });
  fd.append("photo", blob, filename);
  return fd;
}
