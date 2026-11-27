# 执行清单：#498

- [x] `patch_docx.py`：段落分组（保留 `w:t` 顺序与字符偏移）与段内拼接定位
- [x] 单 `w:t` 命中走现有路径；跨 `w:t` 走合并路径（`rPr` 一致、无 tab/br、`w:t` 在 `w:r` 内）
- [x] 替换映射：首段保留前缀、中间清空、末段保留后缀；统一整段转义；不删节点
- [x] 自检：每个 `w:t` 预期文本 + 目标段落拼接文本 + 其余段落不变
- [x] 成功响应增加 `cross_run_merged`
- [x] `docx-patch.js` 解析该字段并返回；`docx-replace.js` 文案只描述剩余拒绝面
- [x] 单测：同格式跨 run 成功（动态文档）；夹具 A 的格式不同跨 run 拒绝；夹 tab 拒绝；跨段落不拼接；多处命中仍拒绝；现有用例全绿
- [x] 反向验证：`rPr` 比较改恒真 → 格式不同用例红，还原
- [x] ADR-0001 与工具描述同步
- [x] `npm test`、`npm run lint:all`、`npm run check:unicode`
- [x] PR（Closes #498）
