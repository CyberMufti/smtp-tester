#!/usr/bin/env python3
"""
Email-authentication sidecar for SMTP Tester.

Reads a JSON request on stdin and prints a JSON result on stdout. It does the
things that are hard to do accurately in hand-rolled JavaScript:

  * SPF   — real evaluation (include:/redirect=, the 10-lookup limit, the final
            qualifier) via pyspf, not just a regex read of the record.
  * DKIM  — cryptographic signature verification via dkimpy (JS has no
            equivalent in this app — it only reads the result header).
  * DMARC — policy lookup plus identifier alignment against the From domain.

Each library is imported independently and guarded, so a partial install still
produces partial results instead of failing outright. `--selfcheck` reports
which libraries are present so the Node side can fall back to its JS checks when
the sidecar can't add value.

Contract (stdin JSON):
  {
    "domain":   "example.com",          # From / organizational domain
    "ip":       "203.0.113.4",          # optional — sender IP, for SPF
    "helo":     "mail.example.com",     # optional — HELO, for SPF
    "mailfrom": "bounce@example.com",   # optional — MAIL FROM, for SPF
    "message":  "<raw RFC822 text>"     # optional — for DKIM verification
  }

Stdout JSON: see build_result(). Always one object; exit 0 unless stdin is
unreadable/!JSON (exit 2).
"""
import json
import sys

# --- independent, guarded imports -------------------------------------------
try:
    import dns.resolver as _dnsresolver  # dnspython
except Exception:
    _dnsresolver = None

try:
    import spf as _spf  # pyspf
except Exception:
    _spf = None

try:
    import dkim as _dkim  # dkimpy
except Exception:
    _dkim = None


def _missing():
    miss = []
    if _dnsresolver is None:
        miss.append("dnspython")
    if _spf is None:
        miss.append("pyspf")
    if _dkim is None:
        miss.append("dkimpy")
    return miss


def _txt(name):
    """Return the list of TXT strings at `name`, or [] on any failure."""
    if _dnsresolver is None:
        return []
    try:
        answers = _dnsresolver.resolve(name, "TXT")
    except Exception:
        return []
    out = []
    for rec in answers:
        try:
            parts = rec.strings  # list[bytes]
            out.append(b"".join(parts).decode("utf-8", "replace"))
        except Exception:
            out.append(str(rec).strip('"'))
    return out


def check_spf(req):
    domain = req.get("domain") or ""
    records = _txt(domain)
    record = next((r for r in records if r.strip().lower().startswith("v=spf1")), None)
    qualifier = None
    if record:
        for tok in record.split():
            low = tok.lower()
            if low.endswith("all") and low[:-3] in ("+", "-", "~", "?", ""):
                qualifier = (low[:-3] or "+") + "all"
    out = {"found": record is not None, "record": record, "all": qualifier, "result": None, "explanation": None}

    ip = req.get("ip")
    if _spf is not None and ip and (req.get("mailfrom") or domain):
        sender = req.get("mailfrom") or ("postmaster@" + domain)
        helo = req.get("helo") or domain
        try:
            result, explanation = _spf.check2(i=ip, s=sender, h=helo)
            out["result"] = result          # pass/fail/softfail/neutral/none/permerror/temperror
            out["explanation"] = explanation
        except Exception as e:
            out["result"] = "temperror"
            out["explanation"] = f"spf evaluation error: {e}"
    return out


def check_dmarc(req, spf_out, dkim_out):
    domain = req.get("domain") or ""
    records = _txt("_dmarc." + domain) if domain else []
    record = next((r for r in records if r.strip().lower().startswith("v=dmarc1")), None)
    policy = None
    pct = None
    if record:
        for tok in record.replace(" ", "").split(";"):
            if tok.lower().startswith("p="):
                policy = tok[2:].lower() or None
            elif tok.lower().startswith("pct="):
                try:
                    pct = int(tok[4:])
                except ValueError:
                    pass

    # Alignment (relaxed): does an authenticated identifier share the org domain?
    aligned = None
    if record:
        aligned = False
        if spf_out.get("result") == "pass" and domain:
            mf = (req.get("mailfrom") or "").split("@")[-1].lower()
            if mf and (mf == domain.lower() or mf.endswith("." + domain.lower())):
                aligned = True
        for d in dkim_out.get("domains") or []:
            dl = str(d).lower()
            if dl == domain.lower() or dl.endswith("." + domain.lower()):
                aligned = True
    return {"found": record is not None, "record": record, "policy": policy, "pct": pct, "aligned": aligned}


def check_dkim(req):
    out = {"verified": None, "domains": [], "detail": None}
    msg = req.get("message")
    if not msg:
        out["detail"] = "no message supplied"
        return out
    if _dkim is None:
        out["detail"] = "dkimpy not installed"
        return out
    raw = msg.encode("utf-8", "replace") if isinstance(msg, str) else bytes(msg)
    try:
        d = _dkim.DKIM(raw)
        verified = d.verify()
        out["verified"] = bool(verified)
        # Signing domains from the DKIM-Signature header(s).
        import re
        for h, v in re.findall(r"(?im)^(dkim-signature)\s*:(.*(?:\n[ \t].*)*)", raw.decode("utf-8", "replace")):
            m = re.search(r"\bd=([^;\s]+)", v)
            if m:
                out["domains"].append(m.group(1).strip())
    except Exception as e:
        out["verified"] = False
        out["detail"] = f"dkim verify error: {e}"
    return out


def build_result(req):
    spf_out = check_spf(req)
    dkim_out = check_dkim(req)
    dmarc_out = check_dmarc(req, spf_out, dkim_out)
    return {
        "ok": True,
        "engine": "python",
        "missing": _missing(),
        "spf": spf_out,
        "dkim": dkim_out,
        "dmarc": dmarc_out,
    }


def main(argv):
    if "--selfcheck" in argv:
        miss = _missing()
        print(json.dumps({"available": len(miss) == 0, "partial": len(miss) < 3, "missing": miss}))
        return 0
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"invalid request: {e}"}))
        return 2
    print(json.dumps(build_result(req)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
