# 执行清单：#479

## 0. 开工
- [x] 分支 `feat/docx-patch-engine`，任务与规划落盘
- [x] Issue #479 留言，确认无并行 PR/分支

## 1. Python 引擎
- [x] `resources/docx-engine/patch_docx.py`：参数、zip 校验、唯一单 run 匹配、跨 run 拒绝
- [x] 保元数据写 zip、临时文件 + `os.replace`、写后自检
- [x] 成功/失败 JSON 契约与错误码
- [x] 自带 README/注释说明它不参与本项目工具链

## 2. Node 封装
- [x] `src/main/daemon/docx-patch.js`：`patchDocx(req, run)`、超时/截断/错误映射
- [x] 不新增依赖；沿用 `doc-extract.js` 的 run 形态

## 3. 测试
- [x] `tests/unit/docx-patch.test.mjs`：fake run 契约；python3 真跑夹具
- [x] 跨 run / 找不到 / 多处命中 / 非法 zip / 输出不存在
- [x] 若 python3 不可用则显式 skip 并保留原因

## 4. 验证
- [x] `npm test`、`check:unicode`、`check:daemon-graph`、`lint:all`（zizmor 环境项除外）
- [x] 反向验证：放宽唯一命中 → 多命中用例红；去掉自检 → 对应用例红

## 5. 收尾
- [x] CHANGELOG 不新增（用户不可感知；#481 接入时再记）
- [ ] 提交 → PR（Closes #479）→ CI 绿 → squash
- [ ] 归档、更新 Roadmap
