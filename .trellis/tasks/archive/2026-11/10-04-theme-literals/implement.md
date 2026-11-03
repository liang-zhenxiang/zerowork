# 执行清单（已完成）

- [x] `scripts/check-theme-tokens.mjs`：`collectDeclarations`（全深度状态机）+ `colorLiteralsIn`
      + 命名色全表 + `MASK_PROP` 排除 + `COLOR_LITERAL_ALLOWED` 白名单 + `--list` 模式
- [x] 首次盘点 32 处 → 26 处白名单 / 3 处掩膜（非颜色）/ 1 类 2 处真漏网
- [x] 修 `.markdown code.clickable-path`（color-mix），删掉那条自认的「例外」
- [x] `docs/DESIGN.md` §2.0 写清两项检查；§10.3.2 补登记两条 scrim
- [x] `tests/e2e/dark-polish.mjs` 新增一条：路径徽章底色随主题变、深色下亮度 < 90
      （调试中踩到：`color-mix` 的计算值是 `color(srgb 0..1)`，断言按 0–255 解析会算出亮度 1）
- [x] `CHANGELOG.md`
- [x] 反向验证三条（真跑 + 复原），记录在脚本头部
