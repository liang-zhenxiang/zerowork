# 执行清单（已完成）

- [x] 取官方 tarball → 复核 sha256 → 复制 `package/xlsx.mjs` 为 `vendor-xlsx.js`
- [x] `npm run build` + `preview-renderers.mjs`（含新增的 CSV 用例）
- [x] `VERSION_MARKER` 跟上形态；导出版本解析函数；加导入守卫（供新脚本复用）
- [x] `scripts/check-vendored-advisories.mjs`（OSV 查询 + 豁免反查 + 三种退出码）
- [x] `.github/workflows/vendored-advisories.yml`（每周一 + 手动；有发现开/更新 Issue）
- [x] SECURITY.md / THIRD_PARTY_NOTICES.md / MAINTAINER_GUIDE.md（工作流表）/ CHANGELOG.md
- [x] 反向验证（换回 0.18.5 → 三处红）
