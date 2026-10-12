# 执行清单

## 1. 覆盖率

- [x] `npm install -D @vitest/coverage-v8@5.0.3`（与 vitest 5.0.3 同版）
- [x] `vitest.config.mjs`：provider v8、include 限定四层、reporter `text-summary` + `json-summary`
- [x] 阈值 = 实测基线减约一个点；把实测值与「为什么不好看也要用它」写进注释
- [x] `package.json` 的 `test:coverage`
- [x] `ci.yml`：ubuntu leg 跑 `test:coverage`，windows leg 照旧 `test`

## 2. 反向验证

- [x] 把阈值抬到实测值之上（`--coverage.thresholds.lines=16`）→ 命令退出码非 0，
      报 `ERROR: Coverage for lines (15.66%) does not meet global threshold (16%)`

## 3. 文档

- [x] `docs/MAINTAINER_GUIDE.md` 测试分层那节：补覆盖率与门禁说明
- [x] 顺手修掉同段里过时的「单测当前 104 项」（实测 726 条），并按它自己的规矩
      改成「不写在这里，以运行器输出为准」

## 4. 收掉 #30

- [x] 五条期望逐条对应到今天的状态（写进关闭评论）
- [x] 说明「不再往这个 Issue 里加东西」：该补的测试由具体功能与缺陷驱动
