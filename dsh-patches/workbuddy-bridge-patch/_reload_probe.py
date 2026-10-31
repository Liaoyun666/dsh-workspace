import pathlib, sys

P = pathlib.Path(r"C:/Users/user\.dsh\profiles\desktop\node_modules\dsh-workbuddy-bridge\lib\heartbeat-CKHC_c0-.js")
MARK = '// wb-reload-probe\ntry { process.getBuiltinModule("node:fs").appendFileSync("C:/Users/user/.dsh/.wb-reload-marker.txt", String(Date.now()) + "\\n"); } catch {}\n'

action = sys.argv[1] if len(sys.argv) > 1 else "add"
raw = P.read_bytes()
text = raw.decode("utf-8", "surrogateescape")

if action == "add":
    if text.startswith("// wb-reload-probe"):
        print("已有探针")
        sys.exit(0)
    P.write_bytes((MARK + text).encode("utf-8", "surrogateescape"))
    print("已前置探针，大小", P.stat().st_size)
elif action == "strip":
    if not text.startswith("// wb-reload-probe"):
        print("没有探针")
        sys.exit(0)
    end = text.index("\n", text.index("\n") + 1) + 1
    P.write_bytes(text[end:].encode("utf-8", "surrogateescape"))
    print("已移除探针，大小", P.stat().st_size)
