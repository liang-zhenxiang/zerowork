/**
 * 项目索引（`projects.json`）：把「同一件正在推进的事」的会话装订成一本活页夹。
 *
 * ## 项目与工作空间是正交概念（这是有意的）
 *
 * 工作空间管**文件系统**（会话的 cwd 目录），项目管**工作本身**（哪些会话属于
 * 这件事、常驻要求是什么）。项目**不创建目录、不移动文件、不改会话的 cwd** ——
 * 它只是一层组织引用。因此删除项目只解除引用，会话与文件一根汗毛都不少
 * （确认弹窗要把这一点说清楚）。
 *
 * ## 为什么照 pin.js 的形态（文件头有同款论证）
 *
 * - **原子落盘**（临时文件 + rename）：断电 / 崩溃不会留下半截 JSON；
 * - **坏文件当空**：手改坏了最坏后果是丢项目的组织关系（会话都在），值得为
 *   更强的恢复语义引入复杂度；
 * - **结构校验拒收**：字段形态不对的条目直接跳过，不做「尽力解释」。
 *
 * 与 pins 的差异：这里存的是**结构化对象数组**而非 path→时间戳映射，所以校验
 * 逐字段做（`parseProject`），键统一在 store 内部 resolve（`C:\a.jsonl` 与
 * `C:/a.jsonl` 不会各占一条 —— 与 pin/archive 同键口径，见 session-files 的
 * 列表注释）。
 *
 * ## 会话引用不清理（与 pin.js 同理由）
 *
 * 会话文件可能只是**暂时**不可达（外置盘没挂、同步目录还在拉）。按「文件不在
 * 就删引用」清理，会把用户的组织选择在盘插回来之前悄悄抹掉。读不到的会话由
 * **视图层**标「不在磁盘上」，不在这里动数据。
 *
 * ## 一个会话同时只属于一个项目（MVP 的刻意取舍）
 *
 * 活页夹心智：一页只在一本里。`assignSession` 先从旧项目移除再加入新项目 ——
 * 从"换项目"菜单进来语义自然成立。多项目交叉留给后续版本，届时再议
 * `sessionPaths` 是否改多值。
 *
 * ## 常驻指令的注入不在这里发生
 *
 * 本模块只存取；注入走 prompt-compose 的追加段（design.md §3），那里按
 * `instructionsFor(sessionFilePath)` 反查 —— store 维护 path→项目 的内存索引，
 * O(1)，无项目的会话不进注入路径。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getProjectsFile } from "./config-paths.js";

/** 常驻指令的长度上限（字符数）。够写一段认真的工作要求，不够塞一篇文档。 */
export const PROJECT_INSTRUCTIONS_MAX = 2000;

/** 项目色只在 --cat-1..6 六档里轮转（渲染层纪律：不引入新颜色 token）。 */
export const PROJECT_COLOR_COUNT = 6;

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** 单个项目的逐字段校验：形态不对返回 undefined（跳过），不「尽力解释」。 */
function parseProject(raw, now = Date.now()) {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.id !== "string" || raw.id === "") return undefined;
  if (typeof raw.name !== "string" || raw.name.trim() === "") return undefined;
  const colorIndex = typeof raw.colorIndex === "number" && Number.isInteger(raw.colorIndex) && raw.colorIndex >= 0 && raw.colorIndex < PROJECT_COLOR_COUNT ? raw.colorIndex : 0;
  const instructions = typeof raw.instructions === "string" ? raw.instructions.slice(0, PROJECT_INSTRUCTIONS_MAX) : "";
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  const sessionPaths = Array.isArray(raw.sessionPaths)
    ? // 先 resolve 再去重：`/a/s.jsonl` 与 `/a/./s.jsonl` 去重时还是两个串，resolve 后才是同一个文件。
      [...new Set(raw.sessionPaths.filter((p) => typeof p === "string" && p !== "").map((p) => resolve(p)))]
    : [];
  return { id: raw.id, name: raw.name.trim(), colorIndex, instructions, createdAt, sessionPaths };
}

class ProjectsStore {
  constructor(filePath = getProjectsFile()) {
    this.filePath = filePath;
    /** @type {Map<string, object>} id → project */
    this.projects = new Map();
    /** @type {Map<string, string>} resolve 后会话路径 → 项目 id（反查索引） */
    this.sessionOwner = new Map();
    this.loaded = false;
  }

