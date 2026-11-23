/* #484 第三十轮：任务看板视图（独立文件——避免污染 app.js 的复杂嵌套 JSX，
   第三十轮 CI 六连红的教训：往深层嵌套的三元里插 IIFE 极易括号错配）。 */
import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { formatRelativeTime } from "./file-history-core.js";

const BOARD_COLUMNS = [
	{ key: "active", label: "进行中" },
	{ key: "archived", label: "已归档" }
];

/**
 * 任务看板。props：
 *   tasks      —— 侧栏的 visibleTasks（已过滤）
 *   archived   —— 已归档任务（列表）
 *   onOpen     —— 点击卡片打开会话
 *   onArchive  —— 归档任务（拖到已归档列）
 */
export function TaskBoardSection({ tasks, archived, onOpen, onArchive }) {
	const columns = [
		{ ...BOARD_COLUMNS[0], items: tasks },
		{ ...BOARD_COLUMNS[1], items: archived }
	];
	return _jsx("div", { className: "task-board", children: columns.map((col) => _jsxs("div", {
		className: "task-board-col",
		onDragOver: (e) => {
			if (col.key === "archived") e.preventDefault();
		},
		onDrop: (e) => {
			e.preventDefault();
			const path = e.dataTransfer.getData("text/task-path");
			if (col.key === "archived" && path !== "") onArchive(path);
		},
		children: [
			_jsxs("div", { className: "task-board-col-head", children: [
				col.label,
				_jsx("span", { className: "task-board-count", children: col.items.length })
			] }),
			_jsx("div", { className: "task-board-col-body", children: col.items.length === 0
				? _jsx("p", { className: "task-board-empty", children: col.key === "active" ? "新建一个任务开始" : "拖动任务到这里归档" })
				: col.items.map((t) => _jsxs("button", {
					type: "button",
					className: "task-board-card",
					draggable: true,
					onDragStart: (e) => e.dataTransfer.setData("text/task-path", t.path),
					onClick: () => onOpen(t),
					onKeyDown: (e) => {
						if (e.key === "Enter") onOpen(t);
					},
					children: [
						_jsx("span", { className: "task-board-card-title", children: t.title }),
						_jsx("span", { className: "task-board-card-meta", children: formatRelativeTime(t.modifiedAt, Date.now()) })
					]
				}, t.path)) })
		]
	}, col.key)) });
}
