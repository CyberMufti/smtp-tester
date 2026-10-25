/**
 * SMTP submission-host discovery for custom domains, using the mechanisms real
 * email clients use. Given a domain, it returns an ordered list of likely
 * (host, port) endpoints, most authoritative first:
 *
 *   1. SRV records  _submission._tcp / _submissions._tcp   (RFC 6186)
 *   2. Mozilla ISPDB autoconfig (autoconfig.thunderbird.net)
 *   3. Domain-published autoconfig (autoconfig.<domain>, /.well-known/…)
 *
 * DNS and fetch are injected so this is unit-testable and network-free in CI.
 * Every source is best-effort: a failure in one never aborts the others.
 *
 * @typedef {{host:string, port:number, source:string}} Discovered
 */

/** Parse a Thunderbird/ISPDB autoconfig XML document for the outgoing SMTP server. */
export function parseAutoconfig(xml) {
  const block = String(xml || '').match(/<outgoingServer[\s\S]*?<\/outgoingServer>/i);
  if (!block) return [];
  const host = (block[0].match(/<hostname>\s*([^<]+?)\s*<\/hostname>/i) || [])[1];
  const port = Number((block[0].match(/<port>\s*(\d+)\s*<\/port>/i) || [])[1]);
  if (!host || !Number.isInteger(port)) return [];
  return [{ host: host.trim(), port }];
}

/** Map SRV lookup results to host/port candidates (submission=587, submissions=465). */
export function srvCandidates(submission, submissions) {
  const out = [];
  for (const r of submission || []) if (r?.name) out.push({ host: r.name, port: r.port || 587 });
  for (const r of submissions || []) if (r?.name) out.push({ host: r.name, port: r.port || 465 });
  return out;
}

/**
 * @param {string} domain
 * @param {{dns:{resolveSrv:Function}, fetchFn:typeof fetch}} deps
 * @returns {Promise<Discovered[]>}
 */
export async function discoverHosts(domain, { dns, fetchFn }) {
  const out = [];
  const seen = new Set();
  const add = (host, port, source) => {
    if (!host || !Number.isInteger(port)) return;
    const key = `${String(host).toLowerCase()}:${port}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ host, port, source });
  };

  // 1. SRV records (authoritative)
  try {
    const [sub, subs] = await Promise.all([
      dns.resolveSrv(`_submission._tcp.${domain}`).catch(() => []),
      dns.resolveSrv(`_submissions._tcp.${domain}`).catch(() => []),
    ]);
    for (const c of srvCandidates(sub, subs)) add(c.host, c.port, 'srv');
  } catch {
    /* ignore */
  }

  // 2. Mozilla ISPDB, then 3. domain-published autoconfig
  const urls = [
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
    `https://autoconfig.${domain}/mail/config-v1.1.xml`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
  ];
  for (const url of urls) {
    try {
      const res = await fetchFn(url);
      if (res?.ok) for (const c of parseAutoconfig(await res.text())) add(c.host, c.port, 'autoconfig');
    } catch {
      /* best-effort */
    }
  }

  return out;
}
