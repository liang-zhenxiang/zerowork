# 技术设计：暗色主题落地

> 对应 PRD 的 A 部分（旗舰）。B 部分（精品化清单）待研究员报告后补设计。

## 0. 现有地基（不重造）

| 已存在 | 位置 | 说明 |
| --- | --- | --- |
| 暗色 token 全量 | `app.css:696` `[data-theme="dark"]` | 文字三级/表面/主色/状态色/分类板/阴影全齐 |
| 三档 CSS 结构 | `app.css` 双路规则 | `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) …}` —— **已经为「跟随系统」档设计好**：system 档不设 `data-theme` 即自动跟随；light 档设 `data-theme="light"` 挡住媒体查询；dark 档设 `data-theme="dark"` 走显式块 |
| widget 双路暗色 | `app.js` WIDGET_CSS/WIDGET_BOOTSTRAP | iframe 内同样的双路规则 + `type:"theme"` postMessage 消息（基建在，需核对渲染层是否已推送） |
| 偏好持久化 | `src/main/daemon/preferences.js` → `preferences.json` | `readPreferences()/writePreferences()`，handler 表注册模式（`session-files.js:4426` 起的成对 `[INVOKE.getX]/[INVOKE.setX]`） |
| titleBarOverlay | `src/main/index.js:258` | 全透明底，只需联动 `symbolColor` |

## 1. 数据模型

`preferences.json` 新增字段：

```jsonc
{ "theme": "system" }   // "system" | "light" | "dark"，缺省语义＝system
```

- 合法值校验收在 daemon handler 单出口（同 `thinkingLevel` 口径：非法值抛中文错误、
  「没写就是没写」——读处不填默认值，缺省语义收在 getter 一处）
- 三档枚举：`isThemePreference(v)` 纯函数放 `preferences.js`（可单测）

## 2. 链路（四段）

### 2.1 IPC 通道（`src/shared/ipc.js` + `src/preload/index.js`）

```
getThemePreference: "settings:get-theme"     // → { theme: "system"|"light"|"dark" }
setThemePreference: "settings:set-theme"     // (theme) → void
```

preload 暴露 `window.kami.getThemePreference() / setThemePreference(theme)`。

### 2.2 daemon handler（`session-files.js` handler 表，紧邻 getStyle/setStyle）

```js
[INVOKE.getThemePreference]: async () => ({ theme: readPreferences().theme ?? "system" }),
[INVOKE.setThemePreference]: async ([theme]) => {
  if (!isThemePreference(theme)) throw new Error(`未知的外观档位：${String(theme)}`);
  writePreferences({ ...readPreferences(), theme });
}
```

### 2.3 主进程联动（`src/main/index.js`）——**防闪白的关键**

- 启动时（创建窗口**之前**）读偏好 → `nativeTheme.themeSource = theme`
  （读路径：`getConfigDir()/preferences.json`——主进程直接 `readFileSync`，
  只读不写；写永远走 daemon，避免双写竞争）
- `nativeTheme.themeSource` 是 Electron 原生 API：设为 `dark`/`light` 时**整个应用的
  `prefers-color-scheme` 媒体查询跟着变**——所以显式档下 CSS 媒体查询规则也被
  正确压制/激活，与 `data-theme` 属性两条路指向一致，不冲突
- `titleBarOverlay.symbolColor`：主进程在 `nativeTheme.on('updated')` 里按
  `shouldUseDarkColors` 切换（深色 → `#f2f2f2`，浅色 → 现值），通过
  `win.setTitleBarOverlay()` 动态更新
- 监听 `INVOKE.setThemePreference`：主进程把这个通道从批量转发表拆出
  （加进 `MAIN_HANDLED` 单独注册），handler 里先 `callDaemon` 落盘、成功后设
  `nativeTheme.themeSource = theme`——**单次调用完成「落盘 + 生效」**。
  之所以仍要设 `themeSource`：路线 A 下渲染层 `system` 档靠
  `matchMedia("(prefers-color-scheme: dark)")` 求值，该媒体查询的取值由
  `themeSource` 决定（设为 light/dark 即覆写，system 即跟随 OS）
- `titleBarOverlay.symbolColor`：`nativeTheme.on('updated')` 里按
  `shouldUseDarkColors` 切换（深色 → `#f2f2f2`，浅色 → `#333333` 现值），
  `win.setTitleBarOverlay()` 动态更新（仅 Windows 有 overlay；macOS
  hiddenInset 红绿灯是系统控件自动适配，跳过）
- ~~向窗口推送 `theme:changed`~~ **不需要**：渲染层自己监听
  `matchMedia change`（见 2.4）

### 2.4 渲染层（`app.js`）——属性驱动（2026-10-01 定案：路线 A）

> **决策依据**：核实发现 `app.css` **没有** `prefers-color-scheme` 媒体查询版暗色块
> （只有 `app.js` 里的 widget CSS 有双路）。所以主进程 `themeSource` 驱动媒体查询
> 这条路（路线 B）需要把 token 块复制进 CSS 媒体查询，违背本项目「单一真源」纪律。
> 选路线 A：**`data-theme` 属性是唯一驱动**，CSS 保持单源。

