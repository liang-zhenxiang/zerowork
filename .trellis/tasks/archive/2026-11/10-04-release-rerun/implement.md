# 执行清单（已完成）

- [x] `release.yml`：`on.workflow_dispatch`（必填 tag）、`run-name` 取输入
- [x] notes / publish 两个 job 的 `TAG` 统一成 `${{ inputs.tag || github.ref_name }}`，
      并删掉各步里重复的 `TAG: ${{ github.ref_name }}`（那会在重算时把它覆盖成 main）
- [x] checkout 的 `ref` 取输入 tag + 新增「校验 tag 存在」步骤
- [x] `installers` job 与「附上安装包」步骤在 dispatch 下跳过
- [x] 总结里的 `GITHUB_REF_NAME` 改成 `$TAG`
- [x] `docs/MAINTAINER_GUIDE.md`
- [x] 本地：js-yaml 解析 + 关键字段断言（on/dispatch 输入/各 job env/if）
- [x] 合并后真跑两次 dispatch（正例 v0.4.0、反例 v9.9.9）
