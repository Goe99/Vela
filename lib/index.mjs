import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
//#region src/domain/types.ts
/** 全部 Lane，按 Board 上从左到右的展示顺序。 */
const LANES = [
	"backlog",
	"todo",
	"running",
	"review",
	"done",
	"failed"
];
/** 全部优先级，按由低到高。 */
const PRIORITIES = [
	"none",
	"low",
	"medium",
	"high",
	"urgent"
];
/** 一个空 Board。 */
function emptyBoard() {
	return {
		version: 2,
		nextNumber: 1,
		issues: []
	};
}
//#endregion
//#region src/domain/lanes.ts
/** Operator 拖拽可达的迁移。 */
const OPERATOR_TRANSITIONS = {
	backlog: ["todo"],
	todo: ["backlog"],
	running: [],
	review: [
		"done",
		"todo",
		"backlog"
	],
	done: ["todo", "backlog"],
	failed: ["todo", "backlog"]
};
/** 系统事件可作用的源 Lane 与其目标。 */
const SYSTEM_TRANSITIONS = {
	"run-started": {
		from: [
			"backlog",
			"todo",
			"review",
			"done",
			"failed"
		],
		to: "running"
	},
	"run-succeeded": {
		from: ["running"],
		to: "review"
	},
	"run-failed": {
		from: ["running"],
		to: "failed"
	}
};
/** Operator 能否把一张卡片从 `from` 拖到 `to`。 */
function canOperatorMove(from, to) {
	if (from === to) return true;
	return OPERATOR_TRANSITIONS[from].includes(to);
}
/** 一个系统事件作用于 `from` 时的目标 Lane；不适用则 undefined。 */
function systemTarget(event, from) {
	const rule = SYSTEM_TRANSITIONS[event];
	return rule.from.includes(from) ? rule.to : void 0;
}
//#endregion
//#region src/domain/ordering.ts
/**
* 分数索引排序（ADR-0006 / 票 06）。同 Lane 内按 position 升序排列，
* 一次拖拽只改被拖动那一张卡片的 position——**不重排整列**，否则每次
* 拖动都要重写 Lane 内所有 Issue，快照抖动且并发写更难。
*
* 代价是浮点精度有限：反复往同一缝隙插入会让相邻 position 收敛到无法
* 再取中点。此时 `positionBetween` 返回 null，调用方必须重整该 Lane
* （`renumber`），这是刻意暴露给调用方的边界而不是静默降级。
*/
/** 相邻两个 position 之间可以再插入的最小间隔。 */
const MIN_GAP = 1e-9;
/** 新卡片落在一列末尾时的 position。空列从 1 开始。 */
function positionForEnd(positions) {
	if (positions.length === 0) return 1;
	return Math.max(...positions) + 1;
}
/**
* 求两个 position 之间的中点。
* @param before - 落点之前那张卡片的 position；落在列首时为 undefined。
* @param after - 落点之后那张卡片的 position；落在列尾时为 undefined。
* @returns 中点，或 null 表示精度已耗尽、调用方必须先重整该列。
*/
function positionBetween(before, after) {
	if (before === void 0 && after === void 0) return 1;
	if (before === void 0) return after - 1;
	if (after === void 0) return before + 1;
	if (after - before <= MIN_GAP) return null;
	const mid = (before + after) / 2;
	if (mid <= before || mid >= after) return null;
	return mid;
}
/**
* 把一列重新编号为 1..n，保持现有相对次序。仅在 `positionBetween`
* 返回 null 后调用。
* @param ids - 该列的 id，已按目标次序排列。
* @returns id 到新 position 的映射。
*/
function renumber(ids) {
	return new Map(ids.map((id, index) => [id, index + 1]));
}
/** 按 position 升序、同值时按 id 稳定排序。 */
function byPosition(a, b) {
	if (a.position !== b.position) return a.position - b.position;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
//#endregion
//#region src/domain/board.ts
function ok$1(value) {
	return {
		ok: true,
		value
	};
}
function fail$1(code, message) {
	return {
		ok: false,
		code,
		message
	};
}
function find(board, id) {
	return board.issues.find((issue) => issue.id === id);
}
/**
* `squad` 与 `agentPreset` 最终作用到同一个旋钮（ADR-0016），同时给两个
* 就没有一个诚实的优先规则可讲——与其默默挑一个，不如当场拒绝。
*/
function execConflict(exec) {
	if (exec === void 0) return void 0;
	if (exec.squad !== void 0 && exec.agentPreset !== void 0) return "exec.squad and exec.agentPreset are mutually exclusive";
}
function replace(board, next) {
	return {
		...board,
		issues: board.issues.map((issue) => issue.id === next.id ? next : issue)
	};
}
/** 某个 Lane 内的 Issue，按展示次序。 */
function laneIssues(board, lane) {
	return board.issues.filter((issue) => issue.lane === lane).sort(byPosition);
}
/** 一个 Issue 当前的活 Run（至多一个）。 */
function activeRun(issue) {
	return issue.runs.find((run) => run.status === "running");
}
/**
* 新建 Issue。落在 backlog 末尾（ADR-0012：新 Issue 只进 Backlog）。
* maxAttempts 默认 0——不自动重试是刻意的默认值（ADR-0010）。
*/
function createIssue(board, input, now, id) {
	const title = input.title.trim();
	if (title.length === 0) return fail$1("invalid", "title must not be empty");
	if (input.workspace.trim().length === 0) return fail$1("invalid", "workspace must not be empty");
	const maxAttempts = input.maxAttempts ?? 0;
	if (!Number.isInteger(maxAttempts) || maxAttempts < 0) return fail$1("invalid", "maxAttempts must be a non-negative integer");
	const conflict = execConflict(input.exec);
	if (conflict !== void 0) return fail$1("invalid", conflict);
	const issue = {
		id,
		number: board.nextNumber,
		title,
		description: input.description ?? "",
		workspace: input.workspace,
		lane: "backlog",
		priority: input.priority ?? "none",
		position: positionForEnd(laneIssues(board, "backlog").map((i) => i.position)),
		createdAt: now,
		updatedAt: now,
		maxAttempts,
		exec: input.exec ?? {},
		runs: []
	};
	return ok$1({
		board: {
			...board,
			nextNumber: board.nextNumber + 1,
			issues: [...board.issues, issue]
		},
		issue
	});
}
/** 修改 Issue 的内容。不改 lane 与 position——那走 moveIssue。 */
function updateIssue(board, id, input, now) {
	const issue = find(board, id);
	if (issue === void 0) return fail$1("not-found", `issue ${id} not found`);
	if (input.title !== void 0 && input.title.trim().length === 0) return fail$1("invalid", "title must not be empty");
	if (input.maxAttempts !== void 0 && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 0)) return fail$1("invalid", "maxAttempts must be a non-negative integer");
	const conflict = execConflict(input.exec);
	if (conflict !== void 0) return fail$1("invalid", conflict);
	return ok$1(replace(board, {
		...issue,
		...input.title === void 0 ? {} : { title: input.title.trim() },
		...input.description === void 0 ? {} : { description: input.description },
		...input.workspace === void 0 ? {} : { workspace: input.workspace },
		...input.priority === void 0 ? {} : { priority: input.priority },
		...input.maxAttempts === void 0 ? {} : { maxAttempts: input.maxAttempts },
		...input.exec === void 0 ? {} : { exec: input.exec },
		updatedAt: now
	}));
}
/**
* 删除 Issue。持有活 Run 时拒绝——先取消那次执行，否则会留下一个没有
* 卡片指向的运行中会话。已结束的 Run 记录随 Issue 一起消失；它们指向的
* DSH 会话**不受影响**，会话是 DSH 的资产不是 Vela 的。
*/
function deleteIssue(board, id) {
	const issue = find(board, id);
	if (issue === void 0) return fail$1("not-found", `issue ${id} not found`);
	if (activeRun(issue) !== void 0) return fail$1("conflict", `issue ${id} has a running Run; cancel it before deleting`);
	return ok$1({
		...board,
		issues: board.issues.filter((candidate) => candidate.id !== id)
	});
}
/**
* Operator 拖拽。非法迁移在此处被拒绝，调用方**不应**先接受再回滚。
* 精度耗尽时自动重整目标 Lane 后重试一次——重整对 Operator 不可见，
* 相对次序不变。
*/
function moveIssue(board, id, target, now) {
	const issue = find(board, id);
	if (issue === void 0) return fail$1("not-found", `issue ${id} not found`);
	if (!canOperatorMove(issue.lane, target.lane)) return fail$1("illegal-transition", `cannot move from ${issue.lane} to ${target.lane}`);
	const siblings = laneIssues(board, target.lane).filter((candidate) => candidate.id !== id);
	const before = target.beforeId === void 0 ? void 0 : siblings.find((candidate) => candidate.id === target.beforeId);
	const after = target.afterId === void 0 ? void 0 : siblings.find((candidate) => candidate.id === target.afterId);
	if (target.beforeId !== void 0 && before === void 0) return fail$1("not-found", `anchor ${target.beforeId} is not in lane ${target.lane}`);
	if (target.afterId !== void 0 && after === void 0) return fail$1("not-found", `anchor ${target.afterId} is not in lane ${target.lane}`);
	const settle = (working, siblingList) => {
		const beforePos = before === void 0 ? void 0 : siblingList.find((candidate) => candidate.id === before.id)?.position;
		const afterPos = after === void 0 ? void 0 : siblingList.find((candidate) => candidate.id === after.id)?.position;
		const position = before === void 0 && after === void 0 ? positionForEnd(siblingList.map((i) => i.position)) : positionBetween(beforePos, afterPos);
		if (position === null) return fail$1("conflict", "position precision exhausted");
		return ok$1(replace(working, {
			...issue,
			lane: target.lane,
			position,
			updatedAt: now
		}));
	};
	const first = settle(board, siblings);
	if (first.ok) return first;
	const order = renumber(siblings.map((candidate) => candidate.id));
	const compacted = {
		...board,
		issues: board.issues.map((candidate) => {
			const position = order.get(candidate.id);
			return position === void 0 ? candidate : {
				...candidate,
				position,
				updatedAt: now
			};
		})
	};
	return settle(compacted, laneIssues(compacted, target.lane).filter((candidate) => candidate.id !== id));
}
/**
* 派活：为 Issue 起一个 Run，Issue 自动进 running（系统驱动，Operator
* 无法手动拖进来）。已有活 Run 时拒绝——一个 Issue 同时只能有一个。
*/
function startRun(board, id, run, now) {
	const issue = find(board, id);
	if (issue === void 0) return fail$1("not-found", `issue ${id} not found`);
	if (activeRun(issue) !== void 0) return fail$1("conflict", `issue ${id} already has a running Run`);
	const lane = systemTarget("run-started", issue.lane);
	if (lane === void 0) return fail$1("illegal-transition", `cannot start a Run while in ${issue.lane}`);
	const started = {
		id: run.id,
		sessionId: run.sessionId,
		startedAt: now,
		status: "running"
	};
	return ok$1(replace(board, {
		...issue,
		lane,
		position: positionForEnd(laneIssues(board, lane).map((i) => i.position)),
		runs: [...issue.runs, started],
		updatedAt: now
	}));
}
/**
* Run 结束。成功进 review（**不是** done——ADR-0007 的核心不变量），
* 其余进 failed。用量在此刻一次性写入 Run 且此后不可变（ADR-0011）；
* 缺失表示未知，不要伪造成 0。
*/
function settleRun(board, id, settle, now) {
	const issue = find(board, id);
	if (issue === void 0) return fail$1("not-found", `issue ${id} not found`);
	const run = issue.runs.find((candidate) => candidate.id === settle.runId);
	if (run === void 0) return fail$1("not-found", `run ${settle.runId} not found on issue ${id}`);
	if (run.status === "settled") return fail$1("conflict", `run ${settle.runId} is already settled`);
	const lane = systemTarget(settle.outcome === "completed" ? "run-succeeded" : "run-failed", issue.lane);
	if (lane === void 0) return fail$1("illegal-transition", `cannot settle a Run while in ${issue.lane}`);
	const settled = {
		...run,
		status: "settled",
		endedAt: now,
		outcome: settle.outcome,
		...settle.failure === void 0 ? {} : { failure: settle.failure },
		...settle.usage === void 0 ? {} : { usage: settle.usage }
	};
	return ok$1(replace(board, {
		...issue,
		lane,
		position: positionForEnd(laneIssues(board, lane).map((i) => i.position)),
		runs: issue.runs.map((candidate) => candidate.id === run.id ? settled : candidate),
		updatedAt: now
	}));
}
/**
* Gate：Operator 对一次产出的判定。这是通往终态的唯一入口——Run 结果
* 自己到不了 done（ADR-0007）。
*/
function gate(board, id, verdict, now) {
	const issue = find(board, id);
	if (issue === void 0) return fail$1("not-found", `issue ${id} not found`);
	if (issue.lane !== "review") return fail$1("illegal-transition", `issue ${id} is not awaiting review`);
	return moveIssue(board, id, { lane: verdict === "accept" ? "done" : "todo" }, now);
}
/** 该 Issue 失败后是否还应自动重试（ADR-0010：默认 maxAttempts 0）。 */
function shouldAutoRetry(issue) {
	return issue.lane === "failed" && issue.runs.length <= issue.maxAttempts;
}
//#endregion
//#region src/domain/exec.ts
/**
* 解析一次执行的配置。
* @param overrides - Issue 上的覆盖值。
* @param defaults - 插件配置里的全局默认。
* @returns 已解析的配置，可直接交给执行器。
*/
function resolveExec(overrides, defaults) {
	const agentPreset = overrides.agentPreset ?? defaults.agentPreset;
	const sandbox = overrides.sandbox ?? defaults.sandbox;
	const raw = overrides.timeoutMs ?? defaults.timeoutMs ?? 0;
	const timeoutMs = Number.isFinite(raw) && raw > 0 ? raw : 0;
	return {
		...agentPreset === void 0 ? {} : { agentPreset },
		...sandbox === void 0 ? {} : { sandbox },
		timeoutMs
	};
}
/**
* 校验一份覆盖值。返回一条错误说明，或 undefined 表示合法。
*
* sandbox 只能是宿主实际提供的 preset 名字之一。这条校验必须在**派活前**
* 做掉：一个拼错的档位名会让 `permissionPresets.set` 抛错，那时会话已经
* 建好、Agent 已经空转，收拾起来比拒绝一次配置贵得多。
*/
function validateOverrides(overrides, availableSandboxes) {
	if (overrides.sandbox !== void 0) {
		if (availableSandboxes.length === 0) return "this deployment provides no permission presets, so sandbox cannot be set";
		if (!availableSandboxes.includes(overrides.sandbox)) return `unknown sandbox preset "${overrides.sandbox}"; available: ${availableSandboxes.join(", ")}`;
	}
	if (overrides.timeoutMs !== void 0) {
		if (!Number.isFinite(overrides.timeoutMs) || overrides.timeoutMs < 0) return "timeoutMs must be a non-negative finite number";
	}
	if (overrides.agentPreset !== void 0 && overrides.agentPreset.trim().length === 0) return "agentPreset must not be blank";
}
//#endregion
//#region src/domain/nav.ts
/** 全部可打开的配置文件。 */
const DOCUMENT_TARGETS = ["settings", "agent-presets"];
//#endregion
//#region src/domain/okf-frontmatter.ts
/** 头部读不懂。`line` 是 1 起的行号（相对整份文档）。 */
var OkfParseError = class extends Error {
	line;
	key;
	constructor(message, line, key) {
		super(`第 ${line} 行${key === void 0 ? "" : `（${key}）`}：${message}`);
		this.line = line;
		this.key = key;
		this.name = "OkfParseError";
	}
};
/** 头部与正文的分界。 */
const FENCE$1 = "---";
/** 已知键的展示顺序。不在表里的键按原顺序排在后面。 */
const KEY_ORDER = [
	"type",
	"title",
	"description",
	"okf_version",
	"status",
	"tags",
	"resource",
	"generated",
	"verified",
	"sources",
	"stale_after"
];
/**
* 把一段文本解析成头部 + 正文。
*
* 没有头部、或头部没闭合，都是错误而不是「当成没有头部」——OKF 的合规
* 底线就是「有 frontmatter 且 `type` 非空」，一篇没有头部的文件不是一份
* 概念文档，把它当空头部处理会让上层以为读到了一篇没有类型的概念。
*
* @param text - 整份文档。
*/
function parseDocument(text) {
	const lines = text.split("\n");
	let at = 0;
	while (at < lines.length && lines[at].replace(/^\uFEFF/, "").trim().length === 0) at += 1;
	if (at >= lines.length || lines[at].replace(/^\uFEFF/, "").trim() !== FENCE$1) throw new OkfParseError(`文档要以 ${FENCE$1} 开头的头部起始`, at + 1);
	const start = at + 1;
	let end = -1;
	for (let scan = start; scan < lines.length; scan += 1) if (lines[scan].trim() === FENCE$1) {
		end = scan;
		break;
	}
	if (end === -1) throw new OkfParseError(`头部没有闭合的 ${FENCE$1}`, start + 1);
	return {
		frontmatter: parseFrontmatter(lines.slice(start, end), start + 1),
		body: lines.slice(end + 1).join("\n").replace(/^\n+/, "").replace(/\s+$/, "")
	};
}
/**
* 解析头部的若干行。
* @param lines - 两道 `---` 之间的行。
* @param firstLine - 这批行里第一行在整份文档里的行号（1 起），报错要用。
*/
function parseFrontmatter(lines, firstLine = 1) {
	const entries = /* @__PURE__ */ new Map();
	let index = 0;
	while (index < lines.length) {
		const raw = lines[index];
		const lineNumber = firstLine + index;
		if (raw.trim().length === 0 || raw.trimStart().startsWith("#")) {
			index += 1;
			continue;
		}
		if (raw.startsWith(" ") || raw.startsWith("	")) throw new OkfParseError("意外的缩进——这一行不挂在任何键下面", lineNumber);
		const colon = raw.indexOf(":");
		if (colon === -1) throw new OkfParseError("少了 `键: 值` 里的冒号", lineNumber);
		const key = raw.slice(0, colon).trim();
		if (key.length === 0) throw new OkfParseError("键名为空", lineNumber);
		if (entries.has(key)) throw new OkfParseError("这个键出现了两次", lineNumber, key);
		const inline = raw.slice(colon + 1).trim();
		if (inline.length > 0) {
			entries.set(key, inline.startsWith("[") ? parseFlowSequence(inline, lineNumber, key) : parseScalar(inline, lineNumber, key));
			index += 1;
			continue;
		}
		const block = [];
		index += 1;
		while (index < lines.length) {
			const next = lines[index];
			if (next.trim().length === 0) {
				index += 1;
				continue;
			}
			if (!next.startsWith(" ") && !next.startsWith("	")) break;
			block.push({
				text: next,
				line: firstLine + index
			});
			index += 1;
		}
		if (block.length === 0) {
			entries.set(key, "");
			continue;
		}
		entries.set(key, parseBlock(block, key));
	}
	return entries;
}
/** 缩进块：`- ` 开头是数组，否则是一层对象。 */
function parseBlock(block, key) {
	const first = block[0];
	if (!first.text.trimStart().startsWith("- ")) {
		const record = {};
		for (const { text, line } of block) {
			const [name, value] = splitPair(text, line, key);
			if (value.length === 0) throw new OkfParseError("嵌套只支持一层，这里的值不能再展开", line, `${key}.${name}`);
			record[name] = parseScalar(value, line, `${key}.${name}`);
		}
		return record;
	}
	const scalars = [];
	const records = [];
	let current;
	for (const { text, line } of block) {
		const trimmed = text.trimStart();
		if (trimmed.startsWith("- ")) {
			const item = trimmed.slice(2).trim();
			if (looksLikePair(item)) {
				const [name, value] = splitPair(item, line, key);
				current = { [name]: parseScalar(value, line, `${key}[].${name}`) };
				records.push(current);
			} else {
				current = void 0;
				scalars.push(parseScalar(item, line, `${key}[]`));
			}
			continue;
		}
		if (current === void 0) throw new OkfParseError("这一行不属于任何数组项", line, key);
		const [name, value] = splitPair(trimmed, line, key);
		current[name] = parseScalar(value, line, `${key}[].${name}`);
	}
	if (scalars.length > 0 && records.length > 0) throw new OkfParseError("数组里混了标量项与对象项", first.line, key);
	return records.length > 0 ? records : scalars;
}
/** `a: b` 形状的判定。冒号后必须跟空白或到行尾，否则 `http://x` 会被当成键。 */
function looksLikePair(text) {
	return /^[^:\s][^:]*:(\s|$)/.test(text);
}
function splitPair(text, line, key) {
	const trimmed = text.trim();
	const colon = trimmed.indexOf(":");
	if (colon === -1) throw new OkfParseError("少了 `键: 值` 里的冒号", line, key);
	const name = trimmed.slice(0, colon).trim();
	if (name.length === 0) throw new OkfParseError("键名为空", line, key);
	return [name, trimmed.slice(colon + 1).trim()];
}
/** `[a, b, c]` 这种行内数组。 */
function parseFlowSequence(text, line, key) {
	if (!text.endsWith("]")) throw new OkfParseError("行内数组没有闭合的 `]`", line, key);
	const inner = text.slice(1, -1).trim();
	if (inner.length === 0) return [];
	return splitFlowItems(inner, line, key).map((item) => parseScalar(item, line, `${key}[]`));
}
/** 按逗号切开行内数组，但不切引号里的逗号。 */
function splitFlowItems(inner, line, key) {
	const items = [];
	let current = "";
	let quote;
	for (const char of inner) {
		if (quote !== void 0) {
			current += char;
			if (char === quote) quote = void 0;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === ",") {
			items.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (quote !== void 0) throw new OkfParseError("行内数组里的引号没有闭合", line, key);
	items.push(current.trim());
	return items.filter((item) => item.length > 0);
}
/**
* 一个标量。
*
* 只在**没有引号**且整体形如数字时才读成数字：`usage_count: 3` 是计数，
* 而 `title: "3"` 必须留成字符串，否则往返会把它变成数字。
*/
function parseScalar(text, line, key) {
	if (text.length === 0) return "";
	const quote = text[0];
	if (quote === "\"" || quote === "'") {
		if (text.length < 2 || !text.endsWith(quote)) throw new OkfParseError("引号没有闭合", line, key);
		const inner = text.slice(1, -1);
		return quote === "\"" ? inner.replace(/\\"/g, "\"").replace(/\\n/g, "\n").replace(/\\\\/g, "\\") : inner;
	}
	if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
	return text;
}
/** 序列化一份文档：头部 + 空行 + 正文，末尾一个换行。 */
function serializeDocument(document) {
	const body = document.body.replace(/\s+$/, "");
	const head = serializeFrontmatter(document.frontmatter);
	return body.length === 0 ? head : `${head}\n${body}\n`;
}
/** 序列化头部，含两道 `---`。已知键在前，未知键按原顺序在后。 */
function serializeFrontmatter(frontmatter) {
	const keys = [...frontmatter.keys()];
	const known = KEY_ORDER.filter((key) => frontmatter.has(key));
	const rest = keys.filter((key) => !known.includes(key));
	const lines = [FENCE$1];
	for (const key of [...known, ...rest]) lines.push(...serializeEntry(key, frontmatter.get(key)));
	lines.push(FENCE$1);
	return `${lines.join("\n")}\n`;
}
function serializeEntry(key, value) {
	if (Array.isArray(value)) {
		const items = value;
		if (items.length === 0) return [`${key}: []`];
		if (items.every((item) => typeof item !== "object")) return [`${key}: [${items.map(formatScalar).join(", ")}]`];
		const lines = [`${key}:`];
		for (const item of items) {
			const pairs = Object.entries(item);
			if (pairs.length === 0) continue;
			lines.push(`  - ${pairs[0][0]}: ${formatScalar(pairs[0][1])}`);
			for (const [name, inner] of pairs.slice(1)) lines.push(`    ${name}: ${formatScalar(inner)}`);
		}
		return lines;
	}
	if (typeof value === "object") {
		const pairs = Object.entries(value);
		if (pairs.length === 0) return [`${key}: {}`];
		return [`${key}:`, ...pairs.map(([name, inner]) => `  ${name}: ${formatScalar(inner)}`)];
	}
	return [`${key}: ${formatScalar(value)}`];
}
/**
* 一个标量的字面量。
*
* 要加引号的三种情况：空串、形如数字的字符串（否则读回来变数字）、以及
* 会破坏这个子集语法的字符（冒号后跟空白、行首的列表标记、井号、引号、
* 换行、首尾空白）。其余原样写出，让文件保持好读。
*/
function formatScalar(value) {
	if (typeof value === "number") return String(value);
	if (!(value.length === 0 || /^-?\d+(?:\.\d+)?$/.test(value) || /: |:$|^[-?*&!|>%@`#[{]|["'\n]|^\s|\s$/.test(value))) return value;
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"`;
}
/** 读一个键的字符串值；不存在或不是字符串时给 undefined。 */
function readString(frontmatter, key) {
	const value = frontmatter.get(key);
	return typeof value === "string" ? value : void 0;
}
/** 读一个键的字符串数组；缺失时给空数组。数字项按字符串给出。 */
function readList(frontmatter, key) {
	const value = frontmatter.get(key);
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item !== "object").map((item) => String(item));
}
/** 读一个键的对象数组；缺失时给空数组。 */
function readRecords(frontmatter, key) {
	const value = frontmatter.get(key);
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "object" && item !== null);
}
/**
* 读一个键的单个对象；不是对象时给 undefined。
*
* 用一个类型谓词而不是直接 `Array.isArray`：后者把参数收窄成 `any[]`，
* 对 `readonly` 数组的否定分支不会被排除。
*/
function readRecord(frontmatter, key) {
	const value = frontmatter.get(key);
	if (typeof value !== "object" || value === null) return void 0;
	if (isArray(value)) return void 0;
	return value;
}
function isArray(value) {
	return Array.isArray(value);
}
//#endregion
//#region src/domain/okf-recap.ts
/** 本轮唯一的概念类型。 */
const RECAP_TYPE = "Run Summary";
/** Vela 作为生成者的 actor 名前缀（OKF 约定 `<producer>/<version>`）。 */
const VELA_ACTOR_PREFIX = "vela/";
/** 人类 actor 的前缀（OKF 约定 `human:<id>`）。 */
const HUMAN_ACTOR_PREFIX = "human:";
/** 唯一的那个人（ADR-0001：Vela 里只有一个 Operator）。 */
const OPERATOR_ACTOR = `${HUMAN_ACTOR_PREFIX}operator`;
/** 全部生命周期状态。 */
const RECAP_STATUSES = [
	"draft",
	"stable",
	"deprecated"
];
/** 判断一个 actor 是不是人。 */
function isHumanActor(actor) {
	return actor.startsWith(HUMAN_ACTOR_PREFIX);
}
/**
* 从溯源字段推导信任等级。
*
* 人审过就是 human-reviewed，哪怕同时有机器确认——人的判断是更强的信号，
* 不是被机器的那条冲淡。
*/
function trustLevelOf(verified) {
	let machine = false;
	for (const entry of verified) {
		const by = entry.by;
		if (typeof by !== "string" || by.length === 0) continue;
		if (isHumanActor(by)) return "human-reviewed";
		machine = true;
	}
	return machine ? "machine-confirmed" : "unverified";
}
/** 一个 `YYYY-MM-DD`（UTC）。OKF 要求绝对日期，不存相对期限。 */
function toDateStamp(at) {
	return new Date(at).toISOString().slice(0, 10);
}
/** 落盘时该写的 `stale_after`。 */
function staleAfterFor(at) {
	return toDateStamp(at + 7776e6);
}
/**
* 到 `now` 这一刻算不算陈旧。
*
* `stale_after` 读作「这一天之后陈旧」，因此**到期当天还不陈旧**——一份写着
* 今天的知识今天仍然作数，边界含在有效期内。日期读不出来时按不陈旧处理：
* 缺一个可选字段不该让一篇知识失效（OKF 要求消费者容忍缺失字段）。
*/
function isStale(staleAfter, now) {
	if (staleAfter === void 0 || !/^\d{4}-\d{2}-\d{2}$/.test(staleAfter)) return false;
	return toDateStamp(now) > staleAfter;
}
/**
* 一个 Workspace 绝对路径对应的目录名。
*
* 取目录名加上整条路径的短哈希：只用目录名会让两个都叫 `web` 的仓库撞进
* 同一个目录，只用哈希则人看不出这堆记忆属于哪个项目。
*/
function workspaceSlug(workspace) {
	const normalized = workspace.replace(/[\\/]+$/, "");
	const cleaned = (normalized.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return `${cleaned.length === 0 ? "workspace" : cleaned}-${shortHash(normalized)}`;
}
/**
* 路径的 8 位十六进制指纹（FNV-1a）。
*
* 自己算而不是用 `node:crypto`：这一层要能在任何环境下跑，而这里要的只是
* 「同一条路径每次得到同一个短名字」，不是抗碰撞。
*/
function shortHash(text) {
	let hash = 2166136261;
	for (let at = 0; at < text.length; at += 1) {
		hash ^= text.charCodeAt(at);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
/** 一篇 Recap 在知识包里的相对路径。 */
function recapRelativePath(facts) {
	return `runs/${workspaceSlug(facts.workspace)}/${facts.issueNumber}-r${facts.runSeq}.md`;
}
/** 正文四段的固定小标题。前三段来自 Agent，末段来自 Vela。 */
const SECTION_CONCLUSION = "## 结论";
const SECTION_DID = "## 做了什么";
const SECTION_PITFALLS = "## 坑与注意";
const SECTION_FACTS = "## 客观足迹";
/** 收尾块的围栏语言标记。 */
const DELIVERY_FENCE = "vela-recap";
/** Agent 没交付收尾块时正文里的说明。不伪造内容（ADR-0021）。 */
const NO_DELIVERY_NOTE = "（这次没有交付收尾块）";
/** 非成功收尾时正文里的说明。 */
function noDeliveryNoteFor(outcome) {
	switch (outcome) {
		case "timeout": return "（这次执行超时被中断，没有收尾交付）";
		case "aborted": return "（这次执行被取消，没有收尾交付）";
		case "interrupted": return "（上一次进程结束时这次执行仍在进行，结果未知）";
		case "error": return "（这次执行报错结束，没有收尾交付）";
		case "blocked": return "（这次执行被挡住，没有收尾交付）";
		case "max-tokens": return "（这次执行撞到 token 上限，没有收尾交付）";
		default: return NO_DELIVERY_NOTE;
	}
}
/**
* 从 Agent 最后一条回复的正文里切出收尾块。
*
* 认围栏而不认裸小标题：围栏是会话文本里稳定可识别的边界（`extract.ts` 的
* 同一个理由），而且围栏里的字不会被 Operator 误读成对他说的话。有多个时
* 取**最后一个**——模型常先举例说明格式，真正的交付在最后。
*
* @param text - assistant 消息里拼起来的文本。
* @returns 三段内容；没有围栏块或块里一段都没有时 undefined。
*/
function extractDelivery(text) {
	const fence = new RegExp(`^[ \\t]*(?:\`{3,}|~{3,})${DELIVERY_FENCE}[ \\t]*$`, "m");
	let rest = text;
	let block;
	for (;;) {
		const opened = fence.exec(rest);
		if (opened === null) break;
		const after = rest.slice(opened.index + opened[0].length);
		const closed = /^[ \t]*(?:`{3,}|~{3,})[ \t]*$/m.exec(after);
		block = closed === null ? after : after.slice(0, closed.index);
		rest = closed === null ? "" : after.slice(closed.index + closed[0].length);
		if (rest.length === 0) break;
	}
	if (block === void 0) return void 0;
	const conclusion = sectionOf(block, SECTION_CONCLUSION);
	const did = sectionOf(block, SECTION_DID);
	const pitfalls = sectionOf(block, SECTION_PITFALLS);
	if (conclusion.length === 0 && did.length === 0 && pitfalls.length === 0) return void 0;
	return {
		conclusion,
		did,
		pitfalls
	};
}
/** 取一段 Markdown 里某个二级标题下的内容，到下一个二级标题为止。 */
function sectionOf(text, heading) {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line.trim() === heading);
	if (start === -1) return "";
	const collected = [];
	for (let at = start + 1; at < lines.length; at += 1) {
		if (/^##\s/.test(lines[at].trim())) break;
		collected.push(lines[at]);
	}
	return collected.join("\n").trim();
}
/**
* 组装一篇 Recap 的完整文本。
*
* `status` 一律 `draft`：一篇刚落盘的记忆没有经过任何人，这是它唯一诚实的
* 状态。升级只能由 Gate 做（ADR-0025）。
*/
function buildRecap(input) {
	const { facts, delivery, at, velaVersion } = input;
	const actor = `${VELA_ACTOR_PREFIX}${velaVersion}`;
	const iso = new Date(at).toISOString();
	return serializeDocument({
		frontmatter: /* @__PURE__ */ new Map([
			["type", RECAP_TYPE],
			["title", facts.title],
			["description", describeOutcome(facts)],
			["status", "draft"],
			["tags", [
				`workspace:${workspaceSlug(facts.workspace)}`,
				`issue:${facts.issueNumber}`,
				`outcome:${facts.outcome}`
			]],
			["generated", {
				by: actor,
				at: iso
			}],
			["stale_after", staleAfterFor(at)],
			["sources", [{
				author: actor,
				usage_count: 0,
				last_modified: iso
			}]],
			["vela_run", velaRunRecord(facts)]
		]),
		body: buildBody(facts, delivery)
	});
}
/** 一句话结果，进 `description`。 */
function describeOutcome(facts) {
	if (facts.outcome === "completed") return `第 ${facts.runSeq} 次执行完成`;
	const reason = facts.failure === void 0 ? "" : `：${facts.failure}`;
	return `第 ${facts.runSeq} 次执行未完成（${facts.outcome}）${reason}`;
}
/**
* 机器要读的那些事实收在一个键下。
*
* 扁平的标量而非嵌套结构：头部解析只认一层深（ADR-0023），而这些数字的
* 唯一用途是被脚本汇总（票 08），扁平反而更好 grep。逐个文件的明细进正文
* ——那是给人看的。
*/
function velaRunRecord(facts) {
	const record = {
		issue: facts.issueNumber,
		run_seq: facts.runSeq,
		session_id: facts.sessionId,
		workspace: facts.workspace,
		outcome: facts.outcome,
		duration_ms: Math.max(0, facts.endedAt - facts.startedAt),
		repeated_reads: repeatedReadsOf(facts.files),
		files_touched: facts.files.length,
		commands_run: facts.commands.length
	};
	if (facts.usage !== void 0) {
		record.input_tokens = facts.usage.inputTokens;
		record.output_tokens = facts.usage.outputTokens;
		record.cache_read_tokens = facts.usage.cacheReadTokens;
	}
	if (facts.recall !== void 0) {
		record.recall_indexed = facts.recall.indexed;
		record.recall_expanded = facts.recall.expanded;
		record.injected_chars = facts.recall.injectedChars;
		record.recalled_chars = facts.recall.sourceChars;
	}
	return record;
}
/**
* 重复读文件次数：同一条路径第 2 次起算。
*
* 口径写在这里而不是散在调用点：它是要写进简历的数字，只能有一个定义。
*/
function repeatedReadsOf(files) {
	return files.reduce((total, file) => total + Math.max(0, file.reads - 1), 0);
}
/** 正文四段。 */
function buildBody(facts, delivery) {
	const fallback = delivery === void 0 ? noDeliveryNoteFor(facts.outcome) : "";
	return [
		`${SECTION_CONCLUSION}\n\n${delivery?.conclusion || fallback || "（这次没有交付收尾块）"}`,
		`${SECTION_DID}\n\n${delivery?.did || fallback || "（这次没有交付收尾块）"}`,
		`${SECTION_PITFALLS}\n\n${delivery?.pitfalls || fallback || "（这次没有交付收尾块）"}`,
		`${SECTION_FACTS}\n\n${buildFactsSection(facts)}`
	].join("\n\n");
}
/** 客观足迹那一段。这一段的每一个字都来自 Vela 自己数的，不来自模型。 */
function buildFactsSection(facts) {
	const lines = [
		`- 结果：${facts.outcome}${facts.failure === void 0 ? "" : `（${facts.failure}）`}`,
		`- 耗时：${formatDuration(Math.max(0, facts.endedAt - facts.startedAt))}`,
		`- 用量：${formatUsage(facts.usage)}`,
		`- 会话：${facts.sessionId}`
	];
	const repeated = repeatedReadsOf(facts.files);
	lines.push(`- 重复读文件：${repeated} 次`);
	if (facts.recall !== void 0) lines.push(`- 这次注入：索引 ${facts.recall.indexed} 篇、展开 ${facts.recall.expanded} 篇、${facts.recall.injectedChars} 字（原文 ${facts.recall.sourceChars} 字）`);
	if (facts.files.length > 0) {
		lines.push("- 碰过的文件：");
		for (const file of facts.files) lines.push(`  - \`${file.path}\` 读 ${file.reads} 次、写 ${file.writes} 次`);
	}
	if (facts.commands.length > 0) {
		lines.push(`- 跑过的命令（${facts.commands.length} 条）：`);
		for (const command of facts.commands) lines.push(`  - \`${command}\``);
	}
	return lines.join("\n");
}
/** 人读的耗时。 */
function formatDuration(ms) {
	const seconds = Math.round(ms / 1e3);
	if (seconds < 60) return `${seconds} 秒`;
	return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
/** 人读的用量。缺失显示为未知，不显示 0。 */
function formatUsage(usage) {
	if (usage === void 0) return "未知";
	return `输入 ${usage.inputTokens}（缓存读 ${usage.cacheReadTokens}）/ 输出 ${usage.outputTokens}`;
}
/**
* 读一篇 Recap。
*
* 解析失败时抛 `OkfParseError`——上层要把它显示成「这篇读不了」，而不是让
* 这篇从列表里消失（ADR-0023）。
*/
function readRecap(text) {
	const { frontmatter, body } = parseDocument(text);
	const verified = readRecords(frontmatter, "verified");
	const sources = readRecords(frontmatter, "sources");
	const rawStatus = readString(frontmatter, "status");
	const status = RECAP_STATUSES.includes(rawStatus ?? "") ? rawStatus : "draft";
	const lastVerified = [...verified].reverse().find((entry) => typeof entry.by === "string" && isHumanActor(entry.by));
	const usageCount = sources.reduce((max, source) => {
		const count = source.usage_count;
		return typeof count === "number" && count > max ? count : max;
	}, 0);
	const staleAfter = readString(frontmatter, "stale_after");
	const generatedAt = readRecord(frontmatter, "generated")?.at;
	const runRecord = readRecord(frontmatter, "vela_run");
	const workspace = runRecord?.workspace;
	const issueNumber = runRecord?.issue;
	return {
		frontmatter,
		body,
		type: readString(frontmatter, "type") ?? "",
		title: readString(frontmatter, "title") ?? "",
		status,
		trust: trustLevelOf(verified),
		tags: readList(frontmatter, "tags"),
		...staleAfter === void 0 ? {} : { staleAfter },
		...typeof generatedAt === "string" ? { generatedAt } : {},
		...typeof lastVerified?.at === "string" ? { verifiedAt: lastVerified.at } : {},
		usageCount,
		...typeof workspace === "string" ? { workspace } : {},
		...typeof issueNumber === "number" ? { issueNumber } : {}
	};
}
/**
* 往一篇 Recap 里回写人审记录，并把生命周期升为 `stable`。
*
* **幂等**：同一个 actor 已经在里面时不再追一条。因为对账会重复调它
* （ADR-0025：看板是真相，文件可补齐），不幂等就会让一篇被反复对账的
* 文档长出一堆一模一样的审核行。
*
* @param text - 现有文件内容。
* @param actor - 审的人，比如 `human:operator`。
* @param at - 审的时刻。
*/
function markVerified(text, actor, at) {
	const { frontmatter, body } = parseDocument(text);
	const verified = [...readRecords(frontmatter, "verified")];
	const next = new Map(frontmatter);
	if (!verified.some((entry) => entry.by === actor)) {
		verified.push({
			by: actor,
			at: new Date(at).toISOString()
		});
		next.set("verified", verified);
	}
	next.set("status", "stable");
	return serializeDocument({
		frontmatter: next,
		body
	});
}
/**
* 把一篇 Recap 标成废弃。
*
* 不删文件：被退回的那篇是反面证据，它记着「这条路试过、不通」
* （ADR-0025）。废弃只影响能不能被召回，不影响能不能被人翻到。
*/
function markDeprecated(text) {
	const { frontmatter, body } = parseDocument(text);
	const next = new Map(frontmatter);
	next.set("status", "deprecated");
	return serializeDocument({
		frontmatter: next,
		body
	});
}
/**
* 召回展开了一遍，把引用计数加上。
*
* 只在正文真的被展开时调，进索引不算（spec 的取舍：进索引只是候选，
* 不代表被用到）。没有 `sources` 时补一条：计数要有地方落。
*/
function bumpUsageCount(text, at) {
	const { frontmatter, body } = parseDocument(text);
	const sources = readRecords(frontmatter, "sources");
	const iso = new Date(at).toISOString();
	const next = new Map(frontmatter);
	if (sources.length === 0) next.set("sources", [{
		author: "unknown",
		usage_count: 1,
		last_modified: iso
	}]);
	else next.set("sources", sources.map((source, index) => index === 0 ? {
		...source,
		usage_count: (typeof source.usage_count === "number" ? source.usage_count : 0) + 1,
		last_modified: iso
	} : source));
	return serializeDocument({
		frontmatter: next,
		body
	});
}
//#endregion
//#region src/domain/squad.ts
/** 全部可选后端。 */
const MEMBER_BACKENDS = ["spawn", "fork"];
/** 全部能力组，按展示顺序。 */
const ABILITIES = [
	"read",
	"edit",
	"shell",
	"web",
	"delegate"
];
/**
* 能力组 → 真实的模型可见工具名。
*
* 这张表**必须准确，而且准确的判据是「基准 preset 实际注册了什么」**，不是
* 「dsh 源码里存在什么」。白名单里出现一个基准没注册的名字，会让委派在
* `tools.restrict()` 上 fail loud——症状是每次派活都失败，而卡片看起来还是
* 跑完了（ADR-0017）。
*
* 两个已经踩到的坑，留在这里当路标：
*
* - **`web_fetch` 不在表里**，尽管 dsh 确实有这个工具。出厂 `standard` 给
*   `tool-web` 配的是 `fetch: false`，那一行只注册 `web_search`。
* - **`shell` 按平台分叉**：出厂组合在 Windows 上装 `pwsh`、其余平台装
*   `bash`，另一个被 `disabled` 掉，所以两个都列会错一半。
*
* 换掉基准 preset 就可能需要重新校准这张表。校准手法见 ADR-0017：让一个队员
* 的白名单里带一个不存在的名字，dsh 报错时会把它认得的全部工具名列出来。
*
* `platform` 是**必传参数**而不是读 `process.platform`：这一层也跑在浏览器里
* （小队编辑器要展示展开后的真实白名单），而浏览器里没有 `process`。平台是
* 部署的运行时事实，由宿主告知前端。
*/
function toolsForAbility(ability, platform) {
	switch (ability) {
		case "read": return [
			"read",
			"glob",
			"grep"
		];
		case "edit": return ["write", "edit"];
		case "shell": return platform === "win32" ? ["pwsh"] : ["bash"];
		case "web": return ["web_search"];
		case "delegate": return [
			"subagent",
			"subagent_fork",
			"list_agents",
			"send_message",
			"interrupt_agent"
		];
	}
}
/**
* 把队员的 model 字段解成子代理的 agentOptions。
*
* `provider/model` 拆成两个字段；纯模型名只设 model（provider 由 DSH 从父级
* 继承，见 subagent 的 resolveChildAgentOptions：父级打底、请求级覆盖）。
* 返回 undefined 表示沿用队长——行里就不写 agentOptions，一个字都不多写。
*/
function memberAgentOptions(member) {
	const raw = member.model?.trim() ?? "";
	if (raw.length === 0) return void 0;
	const slash = raw.indexOf("/");
	if (slash < 0) return { model: raw };
	const provider = raw.slice(0, slash).trim();
	const model = raw.slice(slash + 1).trim();
	if (provider.length === 0 || model.length === 0) return void 0;
	return {
		provider,
		model
	};
}
/** Squad 目录名的前缀。既避开与内置 preset 撞名，也让 DSH 的列表里一眼可辨。 */
const SQUAD_ID_PREFIX = "vela-";
/** 组合文件名（DSH 读）。 */
const COMPOSITION_FILE = "agent.cordis.yml";
/** 显示元数据文件名（DSH 的选择器读）。 */
const METADATA_FILE = "preset.yml";
/** Vela 自己的策略文件名。DSH 不认识它，会原样忽略。 */
const POLICY_FILE = "vela.json";
/** DSH 自带的委派工具名——队员不能叫这些，否则撞车。 */
const RESERVED_TOOL_NAMES = [
	"subagent",
	"subagent_fork",
	"subagent_codex",
	"subagent_claude_code",
	"send_message",
	"interrupt_agent",
	"list_agents",
	"report"
];
/** 合法的队员名/小队 slug：小写字母开头，其后小写字母、数字、下划线。 */
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
/** 把一个显示名压成合法的 slug，用于拼 Squad id。纯非 ASCII 的名字会压成空串。 */
function slugify(title) {
	const ascii = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return ascii.length === 0 ? "" : ascii;
}
/**
* 一个短而稳定的散列（FNV-1a），用来给压不出 slug 的名字兜底。
*
* 必须是**确定性**的：同一个名字要始终映到同一个 id，否则「已经有一支叫这个
* 名字的小队了」这条判定会失效，同名小队会被反复建出来。
*/
function stableSuffix(value) {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash.toString(36);
}
/**
* 由显示名推一个 Squad id。
*
* 中文名（以及任何纯非 ASCII 的名字）压出来的 slug 是空的——目录名只能是
* ASCII，而这恰恰是最常见的取名方式，所以必须兜住而不是拒绝。兜底用名字的
* 稳定散列，因此「后端小队」永远映到同一个 id。
*/
function squadIdFor(title) {
	const slug = slugify(title);
	if (slug.length > 0) return `${SQUAD_ID_PREFIX}${slug}`;
	const trimmed = title.trim();
	return trimmed.length === 0 ? "" : `${SQUAD_ID_PREFIX}s${stableSuffix(trimmed)}`;
}
/** 一个队员最终生效的工具白名单；空数组表示这个队员没有任何工具。 */
function memberTools(member, platform) {
	const out = /* @__PURE__ */ new Set();
	for (const ability of member.abilities) for (const tool of toolsForAbility(ability, platform)) out.add(tool);
	for (const tool of member.extraTools ?? []) {
		const trimmed = tool.trim();
		if (trimmed.length > 0) out.add(trimmed);
	}
	return [...out];
}
/**
* 校验一支小队。返回一条给人看的错误说明，或 undefined 表示合法。
*
* 这里拒绝得比 DSH 严：一份 DSH 认不出的组合文件的症状是「那支队的会话建不
* 起来」，发生在派活的时候——离出错的原因很远。宁可在保存时就拒绝。
*/
function validateSquad(squad, platform) {
	if (squad.title.trim().length === 0) return "小队要有名字";
	if (!squad.id.startsWith("vela-")) return `小队 id 必须以 ${SQUAD_ID_PREFIX} 开头，收到 ${squad.id}`;
	const slug = squad.id.slice(5);
	if (slug.length === 0) return "小队名里至少要有一个字母或数字";
	if (!/^[a-z0-9-]+$/.test(slug)) return `小队 id 只能含小写字母、数字与连字符，收到 ${squad.id}`;
	if (!Number.isInteger(squad.maxParallelMembers) || squad.maxParallelMembers < 1) return "同时在跑的队员数必须是不小于 1 的整数";
	const seen = /* @__PURE__ */ new Set();
	for (const member of squad.members) {
		if (!NAME_PATTERN.test(member.name)) return `队员名 "${member.name}" 不合法：要以小写字母开头，其后只能是小写字母、数字或下划线`;
		if (RESERVED_TOOL_NAMES.includes(member.name)) return `队员名 "${member.name}" 与 DSH 自带的工具撞名，换一个`;
		if (seen.has(member.name)) return `队员名 "${member.name}" 重复了`;
		seen.add(member.name);
		if (!MEMBER_BACKENDS.includes(member.backend)) return `队员 "${member.name}" 的执行后端 "${member.backend}" 不支持`;
		if (member.model !== void 0 && member.model.trim().length > 0 && memberAgentOptions(member) === void 0) return `队员 "${member.name}" 的模型 "${member.model}" 不合法：写模型名或 provider/model`;
		if (memberTools(member, platform).length === 0) return `队员 "${member.name}" 至少要勾一项能力，否则它没有任何工具可用`;
	}
}
/**
* 队长上场时收到的开场说明 = Operator 写的职责 + 自动追加的队员名册。
*
* **为什么是开场消息而不是系统设定。** 基准 preset 自己已经有一行
* `@deepseek-ai/dsh-persona`，而同一作用域里 `deployment:persona` 这个段名只能
* 注册一次——再加一行不是覆盖，是直接抛错，整支队起不来。而基准那一行又不
* 能删（追加是纯文本操作，改不了前面的行）。于是职责说明只能前置到任务里。
*
* 代价得记住：它不再是系统级设定，模型原则上可以忽略它；也拿不到前缀缓存的
* 好处（每张卡的开场消息不同）。
*
* **为什么必须自动追加名册：**DSH 为每个委派工具生成的说明文字是**固定的通用
* 话术**，不可配置。于是五个队员在队长眼里就是五个说明一模一样、只有名字不同
* 的工具，光看名字它不知道该派谁。名册是这个信息的唯一来源。
*/
function leaderInstruction(squad, platform) {
	const own = squad.instruction.trim();
	if (squad.members.length === 0) return own;
	const header = [
		"## 你的队员",
		"",
		"你可以把活派给下面这些队员，每个队员是一个同名的委派工具。",
		"派活时请按职责挑人，并给出自成一体的完整任务描述。",
		"",
		"除非没有合适的队员，不要用通用的 subagent / subagent_fork：那两个拿的是你自己的",
		"全部权限，绕过了队员各自的工具边界。",
		"",
		squad.members.map((member) => {
			const duty = member.instruction.trim();
			const tools = memberTools(member, platform).join("、");
			const duties = duty.length === 0 ? "（未写职责）" : duty.replace(/\s+/g, " ");
			return `- \`${member.name}\`：${duties}（可用：${tools}）`;
		}).join("\n")
	].join("\n");
	return own.length === 0 ? header : `${own}\n\n${header}`;
}
/**
* 把一行渲成一个 YAML 顶层序列项。
*
* 缩进的细节重要：第一行是 `- {`，于是 `{` 落在第 2 列；后续行缩进 2 个空格
* 也落在第 2 列，正好满足 flow 映射跳行的缩进要求。写成多行而不是挤在一行，
* 因为队员的职责说明可能很长，挤成一行就无法 diff 也无法人读了。
*/
function renderRow(row) {
	const [first, ...rest] = JSON.stringify(row, void 0, 2).split("\n");
	return [`- ${first}`, ...rest.map((line) => `  ${line}`)].join("\n");
}
/**
* 队员职责说明的结束约定：Vela 自动追加在每个队员的 persona 后面。
*
* 为什么由 Vela 包而不是让 Operator 自己写：总结的读者是看板上验收卡片的人。
* 队员最后一条助手消息的文本会被 Vela 提取出来显示在泳道下方——没有这个约定，
* 队员最后一句话可能是任何东西（一个文件路径、一句「好了」），验收就得翻整场会话。
*
* 注意连锁影响：provider 侧拿 persona 反查队员名时，必须按「全等或前缀」认人，
* 因为这里的 persona 已经不等于 Operator 写的职责原文了（见 squad-provider 的
* memberNameOf）。
*/
const MEMBER_OUTRO = "结束时，你的最后一条消息用一两句话说明：做了什么、结果如何。这段话会显示在任务卡片上，给验收的人看。";
/** 队员的 persona = 职责原文 + 结束约定。职责为空时不造 persona（行里不写这个字段）。 */
function memberPersona(member) {
	const own = member.instruction.trim();
	if (own.length === 0) return void 0;
	return `${own}\n\n${MEMBER_OUTRO}`;
}
/** 追加段的分隔注释。让人手打开文件时一眼看出哪里是 Vela 写的。 */
const APPENDED_SECTION_HEADER = [
	"# ── Vela 小队队员（以下由 Vela 生成）──────────────────────────",
	"#",
	"# 上面的全部内容是基准 preset 的原文副本，每个队员在下面各占一行。",
	"# 手改这份文件会在下一次保存小队时被整份覆盖。"
].join("\n");
/**
* 基准组合文本能不能拿来追加。返回一条给人看的说明，或 undefined 表示可以。
*
* 只做一件事：确认它真的是一个**顶层序列**。这是追加法唯一的前提——往一份
* mapping 后面接一个 `- …` 会得到一份语法错误的 YAML，而那份文件的症状是小队在
* DSH 里显示为 broken，离原因很远。宁可在保存时就拒。
*
* 不做完整 YAML 校验：这一层没有也不应该有 YAML 解析器，而且基准本身已经被
* DSH 自己读过一次（它能被读出来才能被当作基准）。
*/
function baselineProblem(baseline) {
	if (baseline.trim().length === 0) return "基准 preset 的组合文件是空的";
	if (!/^-(\s|$)/m.test(baseline)) return "基准 preset 的组合文件不是一个顶层列表，无法在它后面追加队员";
}
/**
* 生成组合文件的内容（DSH 读的那份）= 基准全文 + 每个队员一行。
*
* 行的顺序固定（按声明顺序），让文件可 diff。队员行放**顶层**而不是塞进基准里
* 的 delegation 分组：`tool-subagent` 需要的 `subagents` 注册表在宿主平面，顶层拿
* 得到；而那个分组的 `isolate` 是给 workflow 引擎用的，与队员无关。依靠追加而不
* 是插入，也是「不用理解基准内容」这个技巧能成立的原因。
*
* @param baseline - 基准 preset 组合文件的原文。调用方应先过 {@link baselineProblem}。
*/
function composeComposition(squad, platform, baseline, options = {}) {
	const rows = squad.members.map((member) => ({
		id: `vela-member-${member.name}`,
		name: "@deepseek-ai/dsh-tool-subagent",
		config: {
			provider: options.providerFor?.(member.backend) ?? member.backend,
			toolName: member.name,
			backgroundMode: "one-shot",
			...memberPersona(member) === void 0 ? {} : { persona: memberPersona(member) },
			toolFilter: { allow: [...memberTools(member, platform)] },
			...memberAgentOptions(member) === void 0 ? {} : { agentOptions: memberAgentOptions(member) }
		}
	}));
	const head = baseline.endsWith("\n") ? baseline : `${baseline}\n`;
	if (rows.length === 0) return head;
	return `${head}\n${APPENDED_SECTION_HEADER}\n\n${rows.map(renderRow).join("\n\n")}\n`;
}
/** 生成显示元数据文件的内容。 */
function composeMetadata(squad) {
	const description = squad.members.length === 0 ? "Vela 小队（还没有队员）" : `Vela 小队：${squad.members.map((member) => member.name).join("、")}`;
	return `${JSON.stringify({
		name: squad.title,
		description
	}, void 0, 2)}\n`;
}
/** 生成 Vela 自己的策略文件内容。 */
function composePolicy(squad) {
	return `${JSON.stringify({
		version: 1,
		title: squad.title,
		instruction: squad.instruction,
		members: squad.members,
		...squad.sandbox === void 0 ? {} : { sandbox: squad.sandbox },
		maxParallelMembers: squad.maxParallelMembers
	}, void 0, 2)}\n`;
}
/**
* 从策略文件读回一支小队。
*
* **读的是策略文件而不是组合文件**：组合文件是给 DSH 的产物，队员的能力勾选
* 在那里已经被展开成一串工具名，反推回勾选项会丢信息（比如平台分叉过的 shell、
* 以及高级口里手填的工具）。策略文件保留 Operator 的原始意图，组合文件则是它的
* 一次投影。
*
* @param id - 目录名。
* @param policyText - 策略文件内容。
* @returns 小队，或 undefined 表示这份策略读不出来。
*/
function parsePolicy(id, policyText) {
	let raw;
	try {
		raw = JSON.parse(policyText);
	} catch {
		return;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
	const record = raw;
	if (record.version !== 1) return void 0;
	const title = typeof record.title === "string" && record.title.trim().length > 0 ? record.title : id.slice(5);
	const rawMembers = Array.isArray(record.members) ? record.members : [];
	const members = [];
	for (const candidate of rawMembers) {
		if (typeof candidate !== "object" || candidate === null) return void 0;
		const member = candidate;
		if (typeof member.name !== "string") return void 0;
		const abilities = Array.isArray(member.abilities) ? member.abilities.filter((value) => ABILITIES.includes(value)) : [];
		const extraTools = Array.isArray(member.extraTools) ? member.extraTools.filter((value) => typeof value === "string") : [];
		members.push({
			name: member.name,
			instruction: typeof member.instruction === "string" ? member.instruction : "",
			abilities,
			...extraTools.length === 0 ? {} : { extraTools },
			backend: MEMBER_BACKENDS.includes(member.backend) ? member.backend : "spawn",
			...typeof member.model === "string" && member.model.trim().length > 0 ? { model: member.model } : {}
		});
	}
	const parallel = record.maxParallelMembers;
	return {
		id,
		title,
		instruction: typeof record.instruction === "string" ? record.instruction : "",
		members,
		...typeof record.sandbox === "string" ? { sandbox: record.sandbox } : {},
		maxParallelMembers: Number.isInteger(parallel) && parallel >= 1 ? parallel : 3
	};
}
//#endregion
//#region src/http/contract.ts
/**
* host 与 client 共享的 HTTP 契约常量。刻意是零依赖叶子模块：client
* bundle 会 import 它，因此它不能顺藤摸到任何 node-only 代码。
*/
/** Vela 全部路由的前缀。 */
const API_PREFIX = "/api/vela";
//#endregion
//#region src/http/routes.ts
/**
* 验收之后处置那篇复盘（ADR-0025）。
*
* 只在快照已经改成功之后调。回写失败**只记一句警告**：看板是真相，
* 一次磁盘故障不能让 Operator 没法验收卡片。
*
* @param issue - 验收**之前**的那张卡（验收会改 Lane，但不改 runs）。
*/
async function settleRecap(deps, issue, verdict, keepRecap) {
	const memory = deps.memory;
	if (memory === void 0 || issue === void 0 || issue.runs.length === 0) return;
	const relative = recapRelativePath({
		workspace: issue.workspace,
		issueNumber: issue.number,
		runSeq: issue.runs.length
	});
	try {
		if (verdict === "accept" && keepRecap) {
			await memory.verify(relative, deps.now());
			return;
		}
		if (verdict === "accept") {
			await memory.deprecate(relative, "验收时判定这篇不值得留", deps.now());
			return;
		}
	} catch (error) {
		deps.logger?.warn(`vela: 验收后回写复盘失败（${relative}）：${describeError(error)}`);
	}
}
function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}
const STATUS_BY_CODE = {
	"not-found": 404,
	"invalid": 400,
	"illegal-transition": 409,
	"conflict": 409
};
const STATUS_BY_SQUAD_CODE = {
	"not-found": 404,
	"invalid": 400,
	"conflict": 409,
	"io": 500
};
function json(status, body) {
	return {
		status,
		body
	};
}
function fromResult(result, onOk) {
	if (!result.ok) return json(STATUS_BY_CODE[result.code], {
		ok: false,
		code: result.code,
		message: result.message
	});
	return onOk(result.value);
}
function asRecord(body) {
	return typeof body === "object" && body !== null && !Array.isArray(body) ? body : void 0;
}
function optionalString(value) {
	return typeof value === "string" ? value : void 0;
}
function isLane$1(value) {
	return typeof value === "string" && LANES.includes(value);
}
function isPriority$1(value) {
	return typeof value === "string" && PRIORITIES.includes(value);
}
/**
* 读一份执行配置覆盖（票 11）。显式的 null 表示「清除覆盖、回落到全局
* 默认」，与「没提这个字段」区分开。
*/
function readExec(value) {
	if (value === void 0) return void 0;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid";
	const raw = value;
	const out = {};
	for (const key of [
		"agentPreset",
		"sandbox",
		"squad"
	]) {
		const field = raw[key];
		if (field === void 0 || field === null) continue;
		if (typeof field !== "string") return "invalid";
		out[key] = field;
	}
	if (raw.timeoutMs !== void 0 && raw.timeoutMs !== null) {
		if (typeof raw.timeoutMs !== "number") return "invalid";
		out.timeoutMs = raw.timeoutMs;
	}
	return out;
}
/**
* 把 Board 投影成给浏览器的形状：快照本身，加上一批**不属于快照**的运行时
* 事实。它们刷新即变，故不能写进快照：实时用量、宿主能力、部署提供的档位
* 表、以及小队时间轴。
*/
function boardView(board, deps, squads) {
	return {
		ok: true,
		board,
		liveUsage: deps.dispatcher?.liveUsageByIssue() ?? {},
		sandboxPresets: deps.sandboxPresets(),
		canDispatch: deps.dispatcher !== void 0,
		/** 可选的小队——派活时的下拉靠它。 */
		squads,
		/** 这个部署能不能管理小队（没有可写 preset 根时为 false）。 */
		canManageSquads: deps.squads !== void 0,
		/** 部署平台，小队编辑器靠它展开工具白名单。 */
		platform: deps.platform(),
		/** 这个部署接入的模型清单——队员的模型下拉用。 */
		modelCatalog: deps.modelCatalog?.() ?? [],
		/**
		* 小队时间轴，按**会话 id** 索引（ADR-0019）。
		*
		* 只带上真的有泳道的那些会话，而不是每个 Run 都给一个空数组：前者让前端
		* 能用「有没有这个键」区分「派了小队但一个队员也没派出」与「这不是小队 Run」。
		*/
		timelines: timelineView(deps),
		/**
		* 每张卡**此刻**在跑的队员名单，按 issue id 索引（ADR-0019 的同一台记录器）。
		*
		* 只写有队员真的在跑的卡：没有这个键 = 没有队员在跑。队员名反查不到时
		* 用任务描述兜底——「有活正在跑」这个事实比「是谁」更不能丢。
		*/
		liveMembers: liveMembersView(board, deps)
	};
}
/** 算出每张卡此刻有哪些队员在跑。 */
function liveMembersView(board, deps) {
	const timeline = deps.timeline;
	if (timeline === void 0) return {};
	const out = {};
	for (const issue of board.issues) {
		const active = issue.runs.findLast((run) => run.endedAt === void 0);
		if (active === void 0) continue;
		const running = timeline.spansFor(active.sessionId).filter((span) => span.observedEnd === void 0).map((span) => span.member ?? span.label);
		if (running.length > 0) out[issue.id] = running;
	}
	return out;
}
/** 把时间轴投成一个按会话 id 索引的对象。没接记录器时给空对象。 */
function timelineView(deps) {
	const timeline = deps.timeline;
	if (timeline === void 0) return {};
	const out = {};
	for (const sessionId of timeline.parents()) {
		const spans = timeline.spansFor(sessionId);
		if (spans.length > 0) out[sessionId] = spans;
	}
	return out;
}
/** 把一份未经校验的请求体读成一支小队；形状不对返回一条说明。 */
function readSquad(body, fallbackId) {
	const raw = asRecord(body);
	if (raw === void 0) return { error: "body must be an object" };
	const title = optionalString(raw.title);
	if (title === void 0 || title.trim().length === 0) return { error: "小队要有名字" };
	const rawMembers = raw.members;
	if (rawMembers !== void 0 && !Array.isArray(rawMembers)) return { error: "members must be an array" };
	const members = [];
	for (const candidate of rawMembers ?? []) {
		const member = asRecord(candidate);
		if (member === void 0) return { error: "每个队员必须是一个对象" };
		const name = optionalString(member.name);
		if (name === void 0) return { error: "队员要有名字" };
		const abilities = Array.isArray(member.abilities) ? member.abilities.filter((value) => ABILITIES.includes(value)) : [];
		const extraTools = Array.isArray(member.extraTools) ? member.extraTools.filter((value) => typeof value === "string") : [];
		const backend = optionalString(member.backend) ?? "spawn";
		if (!MEMBER_BACKENDS.includes(backend)) return { error: `队员 "${name}" 的执行后端 "${backend}" 不支持` };
		members.push({
			name,
			instruction: optionalString(member.instruction) ?? "",
			abilities,
			...extraTools.length === 0 ? {} : { extraTools },
			backend,
			...typeof member.model === "string" && member.model.trim().length > 0 ? { model: member.model.trim() } : {}
		});
	}
	const parallel = raw.maxParallelMembers;
	return {
		id: fallbackId ?? squadIdFor(title),
		title: title.trim(),
		instruction: optionalString(raw.instruction) ?? "",
		members,
		...optionalString(raw.sandbox) === void 0 ? {} : { sandbox: raw.sandbox },
		maxParallelMembers: typeof parallel === "number" ? parallel : 3
	};
}
/** 一支小队给浏览器的形状：定义本身，加上队长实际收到的完整职责说明。 */
function squadView(squad, platform) {
	return {
		...squad,
		resolvedInstruction: leaderInstruction(squad, platform)
	};
}
function fromSquadResult(result, onOk) {
	if (!result.ok) return json(STATUS_BY_SQUAD_CODE[result.code], {
		ok: false,
		code: result.code,
		message: result.message
	});
	return onOk(result.value);
}
/**
* 处理一次 API 调用。
*
* 所有写操作都经 `store.mutate` 走同一条串行化写链，因此并发请求之间
* 不会读改写交错。
*/
async function handleApi(store, deps, request) {
	const { method } = request;
	const rest = request.path.startsWith("/api/vela") ? request.path.slice(9) : void 0;
	if (rest === void 0) return json(404, {
		ok: false,
		code: "not-found",
		message: "unknown path"
	});
	let squadCache;
	const listSquads = async () => {
		squadCache ??= deps.squads === void 0 ? [] : await deps.squads.list();
		return squadCache;
	};
	const viewJson = async (status) => json(status, boardView(store.snapshot(), deps, await listSquads()));
	/**
	* 一次写操作的统一收尾：失败映成状态码，成功回一份**完整**的看板视图。
	*
	* 必须是完整的：浏览器会直接采信写操作的返回值来刷新界面，少带一项
	* （比如小队名单）就会让那个下拉框在每次编辑后突然变空。
	*/
	const settleWithView = async (result, status) => {
		if (!result.ok) return json(STATUS_BY_CODE[result.code], {
			ok: false,
			code: result.code,
			message: result.message
		});
		return viewJson(status);
	};
	let segments;
	try {
		segments = rest.split("/").filter((part) => part.length > 0).map((part) => decodeURIComponent(part));
	} catch {
		return json(400, {
			ok: false,
			code: "invalid",
			message: "path contains an invalid escape sequence"
		});
	}
	if (method === "GET" && segments.length === 1 && segments[0] === "board") return viewJson(200);
	if (method === "POST" && segments.length === 1 && segments[0] === "open-document") {
		const target = optionalString(asRecord(request.body)?.target);
		if (target === void 0 || !DOCUMENT_TARGETS.includes(target)) return json(400, {
			ok: false,
			code: "invalid",
			message: `target must be one of ${DOCUMENT_TARGETS.join(", ")}`
		});
		if (deps.documents === void 0) return json(409, {
			ok: false,
			code: "conflict",
			message: "这个部署打不开配置文件"
		});
		return json(200, {
			ok: true,
			...await deps.documents.open(target)
		});
	}
	if (method === "GET" && segments.length === 1 && segments[0] === "skills") {
		if (deps.skills === void 0) return json(200, {
			ok: true,
			available: false,
			skills: []
		});
		return json(200, {
			ok: true,
			available: true,
			skills: await deps.skills.list()
		});
	}
	if (method === "GET" && segments.length === 1 && segments[0] === "memory") {
		const memory = deps.memory;
		if (memory === void 0) return json(200, {
			ok: true,
			available: false,
			entries: [],
			history: []
		});
		const at = deps.now();
		const pending = store.snapshot().issues.filter((issue) => issue.lane === "done" && issue.runs.length > 0).map((issue) => ({
			workspace: issue.workspace,
			issueNumber: issue.number,
			runSeq: issue.runs.length
		}));
		await memory.backfillVerified(pending, at).catch((error) => {
			deps.logger?.warn(`vela: 打开记忆页时的对账失败：${describeError(error)}`);
			return 0;
		});
		try {
			return json(200, {
				ok: true,
				available: true,
				entries: await memory.browse(at),
				history: await memory.history()
			});
		} catch (error) {
			return json(500, {
				ok: false,
				code: "io",
				message: `读不了记忆库：${describeError(error)}`
			});
		}
	}
	if (method === "POST" && segments.length === 2 && segments[0] === "memory" && segments[1] === "remove") {
		const memory = deps.memory;
		if (memory === void 0) return json(409, {
			ok: false,
			code: "conflict",
			message: "这个部署没开记忆库"
		});
		const path = optionalString(asRecord(request.body)?.path);
		if (path === void 0) return json(400, {
			ok: false,
			code: "invalid",
			message: "path is required"
		});
		try {
			if (!await memory.remove(path, deps.now())) return json(404, {
				ok: false,
				code: "not-found",
				message: `没有这篇：${path}`
			});
		} catch (error) {
			return json(400, {
				ok: false,
				code: "invalid",
				message: describeError(error)
			});
		}
		return json(200, {
			ok: true,
			available: true,
			entries: await memory.browse(deps.now()),
			history: await memory.history()
		});
	}
	if (method === "GET" && segments.length === 1 && segments[0] === "squads") {
		if (deps.squads === void 0) return json(200, {
			ok: true,
			squads: [],
			canManageSquads: false
		});
		return json(200, {
			ok: true,
			squads: (await listSquads()).map((squad) => squadView(squad, deps.platform())),
			canManageSquads: true
		});
	}
	if (method === "POST" && segments.length === 1 && segments[0] === "squads") {
		if (deps.squads === void 0) return json(409, {
			ok: false,
			code: "conflict",
			message: "这个部署没有可写的 preset 根，建不了小队"
		});
		const parsed = readSquad(request.body);
		if ("error" in parsed) return json(400, {
			ok: false,
			code: "invalid",
			message: parsed.error
		});
		return fromSquadResult(await deps.squads.write(parsed, { expectNew: true }), (value) => json(201, {
			ok: true,
			squad: squadView(value, deps.platform())
		}));
	}
	if (method === "PATCH" && segments.length === 2 && segments[0] === "squads") {
		if (deps.squads === void 0) return json(409, {
			ok: false,
			code: "conflict",
			message: "这个部署没有可写的 preset 根"
		});
		const id = segments[1];
		const existing = await deps.squads.read(id);
		if (!existing.ok) return fromSquadResult(existing, () => json(500, { ok: false }));
		const parsed = readSquad(request.body, id);
		if ("error" in parsed) return json(400, {
			ok: false,
			code: "invalid",
			message: parsed.error
		});
		return fromSquadResult(await deps.squads.write(parsed), (value) => json(200, {
			ok: true,
			squad: squadView(value, deps.platform())
		}));
	}
	if (method === "DELETE" && segments.length === 2 && segments[0] === "squads") {
		if (deps.squads === void 0) return json(409, {
			ok: false,
			code: "conflict",
			message: "这个部署没有可写的 preset 根"
		});
		return fromSquadResult(await deps.squads.remove(segments[1]), () => json(204, { ok: true }));
	}
	if (method === "POST" && segments.length === 1 && segments[0] === "issues") {
		const body = asRecord(request.body);
		if (body === void 0) return json(400, {
			ok: false,
			code: "invalid",
			message: "body must be an object"
		});
		const title = optionalString(body.title);
		const workspace = optionalString(body.workspace);
		if (title === void 0 || workspace === void 0) return json(400, {
			ok: false,
			code: "invalid",
			message: "title and workspace are required"
		});
		if (body.priority !== void 0 && !isPriority$1(body.priority)) return json(400, {
			ok: false,
			code: "invalid",
			message: "unknown priority"
		});
		const priority = isPriority$1(body.priority) ? body.priority : void 0;
		const exec = readExec(body.exec);
		if (exec === "invalid") return json(400, {
			ok: false,
			code: "invalid",
			message: "exec must be an object of optional overrides"
		});
		if (exec !== void 0) {
			const rejected = validateOverrides(exec, deps.sandboxPresets());
			if (rejected !== void 0) return json(400, {
				ok: false,
				code: "invalid",
				message: rejected
			});
		}
		let created;
		await store.mutate((board) => {
			const result = createIssue(board, {
				title,
				workspace,
				...optionalString(body.description) === void 0 ? {} : { description: body.description },
				...priority === void 0 ? {} : { priority },
				...typeof body.maxAttempts === "number" ? { maxAttempts: body.maxAttempts } : {},
				...exec === void 0 ? {} : { exec }
			}, deps.now(), deps.newId());
			created = result;
			return result.ok ? {
				board: result.value.board,
				value: void 0
			} : void 0;
		});
		return fromResult(created, (value) => json(201, {
			ok: true,
			issue: value.issue
		}));
	}
	if (method === "POST" && segments.length === 2 && segments[0] === "issues" && segments[1] === "batch") {
		const body = asRecord(request.body);
		const items = body?.items;
		const workspace = optionalString(body?.workspace);
		if (!Array.isArray(items) || workspace === void 0) return json(400, {
			ok: false,
			code: "invalid",
			message: "workspace and items are required"
		});
		if (items.length === 0) return json(400, {
			ok: false,
			code: "invalid",
			message: "items must not be empty"
		});
		const titles = [];
		for (const item of items) {
			const title = typeof item === "string" ? item : optionalString(asRecord(item)?.title);
			if (title === void 0 || title.trim().length === 0) return json(400, {
				ok: false,
				code: "invalid",
				message: "every item needs a non-empty title"
			});
			titles.push(title.trim());
		}
		let outcome;
		await store.mutate((board) => {
			let working = board;
			for (const title of titles) {
				const result = createIssue(working, {
					title,
					workspace
				}, deps.now(), deps.newId());
				if (!result.ok) {
					outcome = result;
					return;
				}
				working = result.value.board;
			}
			outcome = {
				ok: true,
				value: working
			};
			return {
				board: working,
				value: void 0
			};
		});
		return settleWithView(outcome, 201);
	}
	if (segments[0] !== "issues" || segments.length < 2) return json(404, {
		ok: false,
		code: "not-found",
		message: "unknown path"
	});
	const issueId = segments[1];
	if (method === "PATCH" && segments.length === 2) {
		const body = asRecord(request.body);
		if (body === void 0) return json(400, {
			ok: false,
			code: "invalid",
			message: "body must be an object"
		});
		if (body.priority !== void 0 && !isPriority$1(body.priority)) return json(400, {
			ok: false,
			code: "invalid",
			message: "unknown priority"
		});
		const priority = isPriority$1(body.priority) ? body.priority : void 0;
		const exec = readExec(body.exec);
		if (exec === "invalid") return json(400, {
			ok: false,
			code: "invalid",
			message: "exec must be an object of optional overrides"
		});
		if (exec !== void 0) {
			const rejected = validateOverrides(exec, deps.sandboxPresets());
			if (rejected !== void 0) return json(400, {
				ok: false,
				code: "invalid",
				message: rejected
			});
		}
		let outcome;
		await store.mutate((board) => {
			const result = updateIssue(board, issueId, {
				...optionalString(body.title) === void 0 ? {} : { title: body.title },
				...optionalString(body.description) === void 0 ? {} : { description: body.description },
				...optionalString(body.workspace) === void 0 ? {} : { workspace: body.workspace },
				...priority === void 0 ? {} : { priority },
				...typeof body.maxAttempts === "number" ? { maxAttempts: body.maxAttempts } : {},
				...exec === void 0 ? {} : { exec }
			}, deps.now());
			outcome = result;
			return result.ok ? {
				board: result.value,
				value: void 0
			} : void 0;
		});
		return settleWithView(outcome, 200);
	}
	if (method === "DELETE" && segments.length === 2) {
		let outcome;
		await store.mutate((board) => {
			const result = deleteIssue(board, issueId);
			outcome = result;
			return result.ok ? {
				board: result.value,
				value: void 0
			} : void 0;
		});
		return settleWithView(outcome, 200);
	}
	if (method === "POST" && segments.length === 3 && segments[2] === "move") {
		const body = asRecord(request.body);
		if (body === void 0 || !isLane$1(body.lane)) return json(400, {
			ok: false,
			code: "invalid",
			message: "lane is required and must be a known lane"
		});
		const lane = body.lane;
		const beforeId = optionalString(body.beforeId);
		const afterId = optionalString(body.afterId);
		let outcome;
		await store.mutate((board) => {
			const result = moveIssue(board, issueId, {
				lane,
				...beforeId === void 0 ? {} : { beforeId },
				...afterId === void 0 ? {} : { afterId }
			}, deps.now());
			outcome = result;
			return result.ok ? {
				board: result.value,
				value: void 0
			} : void 0;
		});
		return settleWithView(outcome, 200);
	}
	if (method === "POST" && segments.length === 3 && segments[2] === "gate") {
		const body = asRecord(request.body);
		const verdict = body?.verdict;
		if (verdict !== "accept" && verdict !== "reject") return json(400, {
			ok: false,
			code: "invalid",
			message: "verdict must be accept or reject"
		});
		const before = store.snapshot().issues.find((candidate) => candidate.id === issueId);
		const keepRecap = body?.keepRecap !== false;
		let outcome;
		await store.mutate((board) => {
			const result = gate(board, issueId, verdict, deps.now());
			outcome = result;
			return result.ok ? {
				board: result.value,
				value: void 0
			} : void 0;
		});
		if (outcome?.ok === true) await settleRecap(deps, before, verdict, keepRecap);
		return settleWithView(outcome, 200);
	}
	if (method === "POST" && segments.length === 3 && segments[2] === "dispatch") {
		if (deps.dispatcher === void 0) return json(409, {
			ok: false,
			code: "conflict",
			message: "this profile cannot dispatch Runs (no apiProxy is mounted)"
		});
		const result = await deps.dispatcher.dispatch(issueId);
		if (!result.ok) return json(STATUS_BY_CODE[result.code], {
			ok: false,
			code: result.code,
			message: result.message
		});
		return json(202, {
			ok: true,
			sessionId: result.value.sessionId,
			...boardView(store.snapshot(), deps, await listSquads())
		});
	}
	if (method === "POST" && segments.length === 3 && segments[2] === "cancel") {
		if (deps.dispatcher === void 0) return json(409, {
			ok: false,
			code: "conflict",
			message: "this profile cannot dispatch Runs (no apiProxy is mounted)"
		});
		return settleWithView(await deps.dispatcher.cancel(issueId), 202);
	}
	return json(404, {
		ok: false,
		code: "not-found",
		message: "unknown path"
	});
}
//#endregion
//#region src/domain/store.ts
/**
* Board 快照的持久化（ADR-0006）。单个人可读 JSON 文件，整份原子替换。
*
* 发布协议照官方 storage-json：同目录临时文件以 `wx`（排他创建）打开、
* 写入后 fsync、`rename` 覆盖目标，POSIX 上再 fsync 父目录。rename 在
* POSIX 与 Windows 上都是原子替换，因此**崩在任何一步都不会留下半写的
* 快照**——要么是旧的完整文件，要么是新的完整文件。
*
* 这里刻意用 replace 语义而非 link()+unlink() 的 no-clobber：Board 在
* 一个进程内只有一个写者（写链串行化），last-write-wins 是正确的。
*
* 路径**必须**由调用方显式给出。一个 `process.cwd()` 回落会把用户的
* Board 散落在进程恰好启动的地方。
*/
/** 快照读写失败。 */
var StoreError = class extends Error {
	kind;
	constructor(kind, message, options) {
		super(message, options);
		this.kind = kind;
		this.name = "StoreError";
	}
};
/** 序列化为人可读、可手改、可 git diff 的 JSON。 */
function serialize(board) {
	return `${JSON.stringify(board, void 0, 2)}\n`;
}
function isLane(value) {
	return typeof value === "string" && LANES.includes(value);
}
function isPriority(value) {
	return typeof value === "string" && PRIORITIES.includes(value);
}
function parseRun(raw, where) {
	if (typeof raw !== "object" || raw === null) throw new StoreError("malformed", `${where} must be an object`);
	const record = raw;
	if (typeof record.id !== "string") throw new StoreError("malformed", `${where}.id must be a string`);
	if (typeof record.sessionId !== "string") throw new StoreError("malformed", `${where}.sessionId must be a string`);
	if (record.status !== "running" && record.status !== "settled") throw new StoreError("malformed", `${where}.status must be running or settled`);
	return raw;
}
/**
* 给缺编号的 Issue 补号。顺序按 (createdAt, id) 而非文件里的位置：位置会
* 因为拖拽变，而这两个不会，所以同一份旧快照无论读多少次都得到同一套
* 编号——这让一次写回失败只是“没落盘”，而不是“下次编号就变了”。
*
* 取最小可用正整数，因此已有编号不被碰。
*/
function assignMissingNumbers(issues, numbered) {
	const assigned = new Map(numbered);
	const used = new Set(numbered.values());
	const pending = issues.filter((issue) => !assigned.has(issue.id)).sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
	let candidate = 1;
	for (const issue of pending) {
		while (used.has(candidate)) candidate += 1;
		assigned.set(issue.id, candidate);
		used.add(candidate);
	}
	return assigned;
}
/**
* 解析一份快照。手工编辑出的错误必须报 malformed 而不是静默产出一个
* 半损坏的 Board——Board 是 Operator 的系统记录，静默丢数据比报错更糟。
*
* 版本 1（无 Issue 编号）在此升级为当前版本。升级是**确定性**的，且不在
* 这里落盘；落盘由 {@link BoardStore.open} 决定，因为那里才知道磁盘上原本是什么。
*/
function parse(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new StoreError("malformed", "board snapshot is not valid JSON", { cause: error });
	}
	if (typeof raw !== "object" || raw === null) throw new StoreError("malformed", "board snapshot must be an object");
	const record = raw;
	if (record.version !== 1 && record.version !== 2) throw new StoreError("malformed", `unsupported board version ${String(record.version)}`);
	if (!Array.isArray(record.issues)) throw new StoreError("malformed", "board.issues must be an array");
	const seen = /* @__PURE__ */ new Set();
	const numbered = /* @__PURE__ */ new Map();
	const usedNumbers = /* @__PURE__ */ new Set();
	const issues = record.issues.map((rawIssue, index) => {
		const where = `board.issues[${index}]`;
		if (typeof rawIssue !== "object" || rawIssue === null) throw new StoreError("malformed", `${where} must be an object`);
		const issue = rawIssue;
		if (typeof issue.id !== "string" || issue.id.length === 0) throw new StoreError("malformed", `${where}.id must be a non-empty string`);
		if (seen.has(issue.id)) throw new StoreError("malformed", `duplicate issue id ${issue.id}`);
		seen.add(issue.id);
		if (typeof issue.title !== "string") throw new StoreError("malformed", `${where}.title must be a string`);
		if (typeof issue.workspace !== "string") throw new StoreError("malformed", `${where}.workspace must be a string`);
		if (!isLane(issue.lane)) throw new StoreError("malformed", `${where}.lane is not a known lane`);
		if (!isPriority(issue.priority)) throw new StoreError("malformed", `${where}.priority is not a known priority`);
		if (typeof issue.position !== "number" || !Number.isFinite(issue.position)) throw new StoreError("malformed", `${where}.position must be a finite number`);
		if (issue.number !== void 0) {
			if (!Number.isInteger(issue.number) || issue.number < 1) throw new StoreError("malformed", `${where}.number must be a positive integer`);
			const value = issue.number;
			if (usedNumbers.has(value)) throw new StoreError("malformed", `duplicate issue number ${value}`);
			usedNumbers.add(value);
			numbered.set(issue.id, value);
		}
		const runs = Array.isArray(issue.runs) ? issue.runs : [];
		return {
			...rawIssue,
			description: typeof issue.description === "string" ? issue.description : "",
			maxAttempts: typeof issue.maxAttempts === "number" ? issue.maxAttempts : 0,
			exec: typeof issue.exec === "object" && issue.exec !== null ? issue.exec : {},
			runs: runs.map((run, runIndex) => parseRun(run, `${where}.runs[${runIndex}]`))
		};
	});
	const assigned = assignMissingNumbers(issues, numbered);
	const highest = issues.reduce((max, issue) => Math.max(max, assigned.get(issue.id) ?? 0), 0);
	const declared = typeof record.nextNumber === "number" && Number.isInteger(record.nextNumber) ? record.nextNumber : 0;
	return {
		version: 2,
		nextNumber: Math.max(declared, highest + 1),
		issues: issues.map((issue) => ({
			...issue,
			number: assigned.get(issue.id)
		}))
	};
}
/** fsync 一个 POSIX 目录，让刚 rename 出来的条目崩溃可幸存。 */
async function fsyncDirectory(path) {
	if (process.platform === "win32") return;
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
/** 用 `data` 原子地替换 `path`。 */
async function writeAtomic(path, data) {
	const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
	try {
		const handle = await open(tmp, "wx", 384);
		try {
			await handle.writeFile(data, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tmp, path);
		await fsyncDirectory(dirname(path));
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
/**
* 一个打开的 Board 快照。内存状态是权威的；每次改动整份原子重写。
*
* 写入经一条**串行链**——`mutate` 的读改写不会交错。这是领域层要求的
* 「同一份快照的读改写串行化」，放在这里是因为它是介质的性质，而不是
* 每个调用点都要记得的纪律。
*/
var BoardStore = class BoardStore {
	path;
	board;
	/** 写链尾。每次 mutate 挂在前一次之后，保证读改写不交错。 */
	tail = Promise.resolve();
	constructor(path, initial) {
		this.path = path;
		this.board = initial;
	}
	/**
	* 打开（读取或懒创建）一份快照。读到的内容经规范化后与磁盘不一致时
	* （最典型的是版本 1 的旧快照被补上了 Issue 编号），立即写回一次。
	*
	* 写回失败**不**阻止打开：升级是确定性的，下次读会得到完全相同的结果，
	* 所以没落盘的后果只是“每次启动都重做一次”，而不是数据飘。拿不到写权限
	* 时 Board 仍然完全可读，这比直接报错打不开强。
	* @param path - 绝对文件路径。相对路径直接拒绝，避免 cwd 依赖。
	*/
	static async open(path) {
		if (!isAbsolute(path)) throw new StoreError("io", `board path must be absolute, got ${path}`);
		let text;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if (error.code !== "ENOENT") throw new StoreError("io", `cannot read board snapshot at ${path}`, { cause: error });
		}
		if (text === void 0) return new BoardStore(path, emptyBoard());
		const board = parse(text);
		const canonical = serialize(board);
		if (canonical !== text) try {
			await mkdir(dirname(path), {
				recursive: true,
				mode: 448
			});
			await writeAtomic(path, canonical);
		} catch {}
		return new BoardStore(path, board);
	}
	/** 当前快照。 */
	snapshot() {
		return this.board;
	}
	/**
	* 串行地读改写。`change` 拿到当前快照并返回下一个；返回 undefined
	* 表示放弃这次改动（不落盘）。发布失败则内存回滚——内存是权威的，
	* 一次被拒的写不能留在内存里，也不能搭下一次发布的车。
	*/
	async mutate(change) {
		const run = async () => {
			const outcome = change(this.board);
			if (outcome === void 0) return void 0;
			const previous = this.board;
			this.board = outcome.board;
			try {
				await mkdir(dirname(this.path), {
					recursive: true,
					mode: 448
				});
				await writeAtomic(this.path, serialize(outcome.board));
			} catch (error) {
				this.board = previous;
				throw new StoreError("io", `cannot publish board snapshot to ${this.path}`, { cause: error });
			}
			return outcome.value;
		};
		const attempt = this.tail.then(run, run);
		this.tail = attempt.catch(() => void 0);
		return attempt;
	}
};
//#endregion
//#region src/domain/squad-store.ts
/**
* Squad 的持久化：把一支小队落成 DSH 家目录里的一个 preset 目录，并读回来。
*
* 写入用与 Board 快照相同的原子发布（同目录临时文件 → fsync → rename），因此
* 崩在任何一步都不会留下半份组合文件——那会让 DSH 把这支队标成 broken。
*
* 目录的可写位置由调用方给出。DSH 默认的可写 preset 根是 `<dshHome>/.agent-presets`
* （ADR-0016），但路径解析是宿主的事，不是这一层的事。
*/
function ok(value) {
	return {
		ok: true,
		value
	};
}
function fail(code, message) {
	return {
		ok: false,
		code,
		message
	};
}
/**
* 一个 Squad 目录的集合，位于 DSH 的可写 preset 根下。
*
* 这里**不缓存**：目录随时可能被 Operator 手改，也可能被 DSH 的其他入口动过。
* 每次都读盘的代价是几次 readdir，换来的是不会拿着一份过期名单去派活。
*/
var SquadStore = class {
	root;
	platform;
	baseline;
	compose;
	/**
	* @param root - 可写 preset 根的绝对路径。
	* @param platform - 部署所在平台（`process.platform`）。它决定「跑命令」这项
	*   能力展开成 `pwsh` 还是 `bash`，填错会让整支队起不来（ADR-0017）。
	* @param baseline - 基准 preset 的组合原文来源。
	* @param compose - 生成组合时的旋钮。**每次写都重新取**：号牌层挂得比 Vela
	*   晚（它要等 `subagents` 服务），把它捕获成构造时的常量会让最早建的那
	*   几支队永远没有闸门。
	*/
	constructor(root, platform, baseline, compose = () => ({})) {
		this.root = root;
		this.platform = platform;
		this.baseline = baseline;
		this.compose = compose;
		if (!isAbsolute(root)) throw new Error(`squad root must be absolute, got ${root}`);
	}
	directoryFor(id) {
		return join(this.root, id);
	}
	/**
	* 列出全部 Vela 造的小队，按 id 升序。
	*
	* 只认 `vela-` 前缀的目录：这个根下还住着 Operator 自己写的 preset，那些不是
	* Vela 的资产，列出来会让「删除」变成一个危险按钮。
	*/
	async list() {
		let entries;
		try {
			entries = await readdir(this.root);
		} catch {
			return [];
		}
		const out = [];
		for (const id of entries.filter((name) => name.startsWith(SQUAD_ID_PREFIX)).sort()) {
			const squad = await this.read(id);
			if (squad.ok) out.push(squad.value);
		}
		return out;
	}
	/** 读一支小队。 */
	async read(id) {
		let text;
		try {
			text = await readFile(join(this.directoryFor(id), POLICY_FILE), "utf8");
		} catch {
			return fail("not-found", `小队 ${id} 不存在`);
		}
		const squad = parsePolicy(id, text);
		if (squad === void 0) return fail("invalid", `小队 ${id} 的定义读不出来`);
		return ok(squad);
	}
	/**
	* 写一支小队（新建或整体覆盖）。三个文件按依赖顺序写：策略最后落盘，
	* 因为它是 Vela 判断「这支队存在」的依据——先落它会让一次中断留下一支
	* 组合文件还没写好的队。
	*/
	async write(squad, options = {}) {
		const invalid = validateSquad(squad, this.platform);
		if (invalid !== void 0) return fail("invalid", invalid);
		const directory = this.directoryFor(squad.id);
		if (options.expectNew === true) {
			if ((await this.read(squad.id)).ok) return fail("conflict", `已经有一支叫 ${squad.title} 的小队了`);
		}
		let baseline;
		try {
			baseline = await this.baseline();
		} catch (error) {
			return fail("io", `读不到基准 preset，建不了小队：${describe$2(error)}`);
		}
		const badBaseline = baselineProblem(baseline);
		if (badBaseline !== void 0) return fail("invalid", badBaseline);
		try {
			await mkdir(directory, {
				recursive: true,
				mode: 448
			});
			await writeAtomic(join(directory, COMPOSITION_FILE), composeComposition(squad, this.platform, baseline, this.compose()));
			await writeAtomic(join(directory, METADATA_FILE), composeMetadata(squad));
			await writeAtomic(join(directory, POLICY_FILE), composePolicy(squad));
		} catch (error) {
			return fail("io", `写不进小队 ${squad.id}：${describe$2(error)}`);
		}
		return ok(squad);
	}
	/**
	* 删除一支小队。只删得掉 `vela-` 前缀的目录——Operator 自己手写的 preset
	* 不是 Vela 的资产。
	*/
	async remove(id) {
		if (!id.startsWith("vela-")) return fail("invalid", `${id} 不是 Vela 创建的小队，不能从这里删`);
		const existing = await this.read(id);
		if (!existing.ok && existing.code === "not-found") return fail("not-found", `小队 ${id} 不存在`);
		try {
			await rm(this.directoryFor(id), {
				recursive: true,
				force: true
			});
		} catch (error) {
			return fail("io", `删不掉小队 ${id}：${describe$2(error)}`);
		}
		return ok(void 0);
	}
};
function describe$2(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/domain/slots.ts
/** 排队被取消时抛出的错误。调用方据此把这次起跑当作「已取消」而不是「失败」。 */
var SlotAbortedError = class extends Error {
	constructor(reason) {
		super(reason);
		this.name = "SlotAbortedError";
	}
};
/**
* 按 key 分组的号牌池。
*
* key 就是小队 id：号牌是**每支队**的，不是全局的。两支队各自的三个队员应当能
* 同时跑——看板级的总闸门是另一回事，由 Runner 的并发上限管（ADR-0018 的另一半）。
*/
var SlotPool = class {
	deps;
	ledgers = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.deps = deps;
	}
	/** 某个 key 当前在外面的号牌数。给测试与诊断用。 */
	heldFor(key) {
		return this.ledgers.get(key)?.held ?? 0;
	}
	/** 某个 key 当前排队的人数。给测试与诊断用。 */
	waitingFor(key) {
		return this.ledgers.get(key)?.waiting.length ?? 0;
	}
	/**
	* 领一张号牌。满额时返回的 promise 一直挂着，直到有人还牌。
	*
	* @param limit - 这个 key 的上限。**每次都传**：小队设置改了之后，下一次领牌
	*   就该按新数字来，而不是等进程重启。非正整数视为不限。
	* @param signal - 排队期间的取消通道。abort 时 promise 以 {@link SlotAbortedError}
	*   拒绝，且这个等待者被从队列里摘掉——否则它会在取消之后才冒出来起跑。
	*/
	acquire(key, limit, signal) {
		if (!Number.isInteger(limit) || limit < 1) return Promise.resolve({ release: () => {} });
		const ledger = this.ledgerFor(key);
		ledger.limit = limit;
		if (signal?.aborted === true) return Promise.reject(new SlotAbortedError(abortReason(signal)));
		if (ledger.held < ledger.limit) {
			ledger.held += 1;
			return Promise.resolve(this.mint(key));
		}
		return new Promise((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				detach: () => {
					if (onAbort !== void 0) signal?.removeEventListener("abort", onAbort);
				}
			};
			const onAbort = signal === void 0 ? void 0 : () => {
				const at = ledger.waiting.indexOf(waiter);
				if (at >= 0) ledger.waiting.splice(at, 1);
				waiter.detach();
				reject(new SlotAbortedError(abortReason(signal)));
			};
			if (onAbort !== void 0) signal?.addEventListener("abort", onAbort, { once: true });
			ledger.waiting.push(waiter);
		});
	}
	/**
	* 丢掉某个 key 全部**还在排队**的请求。
	*
	* 用在整个 Run 被取消时：不这么做的话，取消之后还会有队员陆续冒出来起跑。
	* 已经在跑的队员不受影响——停它们是 DSH 的取消路径的事，不是号牌的事。
	*/
	drainWaiting(key, reason) {
		const ledger = this.ledgers.get(key);
		if (ledger === void 0) return 0;
		const dropped = ledger.waiting.splice(0, ledger.waiting.length);
		for (const waiter of dropped) {
			waiter.detach();
			waiter.reject(new SlotAbortedError(reason));
		}
		return dropped.length;
	}
	ledgerFor(key) {
		const existing = this.ledgers.get(key);
		if (existing !== void 0) return existing;
		const fresh = {
			held: 0,
			limit: 1,
			waiting: []
		};
		this.ledgers.set(key, fresh);
		return fresh;
	}
	/**
	* 造一张号牌。牌自己记着「还没还过」，所以还两次只算一次。
	*
	* 幂等不是防御性编程的客套——`SubagentRun.result` 与我们自己的清理路径都可能
	* 走到还牌，两边都还一次就会凭空多出一个坑位，那支队的上限就此失效。
	*/
	mint(key) {
		let released = false;
		const timer = this.deps.maxHoldMs > 0 ? this.deps.setTimer(() => {
			if (released) return;
			this.deps.logger?.warn(`vela: 一张 ${key} 的号牌持有超过 ${this.deps.maxHoldMs}ms，强制回收。这通常意味着某个队员的结束信号没有送到。`);
			release();
		}, this.deps.maxHoldMs) : void 0;
		const release = () => {
			if (released) return;
			released = true;
			if (timer !== void 0) this.deps.clearTimer(timer);
			this.handBack(key);
		};
		return { release };
	}
	/** 还一个坑位：先看有没有人在等，有就直接转手，避免坑位空转一轮。 */
	handBack(key) {
		const ledger = this.ledgers.get(key);
		if (ledger === void 0) return;
		const next = ledger.waiting.shift();
		if (next === void 0) {
			ledger.held -= 1;
			if (ledger.held <= 0 && ledger.waiting.length === 0) this.ledgers.delete(key);
			return;
		}
		next.detach();
		next.resolve(this.mint(key));
	}
};
function abortReason(signal) {
	const reason = signal.reason;
	if (typeof reason === "string" && reason.length > 0) return reason;
	if (reason instanceof Error) return reason.message;
	return "这次派生被取消了";
}
/**
* 按父会话分组的时间轴记录。
*
* key 是**父会话 id**而不是 Vela 的 Run id：记录发生在队员起跑的路径上，那里手里
* 有的是父 agent，而父 agent 与会话是同一个身份。Board 侧按会话 id 关联回 Run。
*/
var TimelineRecorder = class {
	byParent = /* @__PURE__ */ new Map();
	/**
	* 记下一个队员起跑。
	*
	* 同一个 runId 重复上报时**忽略后来的那次**：起跑时刻只有第一次是真的，重复上报
	* 通常意味着上游重试了什么，而覆盖会让这条泳道的起点往后跳。
	*/
	start(parentSessionId, span) {
		const spans = this.byParent.get(parentSessionId) ?? [];
		if (spans.length === 0) this.byParent.set(parentSessionId, spans);
		if (spans.some((existing) => existing.runId === span.runId)) return;
		if (spans.length >= 64) return;
		spans.push({
			runId: span.runId,
			sessionId: span.sessionId,
			label: span.label,
			member: span.member,
			observedStart: span.at,
			observedEnd: void 0,
			stopReason: void 0
		});
	}
	/**
	* 记下一个队员结束。找不到对应的起跑就**什么也不做**——那意味着起跑发生在这个
	* 进程之前（ADR-0019：漏掉的起跑事件无法追补），凭空造一条没有起点的泳道会画出
	* 一个假的时间段。
	*/
	end(parentSessionId, runId, at, stopReason, summary) {
		const spans = this.byParent.get(parentSessionId);
		if (spans === void 0) return;
		const index = spans.findIndex((span) => span.runId === runId);
		if (index < 0) return;
		const span = spans[index];
		if (span.observedEnd !== void 0) return;
		spans[index] = {
			...span,
			observedEnd: at,
			stopReason,
			...summary === void 0 || summary.trim().length === 0 ? {} : { summary }
		};
	}
	/** 一个父会话的全部泳道，按观察到的起跑时刻升序。 */
	spansFor(parentSessionId) {
		const spans = this.byParent.get(parentSessionId);
		if (spans === void 0) return [];
		return [...spans].sort((left, right) => left.observedStart - right.observedStart);
	}
	/** 全部有记录的父会话 id。Board 视图据此只带上真的有泳道的那些。 */
	parents() {
		return [...this.byParent.keys()];
	}
	/** 丢掉一个父会话的记录。卡片被删时调，免得内存里攒下永远不会被看的泳道。 */
	forget(parentSessionId) {
		this.byParent.delete(parentSessionId);
	}
};
//#endregion
//#region src/squad-provider.ts
/** Vela 的后端名 = 原生名加这个前缀。 */
const VELA_PROVIDER_PREFIX = "vela-";
/** 被包装的原生后端名，按队员可选的后端一一对应。 */
const WRAPPED_PROVIDERS = ["spawn", "fork"];
/**
* 造一个带号牌闸门的 provider，行为与被包的那个逐字一致，只是起跑前要排队。
*
* **为什么是工厂函数而不是类。** DSH 靠 `prepareContinuable` 这个属性的**有无**
* 判断一个后端支不支持可继续子代理。类这条路上有两个坑，两个都踩过了：
* 写成原型方法则 `delete` 删不掉；写成可选类字段则 `useDefineForClassFields`
* 会把它定义成 `undefined`，`in` 照样为真。两种写法都会向 DSH 谎称支持，然后
* 在真的被调时失败——症状是后台委派的队员起不来。对象字面量的条件展开让
* 「有这个键」与「支持这件事」变成同一回事。
*/
function slottedProvider(inner, deps) {
	const forward = inner.prepareContinuable;
	return {
		name: `${VELA_PROVIDER_PREFIX}${inner.name}`,
		get capabilities() {
			return inner.capabilities;
		},
		get inheritsParentContext() {
			return inner.inheritsParentContext;
		},
		/**
		* 结束信号的两边都要还牌。`result` 只在基础设施故障时 reject，但那恰恰是最
		* 需要还牌的情形——出故障还握着牌，那支队会一次比一次慢。
		*
		* 时间轴的两个时刻也在这里打（ADR-0019）。**这里而不是去监 `subagent/start`
		* 事件**：那个事件的载荷里没有父会话 id（它靠监听器的 `this` 传，而那是
		* dsh 内部的 carrier key），而这里父 agent 直接在手。同时它天然只盖住走我们
		* 后端的派生，也就是小队队员——正是「只在有小队的 Run 上出现」那条要求。
		*/
		async start(request) {
			const quota = await deps.quotaFor(request.parent.ctx).catch((error) => {
				deps.logger?.warn(`vela: 查不到这次派生属于哪支队，本次不设号牌闸门：${describe$1(error)}`);
			});
			if (quota === void 0) return inner.start(request);
			const ticket = await deps.slots.acquire(quota.key, quota.limit, request.signal);
			let run;
			try {
				run = await inner.start(request);
			} catch (error) {
				ticket.release();
				throw error;
			}
			const record = beginRecord(request, run, quota, deps);
			run.result.then((result) => {
				ticket.release();
				record?.(stopReasonOf(result), summaryOf(result));
			}, (error) => {
				ticket.release();
				record?.("infrastructure-error");
				deps.logger?.warn(`vela: 一个队员异常终止：${describe$1(error)}`);
			});
			return run;
		},
		...forward === void 0 ? {} : { prepareContinuable: (request) => forward.call(inner, request) }
	};
}
/**
* 造出全部带号牌的 provider。
*
* 被包的原生 provider 不在时**跳过**而不是抛错：那意味着这个部署没装对应的
* 委派后端，小队只是少一种队员后端可选，看板其余部分照常。
*
* `prepareContinuable` 的有无由 {@link slottedProvider} 在构造时自己对齐，这里
* 不需要再做什么。
*/
function slottedProvidersFor(subagents, deps) {
	const out = [];
	for (const name of WRAPPED_PROVIDERS) {
		const inner = subagents.getProvider(name);
		if (inner === void 0) {
			deps.logger?.warn(`vela: 这个部署没有 ${name} 委派后端，小队里的 ${name} 队员将不可用`);
			continue;
		}
		out.push(slottedProvider(inner, deps));
	}
	return out;
}
/**
* 把号牌层挂上去，返回一个卸载函数。
*
* 注册重名会抛（DSH 的注册表拒绝重复 provider 名）。这里逐个 try：一个挂不上不
* 应该让另一个也挂不上，而且 HMR 时残留的旧注册正是最可能撞名的来源。
*/
function installSlottedProviders(subagents, deps) {
	const disposers = [];
	for (const provider of slottedProvidersFor(subagents, deps)) try {
		disposers.push(subagents.registerProvider(provider));
	} catch (error) {
		deps.logger?.warn(`vela: 挂不上委派后端 ${provider.name}：${describe$1(error)}`);
	}
	return () => {
		for (const dispose of disposers) try {
			dispose();
		} catch {}
	};
}
function describe$1(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* 开一条时间轴泳道，返回一个用来收尾的函数；记不了时返回 undefined。
*
* 记不了的情形全部是「缺了必需的身份」：没接记录器、拿不到父会话 id、拿不到
* 子会话 id。这三种下**什么也不记**，而不是造一条带占位符的泳道：一条点不进去的
* 泳道比没有那条泳道更坏。
*/
function beginRecord(request, run, quota, deps) {
	const sink = deps.timeline;
	const parentSessionId = request.parent.id;
	const sessionId = run.id;
	if (sink === void 0 || parentSessionId === void 0 || sessionId === void 0) return void 0;
	const now = deps.now ?? (() => Date.now());
	sink.start(parentSessionId, {
		runId: sessionId,
		sessionId,
		label: request.label ?? "（未写任务描述）",
		member: memberNameOf(request, quota),
		at: now()
	});
	return (stopReason, summary) => {
		sink.end(parentSessionId, sessionId, now(), stopReason, summary);
	};
}
/**
* 从职责说明反查队员名。
*
* 为什么只能这么反查：DSH 给 provider 的请求里**没有队员的工具名**。而 persona
* 正是我们自己写进组合文件的那段职责说明，因此能对回去。
*
* **优先读请求根上的 `persona`，而不是 `descriptor.persona`。** 一次真跑抓到了这个：
* one-shot 模式的 descriptor 快照里只有 version/mode/provider/label，没有 persona，
* 于是三条泳道的队员名全部反查失败。而队员必须是 one-shot（ADR-0018）。
*
* 两种查不到的情形，都返回 undefined 而不猜一个：队员没写职责（那时根本没有
* persona），以及两个队员职责完全相同（那时它们本来就无法区分）。泳道的主标签
* 是任务描述，队员名只是锦上添花，所以缺了不致命。
*/
function memberNameOf(request, quota) {
	const persona = (request.persona ?? request.descriptor?.persona)?.trim();
	if (persona === void 0 || persona.length === 0) return void 0;
	const candidates = (quota.members ?? []).filter((member) => member.instruction.trim().length > 0).filter((member) => {
		const own = member.instruction.trim();
		return persona === own || persona.startsWith(`${own}\n`);
	});
	if (candidates.length === 0) return void 0;
	const longest = Math.max(...candidates.map((member) => member.instruction.trim().length));
	const bests = candidates.filter((member) => member.instruction.trim().length === longest);
	return bests.length === 1 ? bests[0].name : void 0;
}
/**
* 从一次派生的结果里取停止原因。
*
* 形状很宽松地读：这是约定俗成的字段，而读不到它的后果只是泳道上少一个
* 标签，不该为此抛错。
*/
function stopReasonOf(result) {
	if (typeof result !== "object" || result === null) return void 0;
	const reason = result.stopReason;
	return typeof reason === "string" ? reason : void 0;
}
/** 总结最多留多长。它显示在泳道下方，不是报告全文——全文点泳道进会话看。 */
const SUMMARY_MAX = 280;
/**
* 从一次派生的结果里取队员的总结文本。
*
* SubagentResult.output 是队员最后一条非空助手消息的内容块。宽松地读：形状
* 不符时返回 undefined，泳道只是少一行总结，不该为此抛错。
*/
function summaryOf(result) {
	if (typeof result !== "object" || result === null) return void 0;
	const output = result.output;
	if (!Array.isArray(output)) return void 0;
	const text = output.map((block) => {
		if (typeof block !== "object" || block === null) return "";
		const candidate = block;
		return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
	}).join("\n").trim();
	if (text.length === 0) return void 0;
	return text.length > SUMMARY_MAX ? `${text.slice(0, 279)}…` : text;
}
//#endregion
//#region src/domain/usage.ts
/** 两份用量相加。 */
function addUsage(left, right) {
	return {
		inputTokens: left.inputTokens + right.inputTokens,
		outputTokens: left.outputTokens + right.outputTokens,
		cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
		cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
		reasoningTokens: left.reasoningTokens + right.reasoningTokens
	};
}
function count(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
/**
* 从一个未知形状的 usage 载荷里读出用量。返回 undefined 表示这条载荷
* 根本没带用量——调用方据此跳过，而不是累加一份全零。
*/
function readUsage(payload) {
	if (typeof payload !== "object" || payload === null) return void 0;
	const usage = payload.usage;
	if (typeof usage !== "object" || usage === null) return void 0;
	const fields = usage;
	if (![
		"inputTokens",
		"outputTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
		"reasoningTokens"
	].some((key) => typeof fields[key] === "number")) return void 0;
	return {
		inputTokens: count(fields.inputTokens),
		outputTokens: count(fields.outputTokens),
		cacheReadTokens: count(fields.cacheReadTokens),
		cacheWriteTokens: count(fields.cacheWriteTokens),
		reasoningTokens: count(fields.reasoningTokens)
	};
}
//#endregion
//#region src/domain/outcome.ts
/** DSH 已知的结束原因 kind。 */
const KNOWN = {
	"completed": "completed",
	"aborted": "aborted",
	"blocked": "blocked",
	"error": "error",
	"max-tokens": "max-tokens",
	"interrupted": "interrupted"
};
/** 每个失败结局的默认说明，供载荷没给细节时使用。 */
const DEFAULT_FAILURE = {
	"completed": "",
	"aborted": "执行被取消",
	"blocked": "执行被阻塞",
	"error": "执行出错",
	"max-tokens": "达到 token 上限",
	"interrupted": "执行被中断",
	"timeout": "执行超时"
};
/** 这个结局对应的默认失败说明。 */
function defaultFailure(outcome) {
	return DEFAULT_FAILURE[outcome];
}
function text(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
/**
* 解析一条 `turn/end` 的 data 载荷。
* @param data - 事件载荷，形状未经校验。
* @returns 结局与失败说明；载荷完全无法辨认时归为 error。
*/
function parseTurnEnd(data) {
	const reason = typeof data === "object" && data !== null ? data.reason : void 0;
	const kind = typeof reason === "object" && reason !== null ? text(reason.kind) : void 0;
	const outcome = kind === void 0 ? "error" : KNOWN[kind] ?? "error";
	if (outcome === "completed") return { outcome };
	const detail = typeof reason === "object" && reason !== null ? reason : void 0;
	const error = detail?.error;
	const parts = [];
	if (typeof error === "object" && error !== null) {
		const fields = error;
		const code = text(fields.code);
		const message = text(fields.message);
		if (code !== void 0) parts.push(code);
		if (message !== void 0) parts.push(message);
	}
	const bare = text(detail?.reason);
	if (parts.length === 0 && bare !== void 0) parts.push(bare);
	if (kind !== void 0 && KNOWN[kind] === void 0) parts.unshift(`未知结束原因 ${kind}`);
	return {
		outcome,
		failure: parts.length === 0 ? DEFAULT_FAILURE[outcome] : parts.join(": ")
	};
}
/** 展开的正文合计最多多少字符。 */
const RECALL_CHAR_BUDGET = 4e3;
/** 一次都没挑到。 */
const EMPTY = {
	indexed: [],
	expanded: [],
	text: "",
	injectedChars: 0,
	sourceChars: 0
};
/**
* 挑出这次要召回的复盘。
*
* @param candidates - 记忆库里的全部复盘。
* @param workspace - 这次派活的工作区；只挑同一个的（不做跨工作区召回）。
* @param now - 判定陈旧用的当前时刻。
*/
function selectRecall(candidates, workspace, now) {
	const eligible = candidates.filter((candidate) => candidate.workspace === workspace).filter((candidate) => candidate.status === "stable" && candidate.trust === "human-reviewed").filter((candidate) => !isStale(candidate.staleAfter, now)).sort(byNewestReview);
	if (eligible.length === 0) return EMPTY;
	const indexed = eligible.slice(0, 10);
	const expanded = [];
	const bodies = [];
	let used = 0;
	for (const candidate of indexed) {
		if (expanded.length >= 2) break;
		const insight = insightOf(candidate.body);
		if (insight.length === 0) continue;
		const room = RECALL_CHAR_BUDGET - used;
		if (room <= 0) break;
		const clipped = clipToParagraph(insight, room);
		if (clipped.length === 0) break;
		expanded.push(candidate);
		bodies.push(clipped);
		used += clipped.length;
	}
	const text = render(indexed, expanded, bodies);
	return {
		indexed,
		expanded,
		text,
		injectedChars: text.length,
		sourceChars: indexed.reduce((total, candidate) => total + candidate.body.length, 0)
	};
}
/** 人审得越晚越靠前；没有人审时间的排在最后。 */
function byNewestReview(left, right) {
	return (right.verifiedAt ?? "").localeCompare(left.verifiedAt ?? "");
}
/**
* 一篇复盘里值得注入的部分：去掉客观足迹那一段。
*
* 足迹是账本——读了几次文件、跑了哪些命令。它对 Operator 有用（可核对），
* 对下一次执行没用，而它往往比洞见还长。**注入洞见，不注入账本。**
*/
function insightOf(body) {
	const at = body.indexOf(SECTION_FACTS);
	return (at === -1 ? body : body.slice(0, at)).trim();
}
/**
* 截到预算内，且切在段落边界上。
*
* 硬切在半句话上会让被注入的经验读起来像坏掉的数据，Agent 也可能照着半句话
* 去理解。切不出任何完整段落时返回空串——一段都放不下就不如不放。
*/
function clipToParagraph(text, budget) {
	if (text.length <= budget) return text;
	const NOTE = "\n\n（这篇已截断）";
	const room = budget - 9;
	if (room <= 0) return "";
	const head = text.slice(0, room);
	const cut = head.lastIndexOf("\n\n");
	if (cut <= 0) return "";
	return `${head.slice(0, cut).trim()}${NOTE}`;
}
/** 拼出要注入的那一段。 */
function render(indexed, expanded, bodies) {
	const lines = ["## 以前的经验", ""];
	lines.push(`这个工作区里经人验收过的复盘（${indexed.length} 篇）：`, "");
	for (const candidate of indexed) {
		const when = candidate.verifiedAt === void 0 ? "" : `（${candidate.verifiedAt.slice(0, 10)}）`;
		lines.push(`- ${candidate.title}${when}`);
	}
	if (expanded.length > 0) {
		lines.push("", `其中 ${expanded.length} 篇的正文如下；其余只列了标题，需要时可以自己去记忆库里读。`);
		for (const [at, candidate] of expanded.entries()) lines.push("", `### ${candidate.title}`, "", bodies[at]);
	}
	return lines.join("\n");
}
//#endregion
//#region src/runner.ts
/**
* 展开能力白名单用的平台。队长的开场名册要括号列出每个队员可用的工具，
* 而那张表按平台分叉（`pwsh` / `bash`）。这里读一次就好：进程跑到一半不会换
* 操作系统。
*/
const PLATFORM = process.platform;
/**
* 取消之后等待真正结束的宽限。`cancel` 返回不等于执行已结束，但也不能无限
* 等——若宽限内没等到 turn/end，就按超时强制结算，免得卡片永远停在 Running。
*/
const CANCEL_GRACE_MS = 3e4;
/**
* 读文件的工具叫什么。
*
* 取证自真跑日志（票 01）：工具名 `read`，文件路径在参数的 `file_path` 键上。
* 写文件的工具名尚未取证，因此「写次数」按「除 read 外带 file_path 的调用」统计。
*/
const READ_TOOL = "read";
/** 命令最多记几条。一次执行跑上百条命令时，全记下来只会把复盘淡成日志。 */
const MAX_COMMANDS = 20;
/** 一条命令最多留多长。 */
const COMMAND_CLIP = 200;
/** 对账出来的中断执行的失败说明。两处用到（快照与复盘），口径必须一致。 */
const INTERRUPTED_FAILURE = "上一次进程结束时这次执行仍在进行，结果未知";
/**
* Run 执行器。拥有全部在途 Run 的生命周期，`dispose` 后不留计时器。
*/
var Runner = class {
	deps;
	/** sessionId → 在途 Run。会话事件按此路由。 */
	inFlight = /* @__PURE__ */ new Map();
	/** issueId → 正在进行的派活，防止同一 Issue 并发派活建出孤儿会话。 */
	dispatching = /* @__PURE__ */ new Map();
	/**
	* 全局派活链尾。每次派活整体挂在前一次之后。
	*
	* 为什么要全局串行而不只按 Issue 串行：并发上限的检查读的是快照里
	* 「现在几个在跑」。两张**不同**的卡同时派活时，两边都会读到同一个
	* 低于上限的数，然后都建会话——上限就漏了。派活是人手动触发的、
	* 每次只有几十毫秒，串行的代价远小于把计数器写对的难度。
	*/
	admissionTail = Promise.resolve();
	disposed = false;
	constructor(deps) {
		this.deps = deps;
	}
	/** 当前持有活 Run 的 Issue 数——快照是权威的，与 Operator 在 Running 列里看到的一致。 */
	runningCount() {
		return this.deps.store.snapshot().issues.filter((issue) => activeRun(issue) !== void 0).length;
	}
	/** 某个 Issue 当前在途 Run 的实时用量；无在途 Run 时 undefined。 */
	liveUsage(issueId) {
		for (const entry of this.inFlight.values()) if (entry.issueId === issueId) return entry.usage;
	}
	/** 全部在途 Run 的实时用量，按 Issue 索引，供 Board 一次取齐。 */
	liveUsageByIssue() {
		const out = {};
		for (const entry of this.inFlight.values()) if (entry.usage !== void 0) out[entry.issueId] = entry.usage;
		return out;
	}
	/**
	* 派活：为一个 Issue 起一个 Run。同一 Issue 的并发调用被串行化，因此
	* 「已有活 Run」这个前置检查是权威的，不会先建好会话再发现建不了 Run。
	*/
	async dispatch(issueId) {
		const pending = this.dispatching.get(issueId);
		if (pending !== void 0) await pending.catch(() => void 0);
		const attempt = this.enqueue(() => this.dispatchOnce(issueId)).finally(() => {
			this.dispatching.delete(issueId);
		});
		this.dispatching.set(issueId, attempt);
		return attempt;
	}
	/** 把一次派活排到全局链尾。上一次失败不能卡住下一次。 */
	enqueue(task) {
		const next = this.admissionTail.then(task, task);
		this.admissionTail = next.catch(() => void 0);
		return next;
	}
	async dispatchOnce(issueId) {
		if (this.disposed) return {
			ok: false,
			code: "conflict",
			message: "vela is shutting down"
		};
		const api = this.deps.apiProxy();
		if (api === void 0) return {
			ok: false,
			code: "conflict",
			message: "this profile mounts no apiProxy, so Vela cannot dispatch a Run"
		};
		const issue = this.deps.store.snapshot().issues.find((candidate) => candidate.id === issueId);
		if (issue === void 0) return {
			ok: false,
			code: "not-found",
			message: `issue ${issueId} not found`
		};
		if (activeRun(issue) !== void 0) return {
			ok: false,
			code: "conflict",
			message: `issue ${issueId} already has a running Run`
		};
		const cap = this.deps.maxConcurrentRuns();
		if (Number.isInteger(cap) && cap >= 0) {
			const running = this.runningCount();
			if (running >= cap) return {
				ok: false,
				code: "conflict",
				message: cap === 0 ? "dispatching is paused: the concurrent Run limit is 0" : `already running ${running} of at most ${cap} Runs; wait for one to finish`
			};
		}
		const presets = this.deps.permissionPresets();
		const invalid = validateOverrides(issue.exec, presets?.names ?? []);
		if (invalid !== void 0) return {
			ok: false,
			code: "invalid",
			message: invalid
		};
		const exec = resolveExec(issue.exec, this.deps.defaults);
		let squad;
		if (issue.exec.squad !== void 0) {
			const squads = this.deps.squads();
			if (squads === void 0) return {
				ok: false,
				code: "conflict",
				message: "这个部署没有小队能力，这张卡却指定了小队"
			};
			const found = await squads.read(issue.exec.squad);
			if (!found.ok) return {
				ok: false,
				code: found.code === "not-found" ? "not-found" : "invalid",
				message: `小队 ${issue.exec.squad} 用不了：${found.message}`
			};
			squad = found.value;
		}
		const sandbox = issue.exec.sandbox ?? squad?.sandbox ?? exec.sandbox;
		const agentPreset = squad?.id ?? exec.agentPreset;
		const created = await api.sessions.create({
			rpcId: this.deps.newId(),
			payload: {
				cwd: issue.workspace,
				...agentPreset === void 0 ? {} : { agentPreset }
			}
		});
		if (!created.result.ok) return {
			ok: false,
			code: created.result.error.code === "session-conflict" ? "conflict" : "invalid",
			message: `cannot create a session: ${created.result.error.code}: ${created.result.error.message}`
		};
		const { sessionId } = created.result.value;
		const runId = this.deps.newId();
		let recorded;
		await this.deps.store.mutate((board) => {
			const result = startRun(board, issueId, {
				id: runId,
				sessionId
			}, this.deps.now());
			recorded = result;
			return result.ok ? {
				board: result.value,
				value: void 0
			} : void 0;
		});
		if (recorded === void 0 || !recorded.ok) {
			this.deps.logger?.warn(`vela: session ${sessionId} was created but the Run could not be recorded; it is left idle and harmless`);
			return recorded ?? {
				ok: false,
				code: "conflict",
				message: "the Run could not be recorded"
			};
		}
		const entry = {
			issueId,
			runId,
			sessionId,
			startedAt: this.deps.now(),
			squadId: squad?.id,
			usage: void 0,
			files: /* @__PURE__ */ new Map(),
			commands: [],
			lastText: void 0,
			recall: void 0,
			timedOut: false,
			timeout: void 0,
			grace: void 0
		};
		this.inFlight.set(sessionId, entry);
		if (sandbox !== void 0) {
			const applied = this.applySandbox(sessionId, sandbox);
			if (applied !== void 0) {
				await this.settle(sessionId, "error", `cannot apply permission preset: ${applied}`);
				return {
					ok: false,
					code: "invalid",
					message: applied
				};
			}
		}
		const renamed = await api.sessions.rename({
			rpcId: this.deps.newId(),
			payload: {
				sessionId,
				title: issue.title
			}
		});
		if (!renamed.result.ok) this.deps.logger?.warn(`vela: cannot title session ${sessionId}: ${renamed.result.error.message}`);
		const recalled = await this.prepareRecall(issue);
		if (recalled !== void 0) entry.recall = {
			indexed: recalled.indexed.length,
			expanded: recalled.expanded.length,
			injectedChars: recalled.injectedChars,
			sourceChars: recalled.sourceChars
		};
		const prompted = await api.sessions.prompt({
			rpcId: this.deps.newId(),
			payload: {
				sessionId,
				mode: "queue",
				content: [{
					type: "text",
					text: buildPrompt(issue, squad, void 0, {
						closing: this.deps.memory?.() !== void 0,
						...recalled === void 0 || recalled.text.length === 0 ? {} : { recall: recalled.text }
					})
				}]
			}
		}).catch((error) => ({
			rpcId: "",
			result: {
				ok: false,
				error: {
					code: "internal",
					message: String(error)
				}
			}
		}));
		if (!prompted.result.ok) {
			const message = `${prompted.result.error.code}: ${prompted.result.error.message}`;
			await this.settle(sessionId, "error", `cannot submit the task: ${message}`);
			return {
				ok: false,
				code: "conflict",
				message
			};
		}
		if (exec.timeoutMs > 0) entry.timeout = this.deps.setTimer(() => {
			this.onTimeout(sessionId);
		}, exec.timeoutMs);
		if (recalled !== void 0 && recalled.expanded.length > 0) {
			const memory = this.deps.memory?.();
			const at = this.deps.now();
			for (const used of recalled.expanded) await memory?.countUse(used.path, at).catch((error) => {
				this.deps.logger?.warn(`vela: 引用计数没写上（${used.path}）：${error instanceof Error ? error.message : String(error)}`);
			});
		}
		return {
			ok: true,
			value: {
				issueId,
				runId,
				sessionId
			}
		};
	}
	/**
	* 读出这次要注入的召回。没配记忆库、读不到、或一个候选也没有时给 undefined。
	*
	* 读失败**不报错**：召回不成应当退化成「这次没带经验」，而不是让 Operator
	* 派不了活。记忆是锦上添花，不是派活的前置条件。
	*/
	async prepareRecall(issue) {
		const memory = this.deps.memory?.();
		if (memory === void 0) return void 0;
		try {
			const recall = selectRecall(await memory.recallCandidates(), issue.workspace, this.deps.now());
			return recall.indexed.length === 0 ? void 0 : recall;
		} catch (error) {
			this.deps.logger?.warn(`vela: 召回读不成，这次不带经验：${error instanceof Error ? error.message : String(error)}`);
			return;
		}
	}
	/** 施加权限档位。返回错误说明，或 undefined 表示成功。 */
	applySandbox(sessionId, preset) {
		const presets = this.deps.permissionPresets();
		if (presets === void 0) return "this profile mounts no permissionPresets service";
		const session = this.deps.sessions()?.get(sessionId);
		if (session === void 0) return `session ${sessionId} is not attached, so its permission cannot be set`;
		try {
			presets.set(session, preset);
			return;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}
	/**
	* 消费一条会话事件。认三类：assistant/message 累计用量并留下正文，
	* tool/call 记下足迹，turn/end 结算。与本执行器无关的会话原样忽略——这是
	* 宿主的全局事件流。
	*/
	observe(sessionId, event) {
		const entry = this.inFlight.get(sessionId);
		if (entry === void 0) return;
		if (event.type === "assistant/message") {
			const usage = readUsage(event.data);
			if (usage !== void 0) entry.usage = entry.usage === void 0 ? usage : addUsage(entry.usage, usage);
			const text = assistantText(event.data);
			if (text.length > 0) entry.lastText = text;
			return;
		}
		if (event.type === "tool/call") {
			noteToolCall(entry, event.data);
			return;
		}
		if (event.type !== "turn/end") return;
		const end = parseTurnEnd(event.data);
		const outcome = entry.timedOut && end.outcome !== "completed" ? "timeout" : end.outcome;
		const failure = outcome === "completed" ? void 0 : entry.timedOut ? defaultFailure("timeout") : end.failure ?? defaultFailure(outcome);
		this.settleDetached(sessionId, outcome, failure);
	}
	/** 取消一个 Issue 正在进行的 Run。 */
	async cancel(issueId) {
		const entry = [...this.inFlight.values()].find((candidate) => candidate.issueId === issueId);
		if (entry === void 0) return {
			ok: false,
			code: "not-found",
			message: `issue ${issueId} has no Run in flight`
		};
		await this.requestCancel(entry, "aborted");
		return {
			ok: true,
			value: { sessionId: entry.sessionId }
		};
	}
	async onTimeout(sessionId) {
		const entry = this.inFlight.get(sessionId);
		if (entry === void 0) return;
		entry.timedOut = true;
		await this.requestCancel(entry, "timeout");
	}
	/**
	* 请求停止一次执行，然后**等待真正结束**。取消调用返回不代表执行已结束，
	* 因此这里只开一个有界宽限：等到 turn/end 就走正常结算，等不到就强制结算，
	* 免得卡片永远停在 Running。
	*/
	async requestCancel(entry, reason) {
		if (entry.squadId !== void 0) {
			const dropped = this.deps.slots?.().drainWaiting(entry.squadId, `这张卡已经被${reason === "timeout" ? "超时中断" : "取消"}了`);
			if (dropped !== void 0 && dropped > 0) this.deps.logger?.info(`vela: 丢掉了 ${entry.squadId} 还在排队的 ${dropped} 个队员`);
		}
		const api = this.deps.apiProxy();
		if (api === void 0) {
			await this.settle(entry.sessionId, reason, defaultFailure(reason));
			return;
		}
		try {
			await api.sessions.cancel({
				rpcId: this.deps.newId(),
				payload: { sessionId: entry.sessionId }
			});
		} catch (error) {
			this.deps.logger?.warn(`vela: cancel of session ${entry.sessionId} failed: ${String(error)}`);
		}
		if (entry.grace !== void 0) return;
		entry.grace = this.deps.setTimer(() => {
			this.settleDetached(entry.sessionId, reason, `${defaultFailure(reason)}（未在宽限内收到结束事件）`);
		}, CANCEL_GRACE_MS);
	}
	/**
	* 把一次结算发出去但不等它（调用方在事件回调里，无处可 await）。
	*
	* 必须自己接住异常：结算要写盘，而写盘会真的失败（盘满、权限、目录
	* 被拿掉）。裸的 `void this.settle(...)` 会把那种失败变成未处理的 promise
	* 异常——在 Node 里默认会终止进程，也就是一张卡片没落盘把整个 dsh 拖下水。
	* 卡片停在 Running 很难看，但比提前退出强得多。
	*/
	settleDetached(sessionId, outcome, failure) {
		this.settle(sessionId, outcome, failure).catch((error) => {
			this.deps.logger?.warn(`vela: cannot settle session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
		});
	}
	/**
	* 结算一次 Run 并落盘。幂等：重复结算同一个 Run 是无操作，因为 turn/end
	* 与宽限计时器都可能到达。
	*/
	async settle(sessionId, outcome, failure) {
		const entry = this.inFlight.get(sessionId);
		if (entry === void 0) return;
		this.forget(sessionId);
		const usage = entry.usage;
		await this.deps.store.mutate((board) => {
			const result = settleRun(board, entry.issueId, {
				runId: entry.runId,
				outcome,
				...failure === void 0 ? {} : { failure },
				...usage === void 0 ? {} : { usage }
			}, this.deps.now());
			return result.ok ? {
				board: result.value,
				value: void 0
			} : void 0;
		});
		await this.landRecap(entry, outcome, failure).catch((error) => {
			this.deps.logger?.warn(`vela: 复盘没落盘（issue ${entry.issueId}）：${error instanceof Error ? error.message : String(error)}`);
		});
		if (outcome === "completed") return;
		const issue = this.deps.store.snapshot().issues.find((candidate) => candidate.id === entry.issueId);
		if (issue !== void 0 && shouldAutoRetry(issue)) {
			this.deps.logger?.info(`vela: retrying issue ${issue.id} (attempt ${issue.runs.length + 1} of ${issue.maxAttempts + 1})`);
			await this.dispatch(issue.id).catch(() => void 0);
		}
	}
	forget(sessionId) {
		const entry = this.inFlight.get(sessionId);
		if (entry === void 0) return;
		if (entry.timeout !== void 0) this.deps.clearTimer(entry.timeout);
		if (entry.grace !== void 0) this.deps.clearTimer(entry.grace);
		this.inFlight.delete(sessionId);
	}
	/**
	* 把这次执行落成一篇复盘。没配记忆库时直接返回，一行也不执行。
	*
	* 正文只在**成功收尾**时取 Agent 的交付（ADR-0026）：失败与中断的执行
	* 收尾回复常常只有半句话或根本没有，拿它当经验会污染召回。
	*/
	async landRecap(entry, outcome, failure) {
		const memory = this.deps.memory?.();
		if (memory === void 0) return;
		const issue = this.deps.store.snapshot().issues.find((candidate) => candidate.id === entry.issueId);
		if (issue === void 0) return;
		const at = this.deps.now();
		const seq = issue.runs.findIndex((run) => run.id === entry.runId);
		const facts = {
			issueNumber: issue.number,
			runSeq: seq < 0 ? issue.runs.length : seq + 1,
			sessionId: entry.sessionId,
			workspace: issue.workspace,
			title: issue.title,
			outcome,
			...failure === void 0 ? {} : { failure },
			startedAt: entry.startedAt,
			endedAt: at,
			...entry.usage === void 0 ? {} : { usage: entry.usage },
			files: touchedFiles(entry),
			commands: [...entry.commands],
			...entry.recall === void 0 ? {} : { recall: entry.recall }
		};
		const delivery = outcome === "completed" && entry.lastText !== void 0 ? extractDelivery(entry.lastText) : void 0;
		await memory.landRecap(facts, delivery, at);
	}
	/**
	* 启动时对账。上次进程被杀时停在 running 的 Run 不会自己结束——没有这一步
	* 那些卡片会永远停在 Running。它们的用量已随进程丢失，因此**不写用量**：
	* 缺失表示未知，不伪造成 0（ADR-0011）。
	*
	* 同样会落一篇**只有客观部分**的复盘（ADR-0026）：这次执行的足迹与正文都随
	* 进程没了，但「这张卡曾经跑过一次、结果未知」本身就是值得留下的事实。
	*/
	async reconcile() {
		const stale = this.deps.store.snapshot().issues.flatMap((issue) => issue.runs.filter((run) => run.status === "running" && !this.inFlight.has(run.sessionId)).map((run) => ({
			issue,
			run,
			runSeq: issue.runs.indexOf(run) + 1
		})));
		if (stale.length === 0) return;
		this.deps.logger?.info(`vela: settling ${stale.length} Run(s) left running by a previous process`);
		for (const { issue, run, runSeq } of stale) {
			await this.deps.store.mutate((board) => {
				const result = settleRun(board, issue.id, {
					runId: run.id,
					outcome: "interrupted",
					failure: INTERRUPTED_FAILURE
				}, this.deps.now());
				return result.ok ? {
					board: result.value,
					value: void 0
				} : void 0;
			});
			await this.landInterrupted(issue, run, runSeq).catch((error) => {
				this.deps.logger?.warn(`vela: 对账出的复盘没落盘（issue ${issue.id}）：${error instanceof Error ? error.message : String(error)}`);
			});
		}
	}
	/**
	* 给一条对账出来的中断执行落一篇客观复盘。
	*
	* 足迹是空的而不是伪造的：那些计数只活在上一个进程的内存里，现在无处可取。
	*/
	async landInterrupted(issue, run, runSeq) {
		const memory = this.deps.memory?.();
		if (memory === void 0) return;
		await memory.landRecap({
			issueNumber: issue.number,
			runSeq,
			sessionId: run.sessionId,
			workspace: issue.workspace,
			title: issue.title,
			outcome: "interrupted",
			failure: INTERRUPTED_FAILURE,
			startedAt: run.startedAt,
			endedAt: this.deps.now(),
			files: [],
			commands: []
		}, void 0, this.deps.now());
	}
	/** 清理全部计时器。在途 Run 留在快照里，下次启动由 reconcile 结算。 */
	dispose() {
		this.disposed = true;
		for (const sessionId of [...this.inFlight.keys()]) this.forget(sessionId);
	}
};
/**
* 一条 assistant 消息里的全部文本块拼起来。
*
* 只取 `type === 'text'` 的块：同一条消息里还会有 reasoning 与 tool-call 块
* （票 01 取证），前者是思考过程、后者是调用参数，那两样都不是交付。
*/
function assistantText(data) {
	const blocks = data?.message?.content;
	if (blocks === void 0) return "";
	const texts = [];
	for (const block of blocks) if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
	return texts.join("\n").trim();
}
/**
* 记下一次工具调用的足迹。
*
* 参数读不懂时安静跳过：足迹是尽力而为的记录，少一条比把整次执行弄崩好。
* “写”的判定是「除 read 外带 file_path 的调用」——写文件的工具名尚未取证（票 01）。
*/
function noteToolCall(entry, data) {
	const name = data?.name;
	if (typeof name !== "string" || name.length === 0) return;
	let args = {};
	if (typeof data?.arguments === "string") try {
		const parsed = JSON.parse(data.arguments);
		if (typeof parsed === "object" && parsed !== null) args = parsed;
	} catch {}
	const path = args.file_path;
	if (typeof path === "string" && path.length > 0) {
		const touch = entry.files.get(path) ?? {
			reads: 0,
			writes: 0
		};
		if (name === READ_TOOL) touch.reads += 1;
		else touch.writes += 1;
		entry.files.set(path, touch);
	}
	const command = args.command;
	if (typeof command === "string" && command.length > 0 && entry.commands.length < MAX_COMMANDS) entry.commands.push(command.length > COMMAND_CLIP ? `${command.slice(0, COMMAND_CLIP)}…` : command);
}
/** 在途状态里的文件足迹整理成确定顺序的清单。 */
function touchedFiles(entry) {
	return [...entry.files].map(([path, touch]) => ({
		path,
		reads: touch.reads,
		writes: touch.writes
	})).sort((left, right) => left.path.localeCompare(right.path));
}
/**
* 附在派活文本末尾的收尾要求（ADR-0021 / ADR-0027）。
*
* 最后一句是必要的：把「你无权宣布自己可信」直接告诉 Agent，比等它写了
* 再在解析时默默丢掉要诚实——两头都做，但只靠后者会让它反复写一个没用的字段。
*/
const CLOSING_REQUIREMENT = [
	"## 收尾要求",
	"",
	"做完之后，在你最后一条消息里附一个 `vela-recap` 围栏块，按下面三个小标题分段：",
	"",
	"```vela-recap",
	"## 结论",
	"（这次的结果，一两句话）",
	"## 做了什么",
	"（关键改动）",
	"## 坑与注意",
	"（下一个人该知道的事；没有就写「无」）",
	"```",
	"",
	"这段会被存进记忆库，经人验收后成为以后派活时的参考。不要在块里写状态或验收字段——那由验收决定，不由你声明。"
].join("\n");
/**
* 交给 Agent 的任务文本。标题是要做的事，描述是补充，两者都原样给出。
*
* 普通卡不包装任何指令——Agent 的行为应由 preset 决定，不由 Vela 悄悄注入。
* **两处刻意的例外**：派给小队的卡前置队长职责与名册（接缝形状逼的，详见
* `leaderInstruction`）；开了记忆库时附一段收尾要求（ADR-0027）。两者都带明确标题
* 并用分隔线隔开，因此“哪一段是 Vela 加的”对人和 Agent 都看得出来。
*
* @param squad - 派给的小队；缺省表示这张卡没指定小队。
* @param platform - 展开能力白名单用的平台；缺省用当前进程的。
* @param options - 额外要附上的段落。
*/
function buildPrompt(issue, squad, platform, options) {
	const description = issue.description.trim();
	const task = description.length === 0 ? issue.title : `${issue.title}\n\n${description}`;
	const sections = [];
	if (squad !== void 0) {
		const briefing = leaderInstruction(squad, platform ?? PLATFORM).trim();
		if (briefing.length > 0) sections.push(briefing);
	}
	if (options?.recall !== void 0 && options.recall.length > 0) sections.push(options.recall);
	if (options?.closing === true) sections.push(CLOSING_REQUIREMENT);
	if (sections.length === 0) return task;
	return `${sections.join("\n\n---\n\n")}\n\n---\n\n## 本次的任务\n\n${task}`;
}
/**
* 把宿主的全局会话事件流接到观察者上。会话 id 从事件伴随的 session 对象的
* header 上读——Vela 不解释 session 的其余结构。
*/
function observeSessions(on, observer) {
	return on((session, event) => {
		const id = sessionIdOf(session);
		if (id !== void 0) observer.observe(id, event);
	});
}
function sessionIdOf(session) {
	if (typeof session !== "object" || session === null) return void 0;
	const header = session.header;
	if (typeof header !== "object" || header === null) return void 0;
	const id = header.id;
	return typeof id === "string" ? id : void 0;
}
//#endregion
//#region src/domain/okf-bundle.ts
/** 信任等级的一眼可读标记。文字而非图标：索引也会被 Agent 读到。 */
function trustMark(trust) {
	switch (trust) {
		case "human-reviewed": return "人审过";
		case "machine-confirmed": return "机器确认";
		default: return "未验证";
	}
}
/**
* 知识包的根索引。
*
* 只到 Workspace 一层就停：往下是每个 Workspace 自己的索引。这就是 OKF 的
* 渐进披露——读的人（人或 Agent）先看到极小的一张目录，再决定展开哪一层。
*/
function buildRootIndex(groups, at) {
	const frontmatter = /* @__PURE__ */ new Map([
		["type", "Index"],
		["title", "Vela 记忆库"],
		["description", "每次执行结束落一篇复盘；信任等级由验收闸门裁定。"],
		["okf_version", "0.2"],
		["generated", { at: new Date(at).toISOString() }]
	]);
	const lines = ["# Vela 记忆库", ""];
	if (groups.length === 0) lines.push("（还没有任何复盘。）");
	else {
		lines.push("| 工作区 | 篇数 | 人审过 | 索引 |", "| --- | --- | --- | --- |");
		for (const group of groups) {
			const reviewed = group.entries.filter((entry) => entry.trust === "human-reviewed").length;
			lines.push(`| \`${group.workspace}\` | ${group.entries.length} | ${reviewed} | [${group.slug}](./runs/${group.slug}/index.md) |`);
		}
	}
	return serializeDocument({
		frontmatter,
		body: lines.join("\n")
	});
}
/**
* 一个 Workspace 的索引。
*
* 排序：人审过的在前、同组内新的在前。索引本身就是召回时最先注入的东西，
* 顺序即优先级。
*/
function buildWorkspaceIndex(group, at) {
	const frontmatter = /* @__PURE__ */ new Map([
		["type", "Index"],
		["title", `记忆：${group.workspace}`],
		["description", `${group.entries.length} 篇复盘`],
		["generated", { at: new Date(at).toISOString() }]
	]);
	const lines = [`# 记忆：${group.workspace}`, ""];
	const sorted = [...group.entries].sort(compareEntries);
	if (sorted.length === 0) lines.push("（这个工作区还没有复盘。）");
	else for (const entry of sorted) {
		const marks = [trustMark(entry.trust)];
		if (entry.status === "deprecated") marks.push("已废弃");
		if (entry.stale) marks.push("已陈旧");
		const when = entry.generatedAt === void 0 ? "" : ` · ${entry.generatedAt.slice(0, 10)}`;
		lines.push(`- [${entry.title}](../../${entry.path}) — ${marks.join(" · ")}${when}`);
	}
	return serializeDocument({
		frontmatter,
		body: lines.join("\n")
	});
}
/** 人审过的在前，其次新的在前。 */
function compareEntries(left, right) {
	const weight = (entry) => entry.trust === "human-reviewed" ? 0 : 1;
	const byTrust = weight(left) - weight(right);
	if (byTrust !== 0) return byTrust;
	return (right.generatedAt ?? "").localeCompare(left.generatedAt ?? "");
}
/** 更新历史的标题。 */
const LOG_TITLE = "# 更新历史";
/** 一份空的更新历史。 */
function emptyLog(at) {
	return serializeDocument({
		frontmatter: /* @__PURE__ */ new Map([
			["type", "Log"],
			["title", "Vela 记忆库的更新历史"],
			["generated", { at: new Date(at).toISOString() }]
		]),
		body: LOG_TITLE
	});
}
/**
* 往更新历史里追加一行，新的在前。
*
* 已存在的文件读不懂时**不覆盖**，而是抛错交给上层——更新历史是唯一重算
* 不出来的东西，把它整份重写等于把「发生过什么」抹掉。
*
* @param existing - 现有文件内容；`undefined` 表示还没有这个文件。
* @param line - 要记的一句话，不带列表标记。
* @param at - 这件事发生的时刻。
*/
function appendLogEntry(existing, line, at) {
	const { frontmatter, body } = parseDocument(existing === void 0 || existing.trim().length === 0 ? emptyLog(at) : existing);
	const stamp = toDateStamp(at);
	const bullet = `- ${new Date(at).toISOString().slice(11, 16)} ${line}`;
	const lines = body.split("\n");
	const heading = `## ${stamp}`;
	const existingDay = lines.findIndex((current) => current.trim() === heading);
	if (existingDay !== -1) {
		let insertAt = existingDay + 1;
		while (insertAt < lines.length && lines[insertAt].trim().length === 0) insertAt += 1;
		lines.splice(insertAt, 0, bullet);
		return serializeDocument({
			frontmatter,
			body: lines.join("\n")
		});
	}
	const titleAt = lines.findIndex((current) => current.trim() === LOG_TITLE);
	const insertAt = titleAt === -1 ? 0 : titleAt + 1;
	lines.splice(insertAt, 0, "", heading, "", bullet);
	return serializeDocument({
		frontmatter,
		body: lines.join("\n")
	});
}
/** 一篇 Recap 落盘时记的那句话。 */
function loggedLanded(path, runSeq, outcome) {
	return `落下 \`${path}\`（第 ${runSeq} 次执行，${outcome}）`;
}
/** 一篇 Recap 被人审过时记的那句话。 */
function loggedVerified(path, actor) {
	return `\`${path}\` 经 ${actor} 验收`;
}
/** 一篇 Recap 被标废弃时记的那句话。 */
function loggedDeprecated(path, why) {
	return `\`${path}\` 标为废弃（${why}）`;
}
/** 一篇 Recap 被删掉时记的那句话。删除必须留痕（票 06）。 */
function loggedRemoved(path, actor) {
	return `\`${path}\` 被 ${actor} 删除`;
}
/** 读出更新历史里的全部条目，最新的在前。给记忆页用。 */
function readLogLines(text) {
	let body;
	try {
		body = parseDocument(text).body;
	} catch {
		return [];
	}
	return body.split("\n").filter((line) => line.trimStart().startsWith("- ")).map((line) => line.trim().slice(2));
}
/** 索引文件在知识包里的相对路径。 */
function rootIndexPath() {
	return "index.md";
}
/** 某个 Workspace 索引的相对路径。 */
function workspaceIndexPath(slug) {
	return `runs/${slug}/index.md`;
}
/** 更新历史的相对路径。 */
function logPath() {
	return "log.md";
}
//#endregion
//#region src/memory.ts
/**
* 记忆库的宿主侧（ADR-0022）。领域层决定「一篇复盘长什么样」，这一层决定
* 「它落在磁盘哪里、什么时候落」。
*
* 三条纪律：
*
* 1. **路径必须显式配置。** 没配 `memoryPath` 时这个类根本不会被建出来，
*    一个目录都不创建（ADR-0022）。不回落 `process.cwd()`，不猜 DSH 家目录。
* 2. **写入串行化。** 一次落盘要动三个文件（复盘、索引、更新历史），并发
*    交错会让索引对不上真相。写链与 `BoardStore` 同款。
* 3. **索引可再生，更新历史只追加。** 索引每次整份重算——一份能被重算出来
*    的东西不值得为它维护增量正确性。更新历史重算不出来（谁在哪天删了哪一
*    篇，删完就没痕迹了），所以只追加、读不懂时报错而不是覆盖。
*
* 落盘失败一律**向上抛**，由调用方决定要不要吞。这一层不知道「一篇复盘没写
* 成不该拖垮 Run 结算」这条策略——那是执行器的事。
*/
/**
* 写进 `generated.by` 的版本号。
*
* 与 `package.json` 的 version 保持一致。漂了只影响复盘里记的生成者版本，
* 不影响任何行为——因此这里用常量而不是运行时读 package.json（那会让构建
* 产物依赖一个它不一定能解析到的路径）。
*/
const VELA_VERSION = "0.1.0";
/** 记忆库读写失败。 */
var MemoryError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "MemoryError";
	}
};
/** 一个打开的记忆库。 */
var MemoryStore = class MemoryStore {
	root;
	/** 写链尾。每次写挂在前一次之后，保证三个文件的更新不交错。 */
	tail = Promise.resolve();
	constructor(root) {
		this.root = root;
	}
	/**
	* 打开一个记忆库。
	*
	* **不创建目录**：物化推迟到第一次真的写入。一个空目录会让 Operator 以为
	* 功能已经在跑了，而此刻还没有任何复盘。
	*
	* @param root - 绝对目录路径。相对路径直接拒绝（ADR-0022）。
	*/
	static open(root) {
		if (!isAbsolute(root)) throw new MemoryError(`记忆库路径必须是绝对路径，收到的是 ${root}`);
		return new MemoryStore(root);
	}
	/** 把一次写排到链尾。上一次失败不能卡住下一次。 */
	enqueue(task) {
		const next = this.tail.then(task, task);
		this.tail = next.catch(() => void 0);
		return next;
	}
	/**
	* 等写链上已排队的活干完。
	*
	* 一次落盘会动好几个文件（复盘、旧篇的废弃标记、更新历史、索引），
	* 而 `landRecap` 在第一个文件写完后就能被看到。要断言「那一整批都完了」
	* 就得等链排空——提供这个入口比让调用方轮询文件诚实。
	*/
	async settled() {
		await this.enqueue(async () => void 0);
	}
	absolute(relative) {
		if (relative.length === 0 || isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new MemoryError(`不是记忆库里的相对路径：${relative}`);
		return join(this.root, relative);
	}
	/** 读一个文件；不存在时 undefined。 */
	async readFileAt(relative) {
		try {
			return await readFile(this.absolute(relative), "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return void 0;
			throw new MemoryError(`读不了 ${relative}`, { cause: error });
		}
	}
	/** 原子写一个文件，父目录按需创建。 */
	async writeFileAt(relative, text) {
		const path = this.absolute(relative);
		try {
			await mkdir(dirname(path), {
				recursive: true,
				mode: 448
			});
			await writeAtomic(path, text);
		} catch (error) {
			throw new MemoryError(`写不了 ${relative}`, { cause: error });
		}
	}
	/**
	* 落下一篇复盘，顺带记一行更新历史并重算索引。
	*
	* 顺序有意如此：**先写复盘**，再记历史，最后重算索引。前者是真相，后两个
	* 是派生物；中途失败时真相已经落地，索引下次落盘或下次打开记忆页时自然
	* 被重算对。
	*/
	async landRecap(facts, delivery, at) {
		return this.enqueue(async () => {
			const relative = recapRelativePath(facts);
			const text = buildRecap({
				facts,
				...delivery === void 0 ? {} : { delivery },
				at,
				velaVersion: VELA_VERSION
			});
			await this.writeFileAt(relative, text);
			await this.appendLogLine(loggedLanded(relative, facts.runSeq, facts.outcome), at);
			await this.deprecateEarlierDrafts(facts, at);
			await this.reindex(at);
			return relative;
		});
	}
	/**
	* 把同一张卡更早的、仍停在 `draft` 的复盘标成废弃。
	*
	* 扫目录而不是只看上一次（`runSeq - 1`）：一张卡可能连着退回多次，
	* 只处理相邻那一篇会把中间几篇永久留在召回候选集外的灰地带。
	*/
	async deprecateEarlierDrafts(facts, at) {
		const slug = workspaceSlug(facts.workspace);
		let files;
		try {
			files = (await readdir(join(this.root, "runs", slug), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
		} catch {
			return;
		}
		for (const file of files) {
			const matched = /^(\d+)-r(\d+)\.md$/.exec(file);
			if (matched === null) continue;
			if (Number(matched[1]) !== facts.issueNumber) continue;
			if (Number(matched[2]) >= facts.runSeq) continue;
			const relative = `runs/${slug}/${file}`;
			const text = await this.readFileAt(relative);
			if (text === void 0) continue;
			let status;
			try {
				status = readRecap(text).status;
			} catch {
				continue;
			}
			if (status !== "draft") continue;
			await this.deprecateNow(relative, `第 ${facts.runSeq} 次执行的复盘取代了它`, at);
		}
	}
	/** 追加一行更新历史。 */
	async appendLogLine(line, at) {
		const existing = await this.readFileAt(logPath());
		await this.writeFileAt(logPath(), appendLogEntry(existing, line, at));
	}
	/** 追加一行更新历史（外部调用，走写链）。 */
	async log(line, at) {
		return this.enqueue(() => this.appendLogLine(line, at));
	}
	/**
	* 扫出全部复盘。读不懂的那些照样列出来，带上原因。
	*
	* 目录不存在时给空数组而不是报错：那只意味着还没有任何复盘落盘。
	*/
	async list() {
		const runsRoot = join(this.root, "runs");
		let groups;
		try {
			groups = (await readdir(runsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		} catch (error) {
			if (error.code === "ENOENT") return [];
			throw new MemoryError("读不了记忆库目录", { cause: error });
		}
		const found = [];
		for (const slug of groups) {
			let files;
			try {
				files = (await readdir(join(runsRoot, slug), { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md").map((entry) => entry.name);
			} catch {
				continue;
			}
			for (const file of files.sort()) {
				const relative = `runs/${slug}/${file}`;
				const text = await this.readFileAt(relative);
				if (text === void 0) continue;
				try {
					found.push({
						path: relative,
						recap: readRecap(text)
					});
				} catch (error) {
					found.push({
						path: relative,
						problem: error instanceof Error ? error.message : String(error)
					});
				}
			}
		}
		return found;
	}
	/**
	* 整份重算索引。
	*
	* 读不懂的复盘不进索引（它没有可摆出来的标题与等级），但**留在磁盘上**，
	* 由记忆页单独显示成「这篇读不了」。
	*/
	async reindex(at) {
		const stored = await this.list();
		const byWorkspace = /* @__PURE__ */ new Map();
		for (const item of stored) {
			const recap = item.recap;
			if (recap === void 0) continue;
			const workspace = recap.workspace ?? "（未记录工作区）";
			const slug = recap.workspace === void 0 ? slugOfPath(item.path) : workspaceSlug(recap.workspace);
			const group = byWorkspace.get(slug) ?? {
				workspace,
				entries: []
			};
			group.entries.push({
				path: item.path,
				title: recap.title.length === 0 ? item.path : recap.title,
				trust: recap.trust,
				status: recap.status,
				stale: isStale(recap.staleAfter, at),
				...recap.generatedAt === void 0 ? {} : { generatedAt: recap.generatedAt }
			});
			byWorkspace.set(slug, group);
		}
		const groups = [...byWorkspace].map(([slug, group]) => ({
			slug,
			workspace: group.workspace,
			entries: group.entries
		}));
		await this.writeFileAt(rootIndexPath(), buildRootIndex(groups, at));
		for (const group of groups) await this.writeFileAt(workspaceIndexPath(group.slug), buildWorkspaceIndex(group, at));
	}
	/** 一篇复盘经 Operator 验收：回写人审记录并记一行历史。 */
	async verify(relative, at, actor = OPERATOR_ACTOR) {
		return this.enqueue(() => this.verifyNow(relative, at, actor));
	}
	/** 回写人审记录本体。**不走写链**，供已在链上的调用方复用。 */
	async verifyNow(relative, at, actor = OPERATOR_ACTOR) {
		const text = await this.readFileAt(relative);
		if (text === void 0) return false;
		const next = markVerified(text, actor, at);
		if (next === text) return true;
		await this.writeFileAt(relative, next);
		await this.appendLogLine(loggedVerified(relative, actor), at);
		await this.reindex(at);
		return true;
	}
	/** 把一篇复盘标成废弃。 */
	async deprecate(relative, why, at) {
		return this.enqueue(async () => {
			const marked = await this.deprecateNow(relative, why, at);
			if (marked) await this.reindex(at);
			return marked;
		});
	}
	/** 标废弃本体。**不走写链**。 */
	async deprecateNow(relative, why, at) {
		const text = await this.readFileAt(relative);
		if (text === void 0) return false;
		const next = markDeprecated(text);
		if (next === text) return true;
		await this.writeFileAt(relative, next);
		await this.appendLogLine(loggedDeprecated(relative, why), at);
		return true;
	}
	/**
	* 对账：把漏写的人审记录补上（ADR-0025）。
	*
	* 待补的事实不需要新字段：「卡在 Done 且这篇仍是草稿」本身就是信号。
	* `deprecated` 表示「故意不要」，因此与「没写成」可区分，不会被误补。
	*
	* @param candidates - 已验收接受的卡的最后一次执行。
	* @returns 真的补上了几篇。
	*/
	async backfillVerified(candidates, at) {
		return this.enqueue(async () => {
			let repaired = 0;
			for (const candidate of candidates) {
				const relative = recapRelativePath(candidate);
				const text = await this.readFileAt(relative);
				if (text === void 0) continue;
				let status;
				try {
					status = readRecap(text).status;
				} catch {
					continue;
				}
				if (status !== "draft") continue;
				if (await this.verifyNow(relative, at)) repaired += 1;
			}
			return repaired;
		});
	}
	/** 召回展开了一篇，把它的引用计数加上。 */
	async countUse(relative, at) {
		return this.enqueue(async () => {
			const text = await this.readFileAt(relative);
			if (text === void 0) return;
			await this.writeFileAt(relative, bumpUsageCount(text, at));
		});
	}
	/** 删掉一篇复盘。删除必须留痕（票 06）。 */
	async remove(relative, at, actor = OPERATOR_ACTOR) {
		return this.enqueue(async () => {
			const path = this.absolute(relative);
			try {
				await rm(path);
			} catch (error) {
				if (error.code === "ENOENT") return false;
				throw new MemoryError(`删不掉 ${relative}`, { cause: error });
			}
			await this.appendLogLine(loggedRemoved(relative, actor), at);
			await this.reindex(at);
			return true;
		});
	}
	/** 更新历史里的条目，最新的在前。读不懂时给空数组。 */
	async history() {
		const text = await this.readFileAt(logPath());
		return text === void 0 ? [] : readLogLines(text);
	}
	/**
	* 召回候选：记忆库里全部**读得懂**的复盘。
	*
	* 筛选（同工作区、人审过、未废弃未陈旧）留给 `selectRecall`：那是纯逻辑，
	* 可以脱离文件系统单测，而这里只负责把磁盘上的东西读成候选。
	*/
	async recallCandidates() {
		const stored = await this.list();
		const found = [];
		for (const item of stored) {
			const recap = item.recap;
			if (recap === void 0) continue;
			found.push({
				path: item.path,
				title: recap.title,
				status: recap.status,
				trust: recap.trust,
				body: recap.body,
				...recap.workspace === void 0 ? {} : { workspace: recap.workspace },
				...recap.staleAfter === void 0 ? {} : { staleAfter: recap.staleAfter },
				...recap.verifiedAt === void 0 ? {} : { verifiedAt: recap.verifiedAt }
			});
		}
		return found;
	}
	/**
	* 记忆页要的全部条目，新的在前。
	*
	* 读不懂的文件**照样占一条**，带着原因（ADR-0023）：从列表里静默跳过等于
	* 告诉 Operator「那篇不存在」，而它就在目录里。
	*/
	async browse(now) {
		return (await this.list()).map((item) => {
			const recap = item.recap;
			if (recap === void 0) return {
				path: item.path,
				title: item.path,
				trust: "unverified",
				status: "draft",
				stale: false,
				usageCount: 0,
				body: "",
				problem: item.problem ?? "这篇读不了"
			};
			return {
				path: item.path,
				title: recap.title.length === 0 ? item.path : recap.title,
				trust: recap.trust,
				status: recap.status,
				stale: isStale(recap.staleAfter, now),
				usageCount: recap.usageCount,
				body: recap.body,
				...recap.workspace === void 0 ? {} : { workspace: recap.workspace },
				...recap.issueNumber === void 0 ? {} : { issueNumber: recap.issueNumber },
				...recap.generatedAt === void 0 ? {} : { generatedAt: recap.generatedAt },
				...recap.verifiedAt === void 0 ? {} : { verifiedAt: recap.verifiedAt }
			};
		}).sort((left, right) => (right.generatedAt ?? "").localeCompare(left.generatedAt ?? ""));
	}
};
/** 从相对路径里取出目录名。给那些没记工作区的旧文件兜底。 */
function slugOfPath(relative) {
	return relative.split("/")[1] ?? "unknown";
}
//#endregion
//#region src/domain/models.ts
/** 把一个 provider 的模型摊成选项。 */
function modelOptionsOf(providerId, providerName, models) {
	return models.map((model) => ({
		value: `${providerId}/${model.id}`,
		label: `${model.name}（${providerName}）`,
		provider: providerId,
		model: model.id
	}));
}
//#endregion
//#region src/model-catalog.ts
/** 清单的缓存装配。 */
var ModelCatalog = class {
	llm;
	log;
	cache = [];
	constructor(llm, log) {
		this.llm = llm;
		this.log = log;
	}
	/** 当前清单。没刷新过、或刷新全失败时是空表——前端据此退化为手输。 */
	get options() {
		return this.cache;
	}
	/**
	* 拉一轮。单个 provider 失败只跳过它——一个 provider 离线不该让整份清单消失。
	* 全部失败时保留旧缓存：一份略旧的清单比一份空清单有用。
	*/
	async refresh() {
		const next = [];
		let succeeded = 0;
		for (const provider of this.llm.listProviders()) try {
			const models = await this.llm.listModels(provider.id);
			next.push(...modelOptionsOf(provider.id, provider.name, models));
			succeeded += 1;
		} catch (error) {
			this.log?.(`vela: 拉取 ${provider.id} 的模型清单失败：${String(error)}`);
		}
		if (succeeded > 0) this.cache = next;
	}
};
//#endregion
//#region src/domain/skills.ts
/** 头部与正文的分界。 */
const FENCE = "---";
/** 块标量指示符：`description: >-` 这类写法的值在后面的缩进行里。 */
const BLOCK_SCALAR = /^[>|][+-]?$/;
/** 去掉标量两端的成对引号；不成对的保持原样（容错，不猜）。 */
function unquote(value) {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if (first === "\"" && last === "\"" || first === "'" && last === "'") return value.slice(1, -1);
	}
	return value;
}
/**
* 容错地读一份 SKILL.md 的头。返回 undefined 表示连 frontmatter 块都没有；
* 否则返回读出来的字段——缺哪个字段就是 undefined，不猜默认值。
*
* 这里**不是**一个 YAML 实现（与 okf-frontmatter 不同，那个只管 Vela 自己
* 写的受控子集，而技能文件是别人写的任意 YAML）。它只认一层 `key: value`
* 加最常见的块标量，为的是把名字和描述展示给人看；技能的权威内容永远是
* 文件本身，装配（复制）走的是逐字节，不经过这里。
*/
function parseSkillHead(text) {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== FENCE) return void 0;
	let end = -1;
	for (let index = 1; index < lines.length; index += 1) if (lines[index]?.trim() === FENCE) {
		end = index;
		break;
	}
	if (end < 0) return void 0;
	let name;
	let description;
	let whenToUse;
	let userOnly = false;
	for (let index = 1; index < end; index += 1) {
		const line = lines[index];
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (match === null) continue;
		const key = match[1];
		let value = match[2].trim();
		if (BLOCK_SCALAR.test(value)) {
			const parts = [];
			for (let cursor = index + 1; cursor < end; cursor += 1) {
				const inner = lines[cursor];
				if (inner.trim().length === 0) continue;
				if (!/^\s/.test(inner)) break;
				parts.push(inner.trim());
				index = cursor;
			}
			value = parts.join(" ");
		}
		value = unquote(value);
		switch (key) {
			case "name":
				if (value.length > 0) name = value;
				break;
			case "description":
				if (value.length > 0) description = value;
				break;
			case "when-to-use":
			case "whenToUse":
				if (value.length > 0) whenToUse = value;
				break;
			case "disable-model-invocation": userOnly = value === "true";
		}
	}
	return {
		...name === void 0 ? {} : { name },
		...description === void 0 ? {} : { description },
		...whenToUse === void 0 ? {} : { whenToUse },
		userOnly
	};
}
/**
* 把按优先级从高到低排好的各来源列表并成一张清单：同名先来者生效，
* 后来者保留在列表里但标 `effective: false`（让人看到「这里还有一份，
* 但它被盖住了」）。输出按名字排序，与来源无关。
*/
function mergeSkills(groups) {
	const out = [];
	const taken = /* @__PURE__ */ new Set();
	for (const group of groups) for (const skill of group) if (taken.has(skill.name)) out.push({
		...skill,
		effective: false
	});
	else {
		taken.add(skill.name);
		out.push(skill);
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}
//#endregion
//#region src/skills.ts
/**
* 技能广场的宿主侧（扫盘那一半）。形状与合并规则在 `domain/skills.ts`，
* 这一层只管「去哪个目录、把文件读出来」。
*
* 与 DSH 的发现规则对齐（packages/skill/skill-filesystem）：
* - 一个技能 = 一个含 `SKILL.md` 的子目录，或根目录下一个散装的 `.md` 文件；
* - DSH 目录下的 `.system` 子目录跳过（DSH 自己的 skipSystem 行为）；
* - 不存在的根不是错误——全新安装就是这样，跳过即可。
*
* 容错纪律与记忆库相同（ADR-0023）：一个读不懂的技能要显示成「这个读不了」，
* 而不是从列表里悄悄消失——广场的职责就是让人看到磁盘上到底有什么。
*/
/** 技能广场的目录扫描器。无状态，每次 list 都现扫——目录随时可能被人手改。 */
var SkillCatalog = class {
	roots;
	constructor(roots) {
		this.roots = roots;
	}
	/** 扫全部根并合并成一张清单。单个根读不了不拖垮其余。 */
	async list() {
		const groups = [];
		for (const root of this.roots) groups.push(await this.scanRoot(root));
		return mergeSkills(groups);
	}
	async scanRoot(root) {
		let entries;
		try {
			entries = await readdir(root.path, { withFileTypes: true });
		} catch {
			return [];
		}
		const skills = [];
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (root.source === "dsh" && entry.name === ".system") continue;
			const file = entry.isDirectory() ? join(root.path, entry.name, "SKILL.md") : entry.isFile() && entry.name.endsWith(".md") ? join(root.path, entry.name) : void 0;
			if (file === void 0) continue;
			skills.push(await this.readSkill(file, entry.name.replace(/\.md$/, ""), root.source));
		}
		return skills;
	}
	/**
	* 读一个技能文件。`fallbackName` 是目录名/文件名——技能头里读不出名字时
	* 用它顶上，让这个条目在广场上可见（DSH 能不能认它是另一回事，标出来）。
	*/
	async readSkill(file, fallbackName, source) {
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch (error) {
			return {
				name: fallbackName,
				description: "",
				userOnly: false,
				source,
				sourcePath: file,
				effective: true,
				problem: `文件读不了：${error instanceof Error ? error.message : String(error)}`
			};
		}
		const head = parseSkillHead(text);
		if (head === void 0 || head.name === void 0) return {
			name: fallbackName,
			description: head?.description ?? "",
			...head?.whenToUse === void 0 ? {} : { whenToUse: head.whenToUse },
			userOnly: head?.userOnly ?? false,
			source,
			sourcePath: file,
			effective: true,
			problem: head === void 0 ? "没有 frontmatter 头，DSH 可能认不出它" : "头部里没有 name，DSH 可能认不出它"
		};
		return {
			name: head.name,
			description: head.description ?? "",
			...head.whenToUse === void 0 ? {} : { whenToUse: head.whenToUse },
			userOnly: head.userOnly,
			source,
			sourcePath: file,
			effective: true
		};
	}
};
//#endregion
//#region src/index.ts
/**
* Vela host half。拥有 Board 状态机与持久化，经宿主 webServer 暴露一条 prefix
* 路由，并拥有派活执行器。**不注册任何工具**（ADR-0012：Agent 不能写
* Board），这把运行面缩到最小。
*
* client half 经 package.json 的 dsh.client 声明被发现，不在这里引用。
*/
/** Cordis 插件名。 */
const name = "vela";
/**
* 需要宿主 web server（web 组合提供）。
*
* `apiProxy` 与 `permissionPresets` 刻意不列为必需：看看看板、建卡、排序在
* 没有它们时仍然成立，而一个 pending fiber 对 Operator 是完全隐形的（路由不
* 挂、UI 不现身）。改为惰性取服务，派活时才报一条能读的错。
*/
const inject = ["webServer"];
/** 并发上限的默认值。 */
const DEFAULT_MAX_CONCURRENT_RUNS = 3;
/** 小队组合默认基于的 preset。 */
const DEFAULT_SQUAD_BASELINE = "standard";
/** 号牌对账的默认阈值：两小时。 */
const DEFAULT_SLOT_MAX_HOLD_MS = 72e5;
/**
* 把号牌层挂到 DSH 的子代理注册表上（ADR-0018）。
*
* 返回是否真的挂上了——这个答案直接决定队员行里写哪个 provider 名。
*
* `subagents` 服务不在时**不报错只记一句**：那意味着这个部署根本没装子代理
* 能力，小队依旧能建只是没有闸门，看板其余部分照常。
*/
function installSlots(ctx, slots, squads, timeline) {
	const subagents = ctx.get("subagents");
	if (subagents === void 0) {
		ctx.logger?.warn("[vela] 没有 subagents 服务，小队的队员并发不设闸门");
		return false;
	}
	const dispose = installSlottedProviders(subagents, {
		slots,
		timeline,
		now: () => Date.now(),
		quotaFor: async (parentCtx) => {
			const id = ctx.get("agentPresets")?.composedPreset?.(parentCtx);
			if (typeof id !== "string" || !id.startsWith("vela-")) return void 0;
			const squad = await squads.read(id);
			if (!squad.ok) return void 0;
			return {
				key: id,
				limit: squad.value.maxParallelMembers,
				members: squad.value.members
			};
		},
		...ctx.logger === void 0 ? {} : { logger: ctx.logger }
	});
	ctx.effect(() => dispose);
	return true;
}
/** 请求体上限：Board 的写入都是小 JSON，1MB 足够且能挡住失控的 body。 */
const MAX_BODY_BYTES = 1048576;
/** 读取并 JSON 解析请求体；空体给 undefined，超限或非法 JSON 抛错。 */
async function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("error", reject);
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (text.length === 0) {
				resolve(void 0);
				return;
			}
			try {
				resolve(JSON.parse(text));
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}
/** 把一次 ApiResponse 写回 node 响应，快照接口一律 no-store。 */
function send(res, response) {
	res.statusCode = response.status;
	res.setHeader("content-type", "application/json");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(response.body));
}
/** 应用插件。 */
function apply(ctx, config) {
	ctx.effect(() => {
		let disposed = false;
		let runner;
		let slotted = false;
		const timers = /* @__PURE__ */ new Set();
		const timeline = new TimelineRecorder();
		const llm = ctx.get("llm");
		let modelCatalog;
		if (llm !== void 0) {
			modelCatalog = new ModelCatalog(llm, (message) => ctx.logger?.warn(message));
			modelCatalog.refresh();
			const timer = setInterval(() => {
				modelCatalog?.refresh();
			}, 3e5);
			timers.add(timer);
		}
		let memory;
		if (config.memoryPath !== void 0) try {
			memory = MemoryStore.open(config.memoryPath);
		} catch (error) {
			ctx.logger?.warn(`[vela] 记忆库没启用：${describe(error)}`);
		}
		const slots = new SlotPool({
			setTimer: (fn, ms) => {
				const handle = setTimeout(() => {
					timers.delete(handle);
					fn();
				}, ms);
				timers.add(handle);
				return handle;
			},
			clearTimer: (handle) => {
				clearTimeout(handle);
				timers.delete(handle);
			},
			maxHoldMs: config.slotMaxHoldMs ?? DEFAULT_SLOT_MAX_HOLD_MS,
			...ctx.logger === void 0 ? {} : { logger: ctx.logger }
		});
		const home = homedir();
		const dshHome = process.env.DSH_HOME ?? join(home, ".dsh");
		const agentsHome = process.env.DSH_AGENTS_HOME ?? join(home, ".agents");
		const skillsCatalog = new SkillCatalog([
			{
				path: config.skillsDshRoot ?? join(dshHome, "skills"),
				source: "dsh"
			},
			{
				path: join(agentsHome, "skills"),
				source: "agents"
			},
			...process.env.DSH_BUNDLED_SKILL_DIR === void 0 ? [] : [{
				path: process.env.DSH_BUNDLED_SKILL_DIR,
				source: "bundled"
			}]
		]);
		const ready = BoardStore.open(config.boardPath).then(async (store) => {
			if (disposed) return void 0;
			const squads = config.squadRoot === void 0 ? void 0 : new SquadStore(config.squadRoot, process.platform, async () => {
				const presets = ctx.get("agentPresets");
				if (presets === void 0) throw new Error("agentPresets 服务没挂载，拿不到基准 preset");
				return presets.read(config.squadBaseline ?? DEFAULT_SQUAD_BASELINE);
			}, () => slotted ? { providerFor: (backend) => `${VELA_PROVIDER_PREFIX}${backend}` } : {});
			const created = new Runner({
				store,
				now: () => Date.now(),
				newId: () => newId("run"),
				defaults: config.exec ?? {},
				maxConcurrentRuns: () => config.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
				apiProxy: () => ctx.get("apiProxy"),
				permissionPresets: () => ctx.get("permissionPresets"),
				sessions: () => ctx.get("sessions"),
				squads: () => squads,
				slots: () => slots,
				memory: () => memory,
				setTimer: (fn, ms) => {
					const handle = setTimeout(() => {
						timers.delete(handle);
						fn();
					}, ms);
					timers.add(handle);
					return handle;
				},
				clearTimer: (handle) => {
					clearTimeout(handle);
					timers.delete(handle);
				},
				...ctx.logger === void 0 ? {} : { logger: ctx.logger }
			});
			runner = created;
			if (squads !== void 0) slotted = installSlots(ctx, slots, squads, timeline);
			await created.reconcile().catch((error) => {
				ctx.logger?.warn(`[vela] reconcile failed: ${describe(error)}`);
			});
			if (memory !== void 0) {
				const pending = store.snapshot().issues.filter((issue) => issue.lane === "done" && issue.runs.length > 0).map((issue) => ({
					workspace: issue.workspace,
					issueNumber: issue.number,
					runSeq: issue.runs.length
				}));
				await memory.backfillVerified(pending, Date.now()).then((repaired) => {
					if (repaired > 0) ctx.logger?.info(`[vela] 补写了 ${repaired} 篇复盘的人审记录`);
				}).catch((error) => {
					ctx.logger?.warn(`[vela] 记忆对账失败：${describe(error)}`);
				});
			}
			return {
				store,
				runner: created,
				squads
			};
		}).catch((error) => {
			ctx.logger?.warn(`[vela] cannot open board at ${config.boardPath}: ${describe(error)}`);
		});
		const webServer = ctx.webServer;
		if (webServer === void 0) {
			ctx.logger?.warn("[vela] no webServer available; Board API not mounted");
			return () => {
				disposed = true;
			};
		}
		const disposeEvents = observeSessions((listener) => ctx.on("session/event", listener), { observe: (sessionId, event) => runner?.observe(sessionId, event) });
		const disposeRoute = webServer.register({
			kind: "prefix",
			path: API_PREFIX,
			handler: async (req, res) => {
				const context = await ready;
				if (context === void 0 || disposed) {
					send(res, {
						status: 503,
						body: {
							ok: false,
							code: "unavailable",
							message: "board store is not ready"
						}
					});
					return;
				}
				const url = new URL(req.url ?? "/", "http://x");
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					send(res, {
						status: 400,
						body: {
							ok: false,
							code: "invalid",
							message: "malformed request body"
						}
					});
					return;
				}
				const request = {
					method: req.method ?? "GET",
					path: url.pathname,
					...body === void 0 ? {} : { body }
				};
				const deps = {
					now: () => Date.now(),
					newId: () => newId("iss"),
					sandboxPresets: () => ctx.get("permissionPresets")?.names ?? [],
					platform: () => process.platform,
					...ctx.get("apiProxy") === void 0 ? {} : { dispatcher: context.runner },
					...context.squads === void 0 ? {} : { squads: context.squads },
					timeline,
					skills: skillsCatalog,
					...modelCatalog === void 0 ? {} : { modelCatalog: () => modelCatalog.options },
					...ctx.get("apiProxy") === void 0 ? {} : { documents: openDocuments(ctx) },
					...memory === void 0 ? {} : { memory },
					...ctx.logger === void 0 ? {} : { logger: ctx.logger }
				};
				send(res, await handleApi(context.store, deps, request));
			}
		});
		return () => {
			disposed = true;
			disposeRoute();
			disposeEvents();
			runner?.dispose();
			for (const handle of timers) clearTimeout(handle);
			timers.clear();
		};
	}, "vela: board API route + run dispatcher");
}
function newId(prefix) {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
/**
* 把导航里的「打开配置文件」接到 DSH 自己的 openDocument 上（ADR-0020）。
*
* 宿主没提供对应的面时返回 `opened: false` 而不报错——这与“宿主有这个面但
* 当前环境打不开”对 Operator 而言是同一回事：都是“没帮你打开”，而不是“出错了”。
*/
function openDocuments(ctx) {
	return { open: async (target) => {
		const api = ctx.get("apiProxy");
		const rpcId = newId("doc");
		if (target === "agent-presets") {
			const presets = api?.agentPresets;
			if (presets === void 0) return { opened: false };
			const response = await presets.openDocument({
				rpcId,
				payload: {}
			});
			return response.result.ok ? response.result.value : { opened: false };
		}
		const settings = api?.settings;
		if (settings === void 0) return { opened: false };
		const response = await settings.openDocument({
			rpcId,
			payload: {}
		});
		return response.result.ok ? response.result.value : { opened: false };
	} };
}
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
export { apply, inject, name };
