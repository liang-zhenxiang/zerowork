/**
 * 会话置顶索引（`pins.json`）：把「常用会话要一直在手边」这件事落盘。
 *
 * ## 为什么是独立索引，而不是写进会话文件
 *
 * 会话文件是 pi 的资产：往里面写任何东西都要经过**活的** SessionManager
 * （同一文件出现两个活写者会互相覆盖 entries —— 见 session-host 里
 * renameSession 的注释）。置顶是一条**纯展示偏好**，为它去 open 会话文件、
 * 承担那种耦合不值得。
 *
 * 独立索引还有一个更好的失败形态：`pins.json` 坏了、被手改坏了、
 * 或被清掉了，最坏后果是**丢置顶**，会话本身一根汗毛都不会少。
 *
 * ## 与 archive.json 同形态（这是有意的）
 *
 * 两个索引都在配置目录里、都是 `路径 → 时间戳` 的 JSON 对象、
 * 都「文件不存在 / JSON 损坏 / 结构不符一律当空索引」、都走
 * `临时文件 + rename` 原子落盘。同一类东西用同一套写法，
 * 读代码的人不必学两遍。
 *
 * ## 不清理指向已消失会话的条目
 *
 * 会话文件可能只是**暂时**不可达（同步目录还在拉、外置盘没挂）——
 * 按「文件不存在就删置顶」清理，会把用户的选择在下次插上盘之前悄悄抹掉。
 * 索引的大小以「用户点过多少次置顶」为上限，不值得为它引入这种风险。
 *
 * 键是**绝对路径**：会话列表给的 path 已经是绝对路径，这里再 resolve 一次，
 * 好让 `C:\a\b.jsonl` 与 `C:/a/b.jsonl` 这类同义写法不会各占一条。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getPinsFile } from "./config-paths.js";

class SessionPinStore {
  constructor(filePath = getPinsFile()) {
    this.filePath = filePath;
  }
  filePath;
  index = /* @__PURE__ */ new Map();
  loaded = false;
  /** 加载。文件不存在 / JSON 损坏 / 结构不符一律当空索引（理由见文件头）。 */
  ensureLoaded() {
    if (this.loaded) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [path, at] of Object.entries(parsed)) {
          if (typeof at === "number" && Number.isFinite(at)) this.index.set(path, at);
        }
      }
    } catch {
      this.index = /* @__PURE__ */ new Map();
    }
    this.loaded = true;
  }
  /** 是否已置顶（未置顶 / 从未置顶过都是 false）。 */
  isPinned(path) {
    this.ensureLoaded();
    return this.index.has(path);
  }
  /** 置顶时刻；未置顶为 undefined（列表排序可用）。 */
  pinnedAt(path) {
    this.ensureLoaded();
    return this.index.get(path);
  }
  /** 置顶 / 取消置顶，随即原子落盘。幂等：状态不变时不落盘。 */
  setPinned(path, pinned, now) {
    this.ensureLoaded();
    if (pinned) {
      if (this.index.has(path)) return;
      this.index.set(path, now);
    } else {
      if (!this.index.delete(path)) return;
    }
    this.persist();
  }
  persist() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify(Object.fromEntries(this.index), null, 2)}
`,
      "utf8"
    );
    renameSync(tmp, this.filePath);
  }
}

export {
	SessionPinStore,
};