- **接线（挂载前同步执行）**：`app.js:68254`（`const root = document.getElementById("root")`
  之前）插一个同步初始化：
  1. 读偏好（此处不能 await——同步上下文。方案：主进程把初始主题经
     `process.argv`/webPreferences 注入不可行（sandbox 环境），改为
     **localStorage 镜像**：渲染层每次 set 时写 `localStorage["theme"]`，
     启动时同步读它作初值；首次无镜像时默认 `"light"` 并让异步
     `getThemePreference()` 纠偏——纠偏发生在首帧之后但仅一次、仅在
     镜像缺失时（新用户），可接受）
  2. 求值有效主题：显式档直接用；`"system"` 档用
     `window.matchMedia("(prefers-color-scheme: dark)").matches` 求值
     （主进程已在建窗口前设好 `themeSource`，渲染层首帧求值即正确）
  3. `document.documentElement.setAttribute("data-theme", 有效主题)`
- **跟随变化**：`matchMedia(...)` 的 `change` 监听（仅 system 档有意义，但统一
  监听再按档位判断）→ 更新属性 → `window.dispatchEvent(new CustomEvent("zw:theme-changed"))`
- **`hostTheme()`**（`app.js:31165`，现为硬编码 `"light"` 存根）：改为
  `document.documentElement.dataset.theme === "dark" ? "dark" : "light"`；
  `WidgetView` 订阅 `zw:theme-changed` 触发重渲染（现有 theme effect
  依赖 `[frameReady, theme]`，会自动向 iframe 重推）
- **设置 UI**：`GeneralSection`（`app.js:62318`）顶部新增 `AppearanceSection`
  （通用分组第一项——外观是最高频设置），三选一控件（segmented control 形态，
  与 ThinkingLevel 的档位选择同模式），选中即调 `setThemePreference` +
  同步更新属性与 localStorage 镜像，乐观更新 + 失败回滚（同 `StyleSection.change` 模式）
- **设置 UI**：`GeneralSection`（`app.js:62318`）顶部新增 `AppearanceSection`
  （通用分组第一项——外观是最高频设置），三选一控件（segmented control 形态，
  与 ThinkingLevel 的档位选择同模式），选中即调 `setThemePreference`，
  乐观更新 + 失败回滚（同 `StyleSection.change` 模式）

### 2.5 widget 联动核对

`WIDGET_BOOTSTRAP` 已处理 `type:"theme"` 消息。渲染层宿主侧：查现有 widget
挂载处是否在创建/主题变化时 postMessage `theme`。**若只支持创建时一次性设置**，
补「运行中切换」路径：遍历活动 widget iframe 推送。

## 3. 散点 rgba 清理（受主题影响的才改）

已知约 30 处 rgba 硬编码。处置原则：

1. **承担表面/文字/边框语义的** → 换 token（逐处判断语义，不机械替换）
2. **pdf 选区高亮（`--annotation-unfocused-field-background`）等第三方/vendored 样式** →
   保留，加注释说明「不随主题」的理由（pdf 渲染底色固定白）
3. 每处改动在 PR 描述里列表说明（可审查、可回滚）

## 4. 静态契约检查（防未来腐化）

新脚本 `scripts/check-theme-tokens.mjs`：

1. 解析 `app.css`，提取 `:root` 块与 `[data-theme="dark"]` 块的 token 名集合
2. 断言：**随主题会变的 token**（颜色/阴影/遮罩类）在暗色块全部有覆盖
   （不透明度、尺寸类不在此列——注释已写「不随主题变化，继承 :root」）
3. 断言：`prefers-color-scheme` 媒体查询规则与 `[data-theme="dark"]` 规则
   在 app.css 成对出现（widget 那份在 app.js 字符串里，单独校验字符串包含）
4. 挂进 `lint:all` 与 CI

> 这个检查保护的是「以后有人加了新颜色 token 忘配暗色」——本轮之后会反复发生的事。

## 5. 测试设计

| 层 | 用例 | 文件 |
| --- | --- | --- |
| 单元 | `isThemePreference` 合法/非法；preferences 读写往返；缺省回 system | `tests/unit/theme-preferences.test.mjs` |
| 静态 | §4 的三项断言 | `scripts/check-theme-tokens.mjs`（lint:all 收编） |
| GUI | ①设置切 dark → `data-theme=dark` 生效 + 首页截图像素断言**且与浅色截图可区分**（直方图距离阈值，防「切了个寂寞」）②会话视图、设置视图深色截图 ③重启后仍 dark（持久化）④切回 system 档 → `data-theme` 属性移除 ⑤titleBarOverlay symbolColor 变化（主进程侧断言） | `tests/e2e/gui-theme.mjs`（新） |
| 回归 | 全套 `test:gui:*` 跑一遍不倒退 | 本地 + CI |

**反向验证**：临时注释渲染层接线 effect → ①③必须变红（证明测试真的在测）。

## 6. 兼容与回滚

- 偏好文件无 `theme` 字段的存量用户：行为＝跟随系统（与现在纯浅色的差别：
  系统深色的用户会看到深色——**这是期望的行为变化**，CHANGELOG「变更」类写明）
  ——若要保守，缺省可先取 `light`（保持现状），v0.5 再切 system。
  **决策：缺省 `light`**（不改变任何现有用户的界面），设置项里三档并列，
  「跟随系统」作为显式选择。PR 里写明这个取舍。
- 回滚点：PR 单一，revert 即回浅色-only 行为；`preferences.json` 多出的字段无害。
