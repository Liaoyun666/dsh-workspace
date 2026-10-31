import json, io
p = "astrbot-home/data/cmd_config.json"
raw = io.open(p, encoding="utf-8-sig").read()
d = json.loads(raw)
d["platform"] = [{
    "id": "default",
    "type": "aiocqhttp",
    "enable": True,
    "ws_reverse_host": "0.0.0.0",
    "ws_reverse_port": 6199,
    "ws_reverse_token": "",
}]
io.open(p, "w", encoding="utf-8-sig", newline="\n").write(json.dumps(d, ensure_ascii=False, indent=2))
print("platform:", json.dumps(d["platform"], ensure_ascii=False))
