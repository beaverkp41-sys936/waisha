// Plain-JS DNS fallback for NODE_OPTIONS=--import on dev machines whose
// system resolver is broken. See dns-fallback.ts for the env-gated script use.
import dns from "node:dns";

const custom = new dns.Resolver();
custom.setServers(["1.1.1.1", "8.8.8.8"]);
const original = dns.lookup.bind(dns);

dns.lookup = (hostname, options, callback) => {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : options;
  original(hostname, opts, (err, address, family) => {
    if (!err) return cb(null, address, family);
    custom.resolve4(hostname, (e2, addrs) => {
      if (!e2 && addrs.length) {
        if (opts && opts.all) return cb(null, addrs.map((a) => ({ address: a, family: 4 })));
        return cb(null, addrs[0], 4);
      }
      custom.resolve6(hostname, (e3, addrs6) => {
        if (!e3 && addrs6.length) {
          if (opts && opts.all) return cb(null, addrs6.map((a) => ({ address: a, family: 6 })));
          return cb(null, addrs6[0], 6);
        }
        cb(err, address, family);
      });
    });
  });
};
