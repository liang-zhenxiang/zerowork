# 执行清单

## 1. daemon：把事实翻译成布尔值

- [ ] `models.js` 新增 `hasPlaceholderCredential(path, providerId)`：读原始条目、与
      `LOCAL_PLACEHOLDER_API_KEY` 比对；**apiKey 不出这个模块**
- [ ] `model-catalog.js` 的 `toProviderInfo` 返回 `placeholderCredential`

## 2. 渲染层：换动作位

- [ ] `sourceLabel$1`：`placeholderCredential` 优先 → 「已接入本机服务」
- [ ] `canRemoveKey`：`placeholderCredential` → 不给「清除」
- [ ] `ProviderRow`：`placeholderCredential` → `.provider-hint`「无需 Key」（照订阅那行的手法）

## 3. 测试

- [ ] 单测（`custom-provider-apikey.test.mjs`）：占位 → true；用户自己填的 Key → false；
      没这条服务商 → false；编辑一次（upsert 继承）后仍是 true
- [ ] e2e（`local-model-discovery.mjs`，复用它的一键接入）：
      - [ ] 接入后 → 设置 · 服务商那一行：meta 是「已接入本机服务」、动作位是「无需 Key」、
            **没有**「更换 Key」也没有「清除」
      - [ ] 另一个**用户填过 Key** 的服务商 → 照旧「更换 Key」（且 baseUrl 故意也用回环地址，
            钉住「判据是凭据、不是地址」）

## 4. 反向验证

- [ ] 把 `placeholderCredential` 恒置 false → 本机那一行的用例变红；置恒 true → 云端那行变红

## 5. 收尾

- [ ] CHANGELOG `[Unreleased] → 修复`
- [ ] `docs/ARCHITECTURE.md` 决策表那一行补一句：占位凭据现在会被 daemon 识别并翻译成
      `placeholderCredential`（原文只说了「渲染层拿不到该字段」）
