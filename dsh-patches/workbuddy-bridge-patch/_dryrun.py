"""Dry-run the patch: apply it to the pristine backup and report marker counts.

Nothing is written to the installed bundle; the result lands in _patched_client_v3.js
so `node --check` and the test scripts can inspect it first.
"""

import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("p", "patch_credit_tokens.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

BAK = Path(r"C:/Users/user\.dsh\profiles\desktop\node_modules\dsh-workbuddy-bridge\lib\client.js.bak-tokens-20261024-155446")
orig = BAK.read_text(encoding="utf-8")
try:
    out = m.patch(orig)
except SystemExit as e:
    print("FAIL:", e)
    raise SystemExit(1)

Path("_patched_client_v3.js").write_text(out, encoding="utf-8", newline="\n")
print(f"ok {len(orig)} -> {len(out)}")

TOKENS = [
    # shared plumbing
    "readStatusShared", "subscribeFocusRefresh", "openSessionCreditStore", "sessionCreditStores",
    # per-model charge model
    "MODEL_CHARGE", "DEFAULT_CHARGE", "creditsPerToken", "chargeFor",
    "CREDIT_PER_BILLED_TOKEN", "CREDIT_PER_OUTPUT_TOKEN",
    # dock row
    "DOCK_SEAT", "conversation.input.dock", "tokenEstimateRate", "Rbiksq_dock", "Rbiksq_rate",
    # direct fetches must all be gone
    "fetch(card.statusPath", "fetch(variant.statusPath", 'addEventListener("focus"',
    "read(controller.signal, true)",
]
for token in TOKENS:
    print(f"  {token!r}: {out.count(token)}")
