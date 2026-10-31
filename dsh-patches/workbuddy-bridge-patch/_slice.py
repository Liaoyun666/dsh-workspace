import re
from pathlib import Path
BAK = Path(r"C:/Users/user\.dsh\profiles\desktop\node_modules\dsh-workbuddy-bridge\lib\client.js.bak-tokens-20261024-155446")
t = BAK.read_text(encoding="utf-8")

def show(label, start, end, ctx=0):
    i = t.find(start)
    print("=== " + label + " idx=" + str(i) + " ===")
    if i < 0:
        return
    j = t.find(end, i)
    print(repr(t[i:j+len(end)]))

show("PROBE_SEAT const", '\t\tconst PROBE_SEAT = "conversation.input.right";', '\t\tconst PROBE_SEAT = "conversation.input.right";')
show("registration block", '\t\t\tctx.inject(["modelDirectories"], (scope) => {\n\t\t\t\tscope.slots.inject(PROBE_SEAT, () => {', '\t\t\t});\n\t\t\tctx.inject(["modelDirectories"], (scope) => scope.slots.inject(MESSAGE_ACTIONS_SEAT')
