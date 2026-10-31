# 把导出的扁平格式转成桥接插件解析的嵌套格式（{"auth":{...},"account":{...}}），供 dsha 使用
import json, os

SRC = r"C:/Users/user\.dsh\workbuddy-auth-export-2026-10-27T16-10-35.json"
DST = r"C:/Users/user\.dsh\workbuddy-auth-for-dsha.json"

d = json.load(open(SRC, encoding="utf-8"))
doc = {
    "auth": {
        "accessToken": d["accessToken"],
        "refreshToken": d["refreshToken"],
        "expiresAt": d["expiresAtMs"],          # 毫秒时间戳，插件 expiryToMs 直接接受
        "domain": d["account"]["domain"],
    },
    "account": {
        "uid": d["account"]["uid"],
        "enterpriseId": d["account"]["enterpriseId"],
    },
}
with open(DST, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("written:", DST, os.path.getsize(DST), "bytes")
print("--- accessToken ---")
print(d["accessToken"])
print("--- refreshToken ---")
print(d["refreshToken"])
