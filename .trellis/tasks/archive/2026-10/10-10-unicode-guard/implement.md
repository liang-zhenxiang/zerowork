# 执行清单

## 1. 脚本本体

- [ ] `scripts/check-unicode.mjs`，导出纯函数供单测：
  - `findReplacements(text)` → `[{ line, text }]`（行号 1 起）
  - `isExempt(file, { includeResources })` → boolean
  - `looksBinary(buffer)` → boolean（前 8000 字节含 NUL）
- [ ] CLI：`git ls-files -z` 取清单 → 逐个读 → 汇总 → 退出码
- [ ] `--all`：不排除 `resources/**`
- [ ] 输出与 `check-line-endings.mjs` 同形（`✓` / `✗` / 修复指引 / `NO_COLOR` 尊重）
- [ ] 不在 git 仓库时：显式打印「跳过」并退出 0（不假装通过）
- [ ] 打印统计：扫了几个文件、豁免了几个、`--all` 时提示默认范围

## 2. 接线

- [ ] `package.json`：`"check:unicode": "node scripts/check-unicode.mjs"`
- [ ] `scripts/lint.mjs`：`runCheck('U+FFFD 替换字符', ...)`，挨着「行尾一致性」
- [ ] `.github/workflows/ci.yml` 静态检查 job：新增一步「校验中文内容无替换字符」

## 3. 测试

- [ ] `tests/unit/check-unicode.test.mjs`：
  - 逐行定位（一行多个 U+FFFD 只报一次、行号正确）
  - 豁免判定（三个合法文件、`resources/` 前缀、`--all` 下不豁免）
  - 二进制判定（含 NUL 的 buffer 为真、纯文本为假）
  - 空文件 / 无命中返回空数组

## 4. 反向验证（必须真做，不能只宣称）

- [ ] 往一个源码文件里塞一个 U+FFFD → `npm run check:unicode` 退出码 1 且打印 `文件:行号`
- [ ] 删掉 → 退出码 0
- [ ] `npm run lint:all` 里能看到这一项且为通过

## 5. 文档

- [ ] `AGENTS.md`「中文内容质量」：人工 python 脚本改为 `npm run check:unicode`；
      **保留**「按行号整行重写、不要 replace 单个替换字符」的坑记录
- [ ] `docs/MAINTAINER_GUIDE.md`：守卫处补一条；`AGENTS.md` 与该文件必须说法一致

## 6. 收尾

- [ ] 全仓 U+FFFD 扫描为 0（`--all` 也跑一次，确认 `resources/**` 当前是干净的）
- [ ] CHANGELOG `[Unreleased]` 记一条
- [ ] Trellis 任务归档、Roadmap #21 把 #180 移入已完成
