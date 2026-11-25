# 执行清单：#483

- [x] mock 服务新增两条 docx 工具调用分支（替换 / 跨 run），守卫与 `wantsNormalWrite` 同形
- [x] e2e：真实工具调用 → 建议出现、文件字节不变；亮 / 暗截图
- [x] e2e：接受后用 `inspect_docx.py` 清单断言保真（正文变、样式/编号/超链接/表格/页眉页脚不变、其余条目 sha256 一致）
- [x] e2e：关闭修订模式 → 跨 run 被拒绝、文件字节不变、工具结果含可读原因（运行时未就绪时 skip）
- [x] `docs/USAGE.md` 修订模式一节改为 docx v1 范围与边界
- [x] CHANGELOG 措辞与 USAGE 对齐
- [x] 本地：`node tests/e2e/gui-doc-edit-base.mjs`、`npm run test`、`npm run lint:all`、`npm run check:unicode`
- [x] 反向验证：去掉跨 run 判定 → 跨 run 用例红；去掉版本先行 → 还原用例红（任选一条真跑并还原）
- [x] PR（Closes #483）
