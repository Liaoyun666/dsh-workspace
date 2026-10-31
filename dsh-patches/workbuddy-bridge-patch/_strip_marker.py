import pathlib, sys

p = pathlib.Path(r"C:/Users/user\.dsh\profiles\desktop\node_modules\dsh-workbuddy-bridge\lib\heartbeat-CKHC_c0-.js")
s = p.read_text(encoding="utf-8", errors="surrogateescape")
i = s.find('try { process.getBuiltinModule("node:fs").appendFileSync')
if i < 0:
    print("没有标记，无需处理")
    sys.exit(0)
p.write_bytes(s[:i].encode("utf-8", "surrogateescape"))
print("已移除标记，当前大小", p.stat().st_size)
print("末尾:", repr(s[i - 60 : i]))
