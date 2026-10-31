---
name: update-translations
description: 维护 Antigravity 简体中文界面的翻译词典。当用户要求补充、修正或删除界面翻译，或某个界面文字仍显示英文时使用。
---

# 维护中文界面翻译

1. 词典文件位于插件目录 `~/.gemini/config/plugins/antigravity-zh-cn/sidecars/zh-cn-ui/translations.json`，格式为 `{"English": "中文"}`。
2. 追加或修改条目时，键必须与界面中**完整的文本节点**一致（大小写敏感，不含首尾空白）。
3. 对于带数字/变量的动态文本，在 `translator.js` 的 `PATTERNS` 数组里添加正则规则，而不是写死词典。
4. 保存后在设置中禁用再启用本插件，或重启 Antigravity，即可重新注入。
