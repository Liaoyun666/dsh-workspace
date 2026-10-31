import json, sys, datetime, os

D = r"C:/Users/user\.dsh"
for name in [".workbuddy-auth.json", "workbuddy-auth-export-2026-10-27T16-10-35.json"]:
    p = os.path.join(D, name)
    print("==", name, os.path.getsize(p) if os.path.exists(p) else "MISSING")
    if not os.path.exists(p):
        continue
    d = json.load(open(p, encoding="utf-8"))
    print("  keys:", list(d))

    def g(*ks):
        for k in ks:
            if isinstance(d, dict) and k in d:
                return d[k]
        return None

    at = g("accessToken", "access_token")
    rt = g("refreshToken", "refresh_token")
    exp = g("expiresAt", "expiresAtMs", "expired_at")
    print("  accessToken:", (len(at) if isinstance(at, str) else at), "expiresAt:", exp)
    print("  refreshToken:", (len(rt) if isinstance(rt, str) else rt))