  /** 加载。文件不存在 / JSON 损坏 / 结构不符一律当空（理由见文件头）。 */
  ensureLoaded() {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      const list = isPlainObject(parsed) && Array.isArray(parsed.projects) ? parsed.projects : [];
      for (const raw of list) {
        const project = parseProject(raw);
        if (project === undefined || this.projects.has(project.id)) continue;
        this.projects.set(project.id, project);
      }
    } catch {
      this.projects = new Map();
    }
    this.rebuildSessionOwner();
    this.loaded = true;
  }

  rebuildSessionOwner() {
    this.sessionOwner = new Map();
    for (const project of this.projects.values()) {
      for (const path of project.sessionPaths) {
        // 文件被手改出「同会话在多个项目」时，以先注册的项目为准（加载顺序 = 文件顺序）。
        if (!this.sessionOwner.has(path)) this.sessionOwner.set(path, project.id);
      }
    }
  }

  persist() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, projects: [...this.projects.values()] }, null, 2)}\n`, "utf8");
    renameSync(tmp, this.filePath);
  }

  list() {
    this.ensureLoaded();
    return [...this.projects.values()].map((p) => ({ ...p, sessionPaths: [...p.sessionPaths] }));
  }

  get(id) {
    this.ensureLoaded();
    const project = this.projects.get(id);
    return project === undefined ? undefined : { ...project, sessionPaths: [...project.sessionPaths] };
  }

  /** 创建。名称去空白后必非空（空名 throw——调用方的表单也拦，这里是最后防线）。 */
  create(name, now = Date.now()) {
    this.ensureLoaded();
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (trimmed === "") throw new Error("项目名称不能为空");
    const project = {
      id: `p_${randomUUID()}`,
      name: trimmed,
      // 轮转分配：与现存数量同余。两个项目同色是允许的（六色六档，色只是提示不是身份）。
      colorIndex: this.projects.size % PROJECT_COLOR_COUNT,
      instructions: "",
      createdAt: now,
      sessionPaths: [],
    };
    this.projects.set(project.id, project);
    this.persist();
    return { ...project, sessionPaths: [] };
  }

  rename(id, name) {
    this.ensureLoaded();
    const project = this.projects.get(id);
    if (project === undefined) throw new Error("项目不存在");
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (trimmed === "") throw new Error("项目名称不能为空");
    if (project.name === trimmed) return this.get(id);
    project.name = trimmed;
    this.persist();
    return this.get(id);
  }

  setColor(id, colorIndex) {
    this.ensureLoaded();
    const project = this.projects.get(id);
    if (project === undefined) throw new Error("项目不存在");
    if (!Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex >= PROJECT_COLOR_COUNT) {
      throw new Error(`项目色只有 ${PROJECT_COLOR_COUNT} 档（0..${PROJECT_COLOR_COUNT - 1}）`);
    }
    if (project.colorIndex === colorIndex) return this.get(id);
    project.colorIndex = colorIndex;
    this.persist();
    return this.get(id);
  }

  /** 常驻指令。超限部分截断（表单也拦，这里是数据层的最后防线）。 */
  setInstructions(id, text) {
    this.ensureLoaded();
    const project = this.projects.get(id);
    if (project === undefined) throw new Error("项目不存在");
    const next = typeof text === "string" ? text.slice(0, PROJECT_INSTRUCTIONS_MAX) : "";
    if (project.instructions === next) return this.get(id);
    project.instructions = next;
    this.persist();
    return this.get(id);
  }

  /**
   * 删除项目。**只解除组织引用**：会话与文件都不动（见文件头）。
   * 返回被解除的会话路径（调用方据此触发列表刷新）。
   */
  delete(id) {
    this.ensureLoaded();
    const project = this.projects.get(id);
    if (project === undefined) throw new Error("项目不存在");
    this.projects.delete(id);
    for (const path of project.sessionPaths) this.sessionOwner.delete(path);
    this.persist();
    return [...project.sessionPaths];
  }

  /**
   * 会话归入 / 移出。projectId 为 null 表示移出（不在任何项目也幂等成功）。
   * 一个会话只属一个项目：先从旧项目移除（「换项目」的语义由这一步自然成立）。
   */
  assignSession(sessionPath, projectId) {
    this.ensureLoaded();
    const path = resolve(sessionPath);
    const target = projectId === null ? undefined : this.projects.get(projectId);
    if (projectId !== null && target === undefined) throw new Error("项目不存在");
    const previousOwnerId = this.sessionOwner.get(path);
    if (previousOwnerId === projectId) return; // 幂等：状态不变不落盘
    if (previousOwnerId !== undefined) {
      const previous = this.projects.get(previousOwnerId);
      if (previous !== undefined) previous.sessionPaths = previous.sessionPaths.filter((p) => p !== path);
      this.sessionOwner.delete(path);
    }
    if (target !== undefined) {
      target.sessionPaths.push(path);
      this.sessionOwner.set(path, target.id);
    }
    this.persist();
  }

  /** 会话所属项目 id；未归入为 undefined（渲染层据此缺省字段，不写 false）。 */
  projectIdFor(sessionPath) {
    this.ensureLoaded();
    return this.sessionOwner.get(resolve(sessionPath));
  }

  /** 常驻指令；未归入 / 项目无指令为 undefined（注入层的「零开销」分支）。 */
  instructionsFor(sessionPath) {
    this.ensureLoaded();
    const id = this.sessionOwner.get(resolve(sessionPath));
    if (id === undefined) return undefined;
    const project = this.projects.get(id);
    if (project === undefined || project.instructions === "") return undefined;
    return project.instructions;
  }
}

export { ProjectsStore };
