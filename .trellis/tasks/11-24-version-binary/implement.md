# 执行清单：#480

- [x] `version-store.js`：`recordBinaryVersion` / `readVersionBytes` / restore 分支 / 上限
- [x] meta 兼容：旧条目无 binary 视为文本
- [x] `tests/unit/version-store-binary.test.mjs`：往返、文本回归、上限、坏 meta、还原原子
- [x] `npm test`、`check:unicode`、`check:daemon-graph`
- [x] 反向验证：二进制写成 `.txt`/按文本解码 → 对应用例红
- [ ] PR（Closes #480）
