/**
 * Opt-in DNS fallback for local dev machines whose system resolver is broken
 * (getaddrinfo ECONNREFUSED) while raw connectivity works. Import BEFORE any
 * socket connection: `if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js")`.
 * Tries the system resolver first; falls back to 1.1.1.1 / 8.8.8.8.
 */
import dns from "node:dns";

const custom = new dns.Resolver();
custom.setServers(["1.1.1.1", "8.8.8.8"]);
const original = dns.lookup.bind(dns);

// @ts-expect-error patching the lookup signature intentionally
dns.lookup = (hostname: any, options: any, callback: any) => {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : options;
  original(hostname, opts, (err: any, address: any, family: any) => {
    if (!err) return cb(null, address, family);
    custom.resolve4(hostname, (e2, addrs) => {
      if (!e2 && addrs.length) {
        if (opts.all) return cb(null, addrs.map((a) => ({ address: a, family: 4 })));
        return cb(null, addrs[0], 4);
      }
      custom.resolve6(hostname, (e3, addrs6) => {
        if (!e3 && addrs6.length) {
          if (opts.all) return cb(null, addrs6.map((a) => ({ address: a, family: 6 })));
          return cb(null, addrs6[0], 6);
        }
        cb(err, address, family);
      });
    });
  });
};
