# 执行清单：#460

- [x] 分支 `docs/docx-revision-adr`、Issue 留言、任务创建
- [x] 建两个夹具（样式/编号/超链接；表格/页眉页脚）
- [x] 实验 A：解包 docx，改 `word/document.xml` 的文本 run，重新打包，检查其他部分是否逐字节不变
- [x] 实验 B：python-docx 读取后重建（托管 venv 可用，已实测环回保存与全量重建）
- [x] 实验 C：docx → HTML → docx（现有转换链），记录丢失项
- [x] 附加实验：跨 run 拒绝、结构插入/删除、表格单元格与页眉部件
- [x] ADR：对比、结论、用户提示、后续拆分
- [x] 复现命令实测
- [ ] PR + CI
