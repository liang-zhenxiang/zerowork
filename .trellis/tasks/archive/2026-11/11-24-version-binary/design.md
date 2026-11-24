# 设计：二进制版本（#480）

- 新常量 `VERSION_MAX_BINARY_BYTES = 20 MiB`（文本仍是 1 MiB）。
- `recordVersion` 接受 Buffer/Uint8Array 或 `{ content, binary }`？保持 API 兼容：新增
  `recordBinaryVersion({ path, bytes, ... })`，或让 `recordVersion` 识别 `content` 为 Buffer。
  推荐显式函数，避免把字符串/字节混在一个参数里。
- 存储：`<key>/<id>.bin` + meta `{ id, at, size, binary: true, sha256 }`；文本继续 `<id>.txt`。
- `readVersionContent` 增加 `readVersionBytes`；`readVersionFile` 返回 `binary` 标记。
- `restoreVersion` 按 meta.binary 选读：字节 → 临时文件 + rename（保留原 mode）；文本走现有路径。
- 审阅台（review.js）仍只读文本；二进制条目不进文本 diff（维持现状）。
- 上限：超过则 `skipped += 1`、`reason: "too-large"`；不写内容文件。
- 测试隔离临时目录；覆盖二进制/文本共存、坏 meta、上限、还原失败不破坏。
