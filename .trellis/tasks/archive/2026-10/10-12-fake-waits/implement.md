# 执行清单

## 1. 判定器（先做工具，再拿它做审计）

- [x] `tools/check-wait-predicates.mjs`：AST 判定「每条返回路径都是常量真值」
- [x] 解析「谓词是具名引用」（顶层 `const 名 = 函数` / `function`）—— 否则会有 5 处判不了
- [x] 导出 `analyze(source)` 供单测（入口守卫：被 import 时不跑 main）
- [x] 判不出来的一律列成「需人工确认」，不算失败

## 2. 审计全仓

- [x] 扫 `tests/e2e/**/*.mjs` + `tools/**/*.mjs`（两处都 import 同一个 harness）
- [x] 逐个人工核实判定器判不了的那些（5 处，都是布尔比较）
- [x] 真阳性 1 处：`gui-space-pin.mjs` → 未就绪返回 `null`、就绪才交出对象
- [x] 该处的失败现场不丢：超时信息里补上「最后一次探到几组」

## 3. 反向验证（三份）

- [x] ① 两种谓词形态的语义实验（旧 8ms 返回 / 新 3056ms 真等）
- [x] ② 弄坏应用侧 → 那条断言因为**原来的原因**变红，文案一字未变
- [x] ③ `tests/unit/wait-predicates.test.mjs`：真阳性 5 形态 + 不误报 6 形态 + 判不了如实说

## 4. 接线

- [x] `package.json` 的 `check:wait-predicates`
- [x] `scripts/lint.mjs` 的 runCheck
- [x] `.github/workflows/ci.yml` 静态检查 job 新增一步

## 5. 规范与记录

- [x] `.trellis/spec/testing/index.md` §三.1：门禁用法 + **盲区表** + 审计方法四条 + 不在此列的一类
- [x] `research/wait-audit.md`：审计证据（含 5 处人工核实、三份反向验证、盲区）
- [x] CHANGELOG `[Unreleased] → 修复`
