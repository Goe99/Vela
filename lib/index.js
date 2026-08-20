window.__ModuleLoader__.load({
	id: "dsh-vela",
	factory: (require) => {
		var exports = { exports: {} }.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/panel-state.ts
		/** 建一个开关 store。 */
		function createPanelState() {
			let open = false;
			const listeners = /* @__PURE__ */ new Set();
			const emit = () => {
				for (const listener of [...listeners]) listener();
			};
			const set = (next) => {
				if (next === open) return;
				open = next;
				emit();
			};
			return {
				isOpen: () => open,
				open: () => set(true),
				close: () => set(false),
				toggle: () => set(!open),
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				}
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
		/** 编号的展示形式。单一出处，免得前后端各拼一份。 */
		function formatIssueNumber(value) {
			return `V-${value}`;
		}
		/** 全部信任等级，由弱到强。校验外来数据时要用到它。 */
		const TRUST_LEVELS = [
			"unverified",
			"machine-confirmed",
			"human-reviewed"
		];
		/** 全部生命周期状态。 */
		const RECAP_STATUSES = [
			"draft",
			"stable",
			"deprecated"
		];
		//#endregion
		//#region src/domain/skills.ts
		/** 来源的展示顺序（也是优先级顺序：靠前的盖住靠后的同名技能）。 */
		const SKILL_SOURCES = [
			"dsh",
			"agents",
			"bundled"
		];
		/** 来源的中文标签。 */
		const SKILL_SOURCE_LABELS = {
			dsh: "DSH 目录",
			agents: "共享目录",
			bundled: "出厂自带"
		};
		//#endregion
		//#region src/client/board-client.ts
		/**
		* 浏览器侧 Board API 客户端。轮询用 no-store + in-flight guard + 响应形状校验；
		* 失败保留最后一次成功快照，不把界面清空。
		*
		* fetch 经构造注入，因此可在 node 里用 fake 直接测这套取数/守卫逻辑，不需要
		* 真的网络。
		*/
		/**
		* 从未经校验的响应体里读出记忆清单。逐条校验，形状不齐的丢掉；
		* 不认识的信任等级与状态归为最保守的那一档（未验证 / 草稿）——
		* 宁可低估信任，不可把看不懂的东西显示成「人审过」。
		*/
		function readMemory(body) {
			if (typeof body !== "object" || body === null) return void 0;
			const raw = body;
			if (!Array.isArray(raw.entries)) return void 0;
			const entries = [];
			for (const candidate of raw.entries) {
				if (typeof candidate !== "object" || candidate === null) continue;
				const item = candidate;
				if (typeof item.path !== "string") continue;
				entries.push({
					path: item.path,
					title: typeof item.title === "string" ? item.title : item.path,
					trust: TRUST_LEVELS.includes(item.trust) ? item.trust : "unverified",
					status: RECAP_STATUSES.includes(item.status) ? item.status : "draft",
					stale: item.stale === true,
					usageCount: typeof item.usageCount === "number" ? item.usageCount : 0,
					body: typeof item.body === "string" ? item.body : "",
					...typeof item.workspace === "string" ? { workspace: item.workspace } : {},
					...typeof item.issueNumber === "number" ? { issueNumber: item.issueNumber } : {},
					...typeof item.generatedAt === "string" ? { generatedAt: item.generatedAt } : {},
					...typeof item.verifiedAt === "string" ? { verifiedAt: item.verifiedAt } : {},
					...typeof item.problem === "string" ? { problem: item.problem } : {}
				});
			}
			return {
				available: raw.available === true,
				entries,
				history: Array.isArray(raw.history) ? raw.history.filter((line) => typeof line === "string") : []
			};
		}
		function isBoard(value) {
			return typeof value === "object" && value !== null && value.version === 2 && Array.isArray(value.issues);
		}
		function readUsageMap(value) {
			if (typeof value !== "object" || value === null) return {};
			return value;
		}
		function readStrings(value) {
			return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
		}
		function readSquads(value) {
			return Array.isArray(value) ? value : [];
		}
		/** 时间轴与在跑名单是「会话 id → 数组」的映射。逐项校验太重——，这里做的是
		* 「形状是对象就透传」——泳道内部形状由时间轴组件自己面对。 */
		function readTimelines(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
			const out = {};
			for (const [key, spans] of Object.entries(value)) if (Array.isArray(spans)) out[key] = spans;
			return out;
		}
		function readLiveMembers(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
			const out = {};
			for (const [key, names] of Object.entries(value)) if (Array.isArray(names)) out[key] = names.filter((n) => typeof n === "string");
			return out;
		}
		/** 模型清单的读取：只留形状完整的选项，其余的丢掉。 */
		function readModelCatalog(value) {
			if (!Array.isArray(value)) return [];
			return value.filter((item) => typeof item === "object" && item !== null && typeof item.value === "string" && typeof item.label === "string");
		}
		/**
		* 从未经校验的响应体里读出技能清单。逐条校验而不是整体强转：一条脏数据
		* 不该让整个广场空白（与 readSquads 的透传不同——这里的条目要直接渲染，
		* 形状不齐的丢掉）。
		*/
		function readSkills(body) {
			if (typeof body !== "object" || body === null) return void 0;
			const raw = body;
			if (!Array.isArray(raw.skills)) return void 0;
			const skills = [];
			for (const candidate of raw.skills) {
				if (typeof candidate !== "object" || candidate === null) continue;
				const item = candidate;
				if (typeof item.name !== "string" || typeof item.sourcePath !== "string") continue;
				const source = SKILL_SOURCES.includes(item.source) ? item.source : "dsh";
				skills.push({
					name: item.name,
					description: typeof item.description === "string" ? item.description : "",
					...typeof item.whenToUse === "string" ? { whenToUse: item.whenToUse } : {},
					userOnly: item.userOnly === true,
					source,
					sourcePath: item.sourcePath,
					effective: item.effective !== false,
					...typeof item.problem === "string" ? { problem: item.problem } : {}
				});
			}
			return {
				available: raw.available !== false,
				skills
			};
		}
		/** 从一个未经校验的响应体里读出视图；形状不对则 undefined。 */
		function readView(body) {
			if (typeof body !== "object" || body === null) return void 0;
			const raw = body;
			if (!isBoard(raw.board)) return void 0;
			return {
				board: raw.board,
				liveUsage: readUsageMap(raw.liveUsage),
				sandboxPresets: readStrings(raw.sandboxPresets),
				canDispatch: raw.canDispatch === true,
				squads: readSquads(raw.squads),
				canManageSquads: raw.canManageSquads === true,
				platform: typeof raw.platform === "string" ? raw.platform : "linux",
				timelines: readTimelines(raw.timelines),
				liveMembers: readLiveMembers(raw.liveMembers),
				modelCatalog: readModelCatalog(raw.modelCatalog)
			};
		}
		const EMPTY = {
			board: emptyBoard(),
			liveUsage: {},
			sandboxPresets: [],
			canDispatch: false,
			squads: [],
			canManageSquads: false,
			platform: "linux",
			modelCatalog: []
		};
		/** Board 的浏览器侧客户端。 */
		var BoardClient = class {
			fetch;
			/** 最后一次成功读到的视图——刷新失败时界面回退到它而不是空白。 */
			last;
			/** 轮询在途标志：一次没回来前不发下一次，避免请求堆叠。 */
			inFlight = false;
			constructor(fetch) {
				this.fetch = fetch;
			}
			/** 最后一次成功视图；从未成功过则 undefined。 */
			get snapshot() {
				return this.last;
			}
			/**
			* 拉取最新视图。已有请求在途时跳过本次（返回上次视图）。响应形状不对或
			* 请求失败时保留上次视图。
			*/
			async refresh() {
				if (this.inFlight) return this.last;
				this.inFlight = true;
				try {
					const response = await this.fetch(`${API_PREFIX}/board`, {
						method: "GET",
						headers: { "cache-control": "no-store" }
					});
					if (!response.ok) return this.last;
					const view = readView(await response.json());
					if (view === void 0) return this.last;
					this.last = view;
					return view;
				} catch {
					return this.last;
				} finally {
					this.inFlight = false;
				}
			}
			async write(path, method, payload) {
				let response;
				try {
					response = await this.fetch(`${API_PREFIX}${path}`, {
						method,
						headers: { "content-type": "application/json" },
						...payload === void 0 ? {} : { body: JSON.stringify(payload) }
					});
				} catch (error) {
					return {
						ok: false,
						status: 0,
						message: error instanceof Error ? error.message : "network error"
					};
				}
				let body;
				try {
					body = await response.json();
				} catch {
					body = void 0;
				}
				if (!response.ok) {
					const message = body?.message ?? `request failed (${response.status})`;
					return {
						ok: false,
						status: response.status,
						message
					};
				}
				const view = readView(body);
				if (view !== void 0) this.last = view;
				else await this.refresh();
				return {
					ok: true,
					view: this.last ?? EMPTY
				};
			}
			createIssue(input) {
				return this.write("/issues", "POST", input);
			}
			/** 新建一支小队（ADR-0016）。 */
			createSquad(squad) {
				return this.write("/squads", "POST", squad);
			}
			/** 整体覆盖一支已存在的小队。id 不跟着改名走。 */
			updateSquad(id, squad) {
				return this.write(`/squads/${encodeURIComponent(id)}`, "PATCH", squad);
			}
			deleteSquad(id) {
				return this.write(`/squads/${encodeURIComponent(id)}`, "DELETE");
			}
			/**
			* 把一份 DSH 配置文件交给系统编辑器（ADR-0020）。
			*
			* 不走 {@link write}：它不改 Board，也不返回看板视图，拿它去走写链会白白
			* 多一次全量刷新。`opened: false` 不是错误——宿主打不开时 `path` 带回文件
			* 位置，由界面告知 Operator。
			*/
			async openDocument(target) {
				try {
					const response = await this.fetch(`${API_PREFIX}/open-document`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ target })
					});
					if (!response.ok) return { opened: false };
					const body = await response.json();
					return {
						opened: body.opened === true,
						...typeof body.path === "string" ? { path: body.path } : {}
					};
				} catch {
					return { opened: false };
				}
			}
			/**
			* 技能广场：这个部署装了的全部技能（只读）。
			*
			* 不走 refresh/write 链：它与 Board 快照无关，失败了也不该动看板那份
			* 「最后一次成功视图」。返回 undefined = 拉取失败，界面显示「拉取失败」
			* 而不是「一个技能也没装」——这两件事混了会让人去重装并不存在的问题。
			*/
			async listSkills() {
				try {
					const response = await this.fetch(`${API_PREFIX}/skills`, {
						method: "GET",
						headers: { "cache-control": "no-store" }
					});
					if (!response.ok) return void 0;
					return readSkills(await response.json());
				} catch {
					return;
				}
			}
			/**
			* 记忆页：全部复盘与更新历史。
			*
			* 与技能广场同款，不走 refresh/write 链：它与 Board 快照无关，失败也不该动
			* 看板那份「最后一次成功视图」。返回 undefined = 拉取失败，界面显示「拉取失败」
			* 而不是「一篇记忆都没有」。
			*/
			async listMemory() {
				try {
					const response = await this.fetch(`${API_PREFIX}/memory`, {
						method: "GET",
						headers: { "cache-control": "no-store" }
					});
					if (!response.ok) return void 0;
					return readMemory(await response.json());
				} catch {
					return;
				}
			}
			/**
			* 删一篇复盘。成功时直接拿回删完之后的清单，省一次往返。
			*
			* 路径进请求体：它带着斜杠，塞进 URL 路径段要编码两次。
			*/
			async removeRecap(path) {
				try {
					const response = await this.fetch(`${API_PREFIX}/memory/remove`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ path })
					});
					if (!response.ok) return void 0;
					return readMemory(await response.json());
				} catch {
					return;
				}
			}
			/** 一次落一批卡片（票 13）。整批成功或整批不落。 */
			createBatch(workspace, titles) {
				return this.write("/issues/batch", "POST", {
					workspace,
					items: titles
				});
			}
			updateIssue(id, patch) {
				return this.write(`/issues/${encodeURIComponent(id)}`, "PATCH", patch);
			}
			deleteIssue(id) {
				return this.write(`/issues/${encodeURIComponent(id)}`, "DELETE");
			}
			moveIssue(id, target) {
				return this.write(`/issues/${encodeURIComponent(id)}/move`, "POST", target);
			}
			gate(id, verdict) {
				return this.write(`/issues/${encodeURIComponent(id)}/gate`, "POST", { verdict });
			}
			/** 派活：为这个 Issue 起一个 Run（票 07）。 */
			dispatch(id) {
				return this.write(`/issues/${encodeURIComponent(id)}/dispatch`, "POST");
			}
			/** 停掉这个 Issue 正在进行的 Run。 */
			cancel(id) {
				return this.write(`/issues/${encodeURIComponent(id)}/cancel`, "POST");
			}
		};
		//#endregion
		//#region src/client/styles.ts
		/**
		* Vela 的样式。以一个 `<style data-plugin>` 标签注入——这与 DSH 自己的 client
		* 包做法一致，且让我们能用 hover、`:focus-visible`、媒体查询与 reduced-motion，
		* 这些是内联 style 表达不了的。
		*
		* ## 为什么自带色板而不是直接用 `--dsw-alias-bg-*`
		*
		* 曾经的实现把面板/泳道/卡片三层分别映射到 `bg-base` / `bg-layer-1` /
		* `bg-layer-2`。这在夜间可用，在日间**完全塌掉**：DSH 的 design-platform.css 在
		* 日间把这四个背景别名全部指向同一个 `neutral-bluish-00`（纯白），于是三层结构
		* 变成一张白纸，六条泳道彼此看不出边界。
		*
		* 因此这里自定义一套 `--vela-*` 局部变量作为三层表面阶梯（画布 < 泳道 < 卡片），
		* 卡片在日间是纯白并带极轻阴影，"浮"在偏灰的画布上。这是 DSH 文档所说的
		* 「CSS 变量桥」：颜色集中在一处声明，夜间只覆盖同一组变量。
		*
		* 明暗钩子用 `body[data-ds-dark-theme]`——它是 DSH 主题包自己切换两套调色板所用
		* 的选择器。第三方插件无法向 ui-theme 注册 token，只能这样跟随宿主主题；代价是
		* 这个选择器出现在插件样式里（DSH 内部包的规范不允许，但那条规范的前提是能改
		* ui-theme）。
		*
		* 色相与 DSH 的 `neutral-bluish` 同属偏蓝灰系，因此关掉面板时不会有色温跳变。
		*
		* 选择器只依赖稳定的 `data-vela-*` 属性，不耦合任何哈希 class。
		*/
		/** 注入用的标识，也是清理时的定位依据。 */
		const TAG = "dsh-vela";
		const CSS = `
/* ── 色板：日间 ─────────────────────────────────────────────
   三层表面必须**逐级不同**，这正是日间模式曾经坏掉的地方。
   ───────────────────────────────────────────────────────── */
[data-vela-panel],
[data-vela-nav],
[data-vela-extract],
[data-vela-extract-open] {
  /* 画布：面板底色，比泳道暗一档，让泳道浮出来 */
  --vela-canvas: #e4e9f2;
  /* 泳道底色 */
  --vela-lane: #f7f9fc;
  /* 六列各自的淡色泳道。backlog 最中性（还没排上），往后各有色彩身份：
     todo 蓝、running 琥珀、review 紫、done 绿、failed 红。 */
  --vela-lane-backlog: #edeef2;
  --vela-lane-todo: #e6edfa;
  --vela-lane-running: #faf1de;
  --vela-lane-review: #efebfa;
  --vela-lane-done: #e4f3ea;
  --vela-lane-failed: #faeaea;
  /* 卡片：日间纯白 + 轻阴影，浮在泳道上 */
  --vela-card: #ffffff;
  /* 主分隔线（泳道边框） */
  --vela-line: #d8e0ec;
  /* 次级分隔线（卡片边框、内部分隔） */
  --vela-line-soft: #e6ecf5;
  --vela-text: #16202e;
  --vela-text-2: #55637a;
  --vela-text-3: #8d99ad;
  /* 强调色：靛蓝。同时是"正在跑"的信号色，因此这个颜色带含义 */
  --vela-accent: #3557d8;
  --vela-accent-hover: #2b49bd;
  --vela-accent-text: #ffffff;
  --vela-accent-soft: #e8edfd;
  /* 待验收的标识色：紫色，与进行中（琥珀）和完成（绿）都拉开 */
  --vela-purple: #6d4fc4;
  --vela-ok: #1f9d66;
  --vela-danger: #d33a4b;
  --vela-danger-soft: #fdeff1;
  --vela-warn: #a55a00;
  --vela-warn-soft: #fff4e0;
  /* 中等优先：介于默认与高之间的青蓝。早期 low/medium 共用默认样式，于是
     四档优先只有两种颜色——浏览器里实测确认“低”与“中”在颜色上分不开。 */
  --vela-info: #1f6f8f;
  --vela-info-soft: #e4f2f8;
  --vela-hover: #e6ecf5;
  /* 弹窗遮罩 */
  --vela-scrim: rgba(21, 32, 46, .38);
  /* 输入框的凹槽底色：比卡片深一点，形成「凹进去」的层次 */
  --vela-inset: #edf0f7;
  /* 字母徽的六色盘：同一个名字永远同一个色，日夜共用（饱和度够，白字上都成立） */
  --vela-avatar-0: #4f6fd8;
  --vela-avatar-1: #7c5cd6;
  --vela-avatar-2: #2f9264;
  --vela-avatar-3: #c47b1e;
  --vela-avatar-4: #c94f7c;
  --vela-avatar-5: #2a8fa0;
  --vela-avatar-text: #ffffff;
  --vela-card-shadow: 0 1px 2px rgba(21, 44, 92, .07), 0 1px 3px rgba(21, 44, 92, .05);
  --vela-scroll: #c9d4e5;
  --vela-scroll-hover: #adbdd4;
}

/* ── 色板：夜间 ─────────────────────────────────────────────
   只覆盖同一组变量；下面所有规则都不再关心明暗。
   ───────────────────────────────────────────────────────── */
body[data-ds-dark-theme] [data-vela-panel],
body[data-ds-dark-theme] [data-vela-nav],
body[data-ds-dark-theme] [data-vela-extract],
body[data-ds-dark-theme] [data-vela-extract-open] {
  --vela-canvas: #101319;
  --vela-lane: #1a1f2a;
  /* 六列淡色泳道的夜间版：同一套色相，压暗到刚好能辨 */
  --vela-lane-backlog: #171a21;
  --vela-lane-todo: #16202e;
  --vela-lane-running: #251e13;
  --vela-lane-review: #1e1930;
  --vela-lane-done: #15251c;
  --vela-lane-failed: #2a1618;
  /* 卡片比泳道亮一档。早期取 #212734，与泳道只差十几个度——浏览器里
     实测确认卡片基本浮不起来。 */
  --vela-card: #262e3d;
  --vela-line: #313a4b;
  --vela-line-soft: #272e3b;
  --vela-text: #e6ecf5;
  --vela-text-2: #a3b0c4;
  --vela-text-3: #7a879b;
  --vela-accent: #5b7cf7;
  --vela-accent-hover: #7290fa;
  --vela-accent-text: #0b0e13;
  --vela-accent-soft: #1e2740;
  --vela-purple: #9d84f0;
  --vela-ok: #57c98a;
  --vela-danger: #ff7f88;
  --vela-danger-soft: #2c1b20;
  --vela-warn: #f0b959;
  --vela-warn-soft: #372a15;
  --vela-info: #6ec5e0;
  --vela-info-soft: #142a33;
  --vela-hover: #272e3b;
  /* 弹窗遮罩 */
  --vela-scrim: rgba(0, 0, 0, .55);
  /* 输入框的凹槽底色：深色界面的输入框要比所在表面更深，不是更亮 */
  --vela-inset: #141821;
  /* 字母徽六色盘与日间同值 */
  --vela-avatar-0: #4f6fd8;
  --vela-avatar-1: #7c5cd6;
  --vela-avatar-2: #2f9264;
  --vela-avatar-3: #c47b1e;
  --vela-avatar-4: #c94f7c;
  --vela-avatar-5: #2a8fa0;
  --vela-avatar-text: #ffffff;
  /* 夜间不需要阴影抬升：亮度差本身就够了 */
  --vela-card-shadow: none;
  --vela-scroll: #313a4b;
  --vela-scroll-hover: #43506b;
}

/* ── 面板 ───────────────────────────────────────────────── */

[data-vela-panel] {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* overlay 父层是点击穿透的；面板自己收回事件。 */
  pointer-events: auto;
  /* 不透明背景是必须的：没有它，下面的会话界面会透上来并与看板文字重叠。 */
  background: var(--vela-canvas);
  color: var(--vela-text);
  font-size: 13px;
  line-height: 1.5;
}

[data-vela-bar] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 13px;
  border-bottom: 1px solid var(--vela-line);
  background: var(--vela-lane);
  flex: 0 0 auto;
}

[data-vela-title] {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

[data-vela-brand] {
  font-size: 11px;
  font-weight: 400;
  color: var(--vela-text-3);
}

[data-vela-spacer] { flex: 1 1 auto; }

[data-vela-filter] {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--vela-text-2);
}

/* ── 控件 ───────────────────────────────────────────────── */

[data-vela-panel] button {
  font: inherit;
  color: var(--vela-text-2);
  background: var(--vela-card);
  border: 1px solid var(--vela-line);
  border-radius: 6px;
  padding: 3px 9px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}

[data-vela-panel] button:hover:not(:disabled) {
  background: var(--vela-hover);
  color: var(--vela-text);
}

[data-vela-panel] button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

[data-vela-panel] button:focus-visible,
[data-vela-panel] input:focus-visible,
[data-vela-panel] select:focus-visible,
[data-vela-panel] textarea:focus-visible {
  outline: 2px solid var(--vela-accent);
  outline-offset: 1px;
}

/* 主操作（派活、接受、保存）：实心靛蓝，比纯黑温和得多 */
[data-vela-panel] button[data-tone='primary'] {
  background: var(--vela-accent);
  border-color: var(--vela-accent);
  color: var(--vela-accent-text);
  font-weight: 500;
}

[data-vela-panel] button[data-tone='primary']:hover:not(:disabled) {
  background: var(--vela-accent-hover);
  border-color: var(--vela-accent-hover);
  color: var(--vela-accent-text);
}

[data-vela-panel] button[data-tone='danger']:hover:not(:disabled) {
  background: var(--vela-danger-soft);
  border-color: var(--vela-danger);
  color: var(--vela-danger);
}

[data-vela-panel] input,
[data-vela-panel] select,
[data-vela-panel] textarea {
  font: inherit;
  color: var(--vela-text);
  background: var(--vela-card);
  border: 1px solid var(--vela-line);
  border-radius: 6px;
  padding: 4px 7px;
  width: 100%;
  box-sizing: border-box;
}

[data-vela-panel] textarea { resize: vertical; min-height: 44px; }

[data-vela-panel] input::placeholder,
[data-vela-panel] textarea::placeholder {
  color: var(--vela-text-3);
}

/* ── 六列网格 ───────────────────────────────────────────── */

[data-vela-grid] {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  /*
   * 六列等宽。最小列宽要让一张卡读得下去（编号 + 不憋屈的标题 + 操作区），
   * 取 240px；剩余空间按 1fr 在各列间等比分配。六列总宽约 1544px，常见
   * 全屏（≥1600）能一屏放下；更窄的窗口就横向滚动，而不是把列压到读不了——
   * 「一眼看全」重要，但「每列读得下去」同样重要。
   */
  grid-auto-flow: column;
  grid-auto-columns: minmax(240px, 1fr);
  gap: 10px;
  padding: 12px;
  overflow-x: auto;
  overflow-y: hidden;
  align-items: stretch;
}

[data-vela-lane] {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--vela-line);
  border-radius: 8px;
  /* 泳道体用这一列自己的淡色；没设 --lane-tint 的（比如时间轴的行）回落到默认泳道色。 */
  background: var(--lane-tint, var(--vela-lane));
  overflow: hidden;
}

/* 六列各自的色彩身份。--lane-tint 是泳道体的淡底色，--lane-accent 是列标识色
   （列头符号、数字徽章）。用属性值选择器，只命中泳道列，不碰时间轴的行
   （那个钩子没值）。
   待验收用紫色：它是「等 Operator 判断」，跟进行中的琥珀、完成的绿都要拉开。 */
[data-vela-lane="backlog"] { --lane-tint: var(--vela-lane-backlog); --lane-accent: var(--vela-text-3); }
[data-vela-lane="todo"] { --lane-tint: var(--vela-lane-todo); --lane-accent: var(--vela-accent); }
[data-vela-lane="running"] { --lane-tint: var(--vela-lane-running); --lane-accent: var(--vela-warn); }
[data-vela-lane="review"] { --lane-tint: var(--vela-lane-review); --lane-accent: var(--vela-purple); }
[data-vela-lane="done"] { --lane-tint: var(--vela-lane-done); --lane-accent: var(--vela-ok); }
[data-vela-lane="failed"] { --lane-tint: var(--vela-lane-failed); --lane-accent: var(--vela-danger); }

[data-vela-lane-head] {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 8px 10px;
  /* 不再是一条比泳道暗的实色带——那跟泳道体颜色太接近，看起来像一块贴上去的
     补丁。改成透明，让列头融进泳道自身的淡色里，靠下边框轻轻分开。 */
  background: transparent;
  border-bottom: 1px solid var(--vela-line-soft);
  font-size: 12px;
  font-weight: 600;
  color: var(--vela-text);
  flex: 0 0 auto;
}

/* 列头前面的状态符号，用这一列的标识色。 */
[data-vela-lane-icon] {
  color: var(--lane-accent);
  font-size: 12px;
  line-height: 1;
}

[data-vela-count] {
  font-weight: 600;
  color: var(--lane-accent);
  background: var(--vela-card);
  border-radius: 999px;
  padding: 0 6px;
  min-width: 18px;
  text-align: center;
}

/* 每列内部独立滚动：一列很长时不会把整个看板拉长。 */
[data-vela-lane-body] {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

[data-vela-lane-body]::-webkit-scrollbar { width: 8px; }
[data-vela-lane-body]::-webkit-scrollbar-thumb {
  background: var(--vela-scroll);
  border-radius: 4px;
}
[data-vela-lane-body]::-webkit-scrollbar-thumb:hover {
  background: var(--vela-scroll-hover);
}

[data-vela-empty] {
  color: var(--vela-text-3);
  font-size: 12px;
  text-align: center;
  padding: 14px 6px;
}

/* 拖拽中的合法落点。 */
[data-vela-lane][data-drop='ok'] { border-color: var(--vela-accent); }
[data-vela-lane][data-drop='ok'] [data-vela-lane-body] {
  background: var(--vela-accent-soft);
}
[data-vela-lane][data-drop='no'] { border-color: var(--vela-danger); }

/* ── 卡片 ───────────────────────────────────────────────── */

[data-vela-card] {
  border: 1px solid var(--vela-line-soft);
  border-radius: 7px;
  background: var(--vela-card);
  box-shadow: var(--vela-card-shadow);
  padding: 8px 9px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  cursor: grab;
  transition: border-color 120ms ease;
}

[data-vela-card]:hover { border-color: var(--vela-line); }
[data-vela-card][data-dragging='true'] { opacity: 0.45; cursor: grabbing; }
[data-vela-card]:focus-visible {
  outline: 2px solid var(--vela-accent);
  outline-offset: 1px;
}

/* 编号与标题同一行起排：编号窄且固定，标题吃掉剩下的宽度。 */
[data-vela-card-head] {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

/* 头部右上角的小图标按钮（删除）：安静透明，悬停才露出颜色。特异性要盖过
   面板里通用的 [data-vela-panel] button，所以带上面板前缀。 */
[data-vela-panel] [data-vela-icon-btn] {
  flex: none;
  align-self: flex-start;
  padding: 1px 5px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--vela-text-3);
  font-size: 13px;
  line-height: 1.4;
}

[data-vela-panel] [data-vela-icon-btn]:hover:not(:disabled) {
  background: var(--vela-hover);
  color: var(--vela-text);
}

[data-vela-panel] [data-vela-icon-btn][data-tone='danger']:hover:not(:disabled) {
  background: var(--vela-danger-soft);
  color: var(--vela-danger);
}

[data-vela-number] {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .02em;
  color: var(--vela-text-3);
  /* 编号是给人念的句柄，不是可点的控件——别做成链接样子。 */
  user-select: all;
}

[data-vela-card-title] {
  font-weight: 600;
  color: var(--vela-text);
  /* 长标题换行而不是溢出压到别的元素上。 */
  overflow-wrap: anywhere;
}

[data-vela-card-meta] {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-size: 11px;
  color: var(--vela-text-3);
}

[data-vela-card-meta] code {
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  overflow-wrap: anywhere;
}

[data-vela-chip] {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  border-radius: 4px;
  padding: 0 5px;
  background: var(--vela-canvas);
  border: 1px solid var(--vela-line-soft);
  color: var(--vela-text-2);
}

[data-vela-chip][data-tone='urgent'],
[data-vela-chip][data-tone='high'] {
  background: var(--vela-warn-soft);
  border-color: transparent;
  color: var(--vela-warn);
}

/* 急与高本来同色，在一列卡片里分不出载重。给急加一圈边框与加粗：
   不另开一个色相（那会让四档看起来像四个不同的东西），只把同一色相推得更重。 */
[data-vela-chip][data-tone='urgent'] {
  border-color: var(--vela-warn);
  font-weight: 600;
}

/* 中等：介于默认（无/低）与高之间。没有它的时候四档只有两种颜色。 */
[data-vela-chip][data-tone='medium'] {
  background: var(--vela-info-soft);
  border-color: transparent;
  color: var(--vela-info);
}

[data-vela-failure] {
  font-size: 11px;
  color: var(--vela-danger);
  background: var(--vela-danger-soft);
  border-radius: 4px;
  padding: 4px 6px;
  overflow-wrap: anywhere;
}

[data-vela-actions] {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

/* 操作按钮给一个够得着的点击面；实心主操作吃掉剩余宽度，成为视觉主导。 */
[data-vela-actions] button {
  font-size: 12px;
  padding: 4px 10px;
  min-block-size: 30px;
}

[data-vela-actions] button[data-tone='primary'] {
  flex: 1 1 auto;
}

/* 卡片整卡是抓取手型（可拖），但按钮上悬停必须是指针——
   否则每个按钮都显示成「拖走」，点与不点分不清。 */
[data-vela-card] button {
  cursor: pointer;
}

/* 进行中的卡片：靛蓝描边 + 同色脉动，与主操作色一致 */
[data-vela-card][data-lane='running'] { border-color: var(--vela-accent); }
[data-vela-live] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--vela-accent);
}

/* 此刻在跑的队员名单：跟在实时用量后面，同一个色系的「活」信号。 */
[data-vela-live-members] {
  font-size: 11px;
  color: var(--vela-accent);
  margin-top: 1px;
}
[data-vela-live]::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: vela-pulse 1.4s ease-in-out infinite;
}

@keyframes vela-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}

/* ── 表单 ───────────────────────────────────────────────── */

[data-vela-form] {
  display: flex;
  flex-direction: column;
  gap: 5px;
  border: 1px dashed var(--vela-line);
  border-radius: 7px;
  padding: 8px;
  background: var(--vela-card);
}

[data-vela-error] {
  font-size: 11px;
  color: var(--vela-danger);
  overflow-wrap: anywhere;
}

[data-vela-hint] {
  font-size: 11px;
  color: var(--vela-text-3);
}

/* ── 侧栏导航项 ─────────────────────────────────────────── */

[data-vela-nav] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  font: inherit;
  /* 导航项住在 DSH 的侧栏里，因此背景透明、文字跟随宿主，只有激活态用自己的强调色。 */
  color: inherit;
  background: transparent;
  border: none;
  border-radius: 6px;
  padding: 6px 8px;
  cursor: pointer;
  text-align: left;
}

[data-vela-nav]:hover { background: var(--vela-hover); }
[data-vela-nav][aria-pressed='true'] {
  background: var(--vela-accent-soft);
  color: var(--vela-accent);
  font-weight: 500;
}
[data-vela-nav]:focus-visible {
  outline: 2px solid var(--vela-accent);
  outline-offset: -2px;
}
[data-vela-nav][data-wide='false'] { justify-content: center; padding: 6px 0; }

/* ── 窄屏与降低动效 ─────────────────────────────────────── */

@media (max-width: 720px) {
  /* 窄屏一列一列看：列占大部分可见宽度，横滑看下一列。下限与主规则一致
     （240px），不能比它还低——否则窄窗口反而比宽窗口更挤，那就反了。 */
  [data-vela-grid] { grid-auto-columns: minmax(240px, 84vw); }
}

/* 横向滚动条：六列放不下时它是唯一的线索，不能藏起来。 */
[data-vela-grid]::-webkit-scrollbar { height: 8px; }
[data-vela-grid]::-webkit-scrollbar-thumb {
  background: var(--vela-scroll);
  border-radius: 4px;
}

@media (prefers-reduced-motion: reduce) {
  [data-vela-panel] *,
  [data-vela-live]::before {
    animation: none !important;
    transition: none !important;
  }
}

/* ── 面板主体：左导航 + 右内容 ───────────────────────────── */

/* ── 小队并行时间轴（票 10）─────────────────────── */

[data-vela-timeline] {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px dashed var(--vela-line);
}

[data-vela-timeline-scale] {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--vela-text-3);
  font-variant-numeric: tabular-nums;
}

/* 一条泳道：左标签 / 中间轨道 / 右状态。轨道占剩下的全部宽度，因为
   重叠关系全靠那一段传达。 */
[data-vela-lane] {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

[data-vela-panel] button[data-vela-lane-label] {
  all: unset;
  cursor: pointer;
  flex: 0 0 8rem;
  display: flex;
  flex-direction: column;
  font: inherit;
  font-size: 11px;
  text-align: left;
  overflow: hidden;
}

[data-vela-panel] button[data-vela-lane-label]:hover [data-vela-lane-task] {
  text-decoration: underline;
}

[data-vela-panel] button[data-vela-lane-label]:focus-visible {
  outline: 2px solid var(--vela-accent);
  outline-offset: 1px;
}

[data-vela-lane-member] {
  font-weight: 600;
  color: var(--vela-text);
}

/* 任务描述可能很长。单行截断而不换行：泳道高度不齐会让重叠关系变难读。
   完整文本在 title 里。 */
[data-vela-lane-task] {
  color: var(--vela-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

[data-vela-lane-track] {
  flex: 1 1 auto;
  min-width: 0;
  block-size: 10px;
  border-radius: 5px;
  background: var(--vela-line);
  overflow: hidden;
}

[data-vela-lane-bar] {
  block-size: 100%;
  border-radius: 5px;
  background: var(--vela-text-3);
}

[data-vela-lane][data-tone="ok"] [data-vela-lane-bar] { background: var(--vela-ok); }
[data-vela-lane][data-tone="bad"] [data-vela-lane-bar] { background: var(--vela-danger); }
[data-vela-lane][data-tone="running"] [data-vela-lane-bar] {
  background: var(--vela-accent);
  animation: vela-lane-pulse 1.6s ease-in-out infinite;
}

@keyframes vela-lane-pulse {
  50% { opacity: .55; }
}

[data-vela-lane-status] {
  flex: 0 0 6rem;
  text-align: right;
  color: var(--vela-text-3);
  font-variant-numeric: tabular-nums;
}

/* 队员干完写的那句总结：泳道下方的小字，验收先看它。 */
[data-vela-lane-summary] {
  margin-top: 3px;
  padding: 5px 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--vela-text-2);
  background: var(--vela-inset);
  border-radius: 6px;
  overflow-wrap: anywhere;
}

[data-vela-timeline-note] {
  margin: 2px 0 0;
  font-size: 10px;
  line-height: 1.4;
  color: var(--vela-text-3);
}

[data-vela-timeline-empty] {
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px dashed var(--vela-line);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

/* 搜索框（票 11）。它得能伸缩：顶栏里还有 Workspace 筛选与两个按钮。 */
[data-vela-search] {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 18rem;
  min-width: 8rem;
}

[data-vela-search] input {
  flex: 1 1 auto;
  min-width: 0;
}

[data-vela-search-hits] {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--vela-text-3);
  font-variant-numeric: tabular-nums;
}

/* 搜索无结果。占整个内容区而不是塞在某一列里：六条空泳道看起来像
   看板被清空了，而那是个令人心惊的误会。 */
[data-vela-no-results] {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 20px;
  text-align: center;
  color: var(--vela-text-2);
}

[data-vela-no-results] p {
  margin: 0;
}

[data-vela-drawer] {
  flex: 0 0 40%;
  min-width: 320px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--vela-line);
  background: var(--vela-lane);
  animation: vela-drawer-in .14s ease-out;
}

@keyframes vela-drawer-in {
  from { opacity: 0; transform: translateX(12px); }
  to { opacity: 1; transform: none; }
}

[data-vela-drawer]:focus-visible {
  outline: 2px solid var(--vela-accent);
  outline-offset: -2px;
}

[data-vela-drawer-head] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--vela-line);
}

[data-vela-drawer-lane] {
  font-size: 11px;
  color: var(--vela-text-2);
}

[data-vela-drawer-body] {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

[data-vela-drawer-label] {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--vela-text-2);
}

[data-vela-drawer-actions] {
  display: flex;
  gap: 6px;
}

[data-vela-drawer-section] {
  margin: 6px 0 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--vela-text-3);
}

[data-vela-fields] {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

[data-vela-field] {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

[data-vela-field-label] {
  flex: 0 0 5.5rem;
  color: var(--vela-text-3);
}

[data-vela-field-value] {
  flex: 1 1 auto;
  color: var(--vela-text);
  word-break: break-all;
}

[data-vela-muted] {
  margin: 0;
  font-size: 12px;
  color: var(--vela-text-3);
}

[data-vela-run] {
  padding: 6px 8px;
  border: 1px solid var(--vela-line);
  border-left: 3px solid var(--vela-text-3);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

[data-vela-run][data-outcome="completed"] { border-left-color: var(--vela-ok); }
[data-vela-run][data-outcome="error"] { border-left-color: var(--vela-danger); }
[data-vela-run][data-outcome="timeout"] { border-left-color: var(--vela-warn); }
[data-vela-run][data-outcome="aborted"] { border-left-color: var(--vela-warn); }
[data-vela-run][data-outcome="running"] { border-left-color: var(--vela-accent); }

[data-vela-run-head] {
  display: flex;
  align-items: center;
  gap: 8px;
}

[data-vela-run-ordinal] {
  font-size: 12px;
  font-weight: 600;
}

[data-vela-run-outcome] {
  font-size: 11px;
  color: var(--vela-text-2);
}

[data-vela-run-failure] {
  margin: 0;
  font-size: 11px;
  color: var(--vela-danger);
  word-break: break-word;
}

[data-vela-card][data-selected="true"] {
  border-color: var(--vela-accent);
  box-shadow: inset 0 0 0 1px var(--vela-accent);
}

[data-vela-panel] button[data-vela-card-title] {
  all: unset;
  cursor: pointer;
  flex: 1 1 auto;
  font: inherit;
  text-align: left;
  color: var(--vela-text);
  word-break: break-word;
}

[data-vela-panel] button[data-vela-card-title]:hover {
  text-decoration: underline;
}

[data-vela-panel] button[data-vela-card-title]:focus-visible {
  outline: 2px solid var(--vela-accent);
  outline-offset: 1px;
}

[data-vela-body] {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

[data-vela-sidebar] {
  flex: 0 0 auto;
  width: 176px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 6px;
  overflow-y: auto;
  border-right: 1px solid var(--vela-line);
  background: var(--vela-lane);
}

[data-vela-nav-group] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-bottom: 10px;
}

[data-vela-nav-group-title] {
  padding: 4px 8px 2px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--vela-text-3);
}

/* 导航项重置掉面板里通用的按钮样式：它们是列表行，不是控件。 */
[data-vela-panel] [data-vela-nav-item] {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--vela-text-2);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

[data-vela-panel] [data-vela-nav-item]:hover:not(:disabled) {
  background: var(--vela-hover);
  color: var(--vela-text);
}

[data-vela-panel] [data-vela-nav-item][data-active="true"] {
  background: var(--vela-accent-soft);
  border-color: var(--vela-accent);
  color: var(--vela-accent);
  font-weight: 600;
}

/* 置灏项：看得见但明确不可点。悬停提示里写着原因（ADR-0020）。 */
[data-vela-panel] [data-vela-nav-item]:disabled {
  color: var(--vela-text-3);
  opacity: .55;
  cursor: not-allowed;
}

[data-vela-nav-glyph] {
  flex: none;
  width: 15px;
  text-align: center;
  font-size: 12px;
}

[data-vela-nav-label] {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-vela-nav-badge] {
  flex: none;
  min-width: 17px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--vela-accent);
  color: var(--vela-accent-text);
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

[data-vela-notice] {
  padding: 3px 8px;
  border-radius: 5px;
  background: var(--vela-warn-soft);
  color: var(--vela-warn);
  font-size: 11px;
}

/* ── 小队页 ────────────────────────────────────────────── */

[data-vela-squads] {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 14px 18px;
}

[data-vela-squads] h2 {
  margin: 0;
  font-size: 15px;
}

[data-vela-squads] h3 {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--vela-text-2);
}

[data-vela-squad-head] {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

[data-vela-squad-head] h2,
[data-vela-squad-head] h3 {
  flex: 1 1 auto;
}

[data-vela-squad-row] {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 9px 11px;
  margin-bottom: 7px;
  border: 1px solid var(--vela-line-soft);
  border-radius: 7px;
  background: var(--vela-card);
  box-shadow: var(--vela-card-shadow);
}

[data-vela-squad-title] {
  flex: 0 0 auto;
  font-weight: 600;
}

[data-vela-squad-meta] {
  flex: 1 1 auto;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

[data-vela-squad-editor] {
  max-width: 720px;
}

/* 每个区块自己一张卡：「整支队的设置」与「队员」必须看上去就是两层
   （ADR-0017：沙箱档位是队级的，工具白名单是队员级的）。 */
[data-vela-squad-section] {
  padding: 11px 13px;
  margin: 10px 0;
  border: 1px solid var(--vela-line-soft);
  border-radius: 7px;
  background: var(--vela-card);
}

[data-vela-squad-section="squad"] {
  border-left: 3px solid var(--vela-accent);
}

/* 队员卡：紧凑的四行布局（名字行 / 职责 / 能力 / 白名单小字），
   不再是每个字段独占一行的九层高卡。背景提到卡片色——比页面亮一档，
   与输入框的凹槽底（更深）拉开层次。 */
[data-vela-member] {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  margin-bottom: 9px;
  border: 1px solid var(--vela-line-soft);
  border-radius: 8px;
  background: var(--vela-card);
  box-shadow: var(--vela-card-shadow);
}

/* 短字段限宽：名字吃掉剩余宽度，后端与移除按钮挤在行尾。特异性要盖过
   面板里通用的 [data-vela-panel] input { width:100% }，所以从 member-head 选。 */
[data-vela-member-head] {
  display: flex;
  align-items: center;
  gap: 8px;
}

[data-vela-member-head] input {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
}

[data-vela-member-head] select {
  flex: 0 0 auto;
  width: auto;
}

[data-vela-member-instruction] {
  width: 100%;
}

[data-vela-member-tools] {
  font-size: 11px;
  color: var(--vela-text-3);
  overflow-wrap: anywhere;
}

/* ── 小队界面的质感层 ─────────────────────────────────── */

/* 详情页与创建弹窗里的输入框用凹槽底色：深色界面里输入框要比所在表面
   更深（凹进去），不是更亮——之前输入框与卡片同一个色，整个表单糊成一片。 */
[data-vela-panel] [data-vela-squad-detail] input,
[data-vela-panel] [data-vela-squad-detail] select,
[data-vela-panel] [data-vela-squad-detail] textarea,
[data-vela-panel] [data-vela-modal] input,
[data-vela-panel] [data-vela-modal] textarea {
  background: var(--vela-inset);
}

[data-vela-panel] [data-vela-squad-detail] input:focus,
[data-vela-panel] [data-vela-squad-detail] select:focus,
[data-vela-panel] [data-vela-squad-detail] textarea:focus,
[data-vela-panel] [data-vela-modal] input:focus,
[data-vela-panel] [data-vela-modal] textarea:focus {
  border-color: var(--vela-accent);
}

/* 字母徽：名字的缩略圆。同一个名字永远同一个色（按名字哈希），
   在列表、详情、时间轴里扫一眼就认出「这个人」。 */
[data-vela-avatar] {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--vela-avatar-text);
  background: var(--vela-avatar-0);
  user-select: none;
}

[data-vela-avatar][data-hue='0'] { background: var(--vela-avatar-0); }
[data-vela-avatar][data-hue='1'] { background: var(--vela-avatar-1); }
[data-vela-avatar][data-hue='2'] { background: var(--vela-avatar-2); }
[data-vela-avatar][data-hue='3'] { background: var(--vela-avatar-3); }
[data-vela-avatar][data-hue='4'] { background: var(--vela-avatar-4); }
[data-vela-avatar][data-hue='5'] { background: var(--vela-avatar-5); }
[data-vela-avatar][data-hue='leader'] { background: var(--vela-accent); }

/* 队长卡：成员列表最前面那张。左边一条 accent 竖条 + 徽章——
   它不是 members 数组里的一条，但界面上它必须可见：小队里「有谁」，
   队长不该隐身。 */
[data-vela-leader] {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--vela-line-soft);
  border-left: 3px solid var(--vela-accent);
  border-radius: 8px;
  background: var(--vela-card);
  box-shadow: var(--vela-card-shadow);
}

[data-vela-leader-name] {
  font-weight: 600;
  font-size: 13px;
}

[data-vela-leader-badge] {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .5px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--vela-accent-soft);
  color: var(--vela-accent);
}

/* 队长卡里的能力是只读展示（来自基准 preset，这里改不了），
   不要让鼠标悬停给出「可点」的错觉。 */
[data-vela-abilities][data-readonly] [data-vela-ability] span {
  cursor: default;
}

/* 列表行：字母徽 + 主体（标题与标签纵向） + 删除。 */
[data-vela-squad-main] {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 成员 tab 的「加队员」区：主按钮 + 展开后的模板卡片区。 */
[data-vela-squad-add] {
  display: flex;
  gap: 6px;
  align-items: center;
}

[data-vela-squad-add] select {
  width: auto;
  flex: 0 0 auto;
}

/* 队员卡网格：宽屏下用满整个宽度，而不是左侧一列到底。 */
[data-vela-member-grid] {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
  gap: 9px;
  align-items: start;
}

/* 网格里每张卡自己撑满格子，不再用 margin 推开。 */
[data-vela-member-grid] [data-vela-member] {
  margin-bottom: 0;
}

/* ── 「加队员」弹窗的模板卡片网格 ─────────────────────────
 * 住在 AddMemberDialog 的弹窗体里（曾是详情页的内联展开区）。
 * 一排角色卡，点卡即用该模板加进来。每张卡讲清三件事：叫什么、
 * 干什么、默认带哪些能力——让人在点之前就知道自己会得到什么。
 * 弹窗宽度固定，网格固定两列（对齐 Waker 参照的形态），不随宽度变三列。 */
[data-vela-template-grid] {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

[data-vela-template-card] {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  padding: 9px 10px;
  text-align: start;
  border: 1px solid var(--vela-line-soft);
  border-radius: 8px;
  background: var(--vela-card);
  color: var(--vela-text);
  cursor: pointer;
  font: inherit;
  box-shadow: none;
}

[data-vela-template-card]:hover {
  border-color: var(--vela-accent);
  background: var(--vela-hover);
}

[data-vela-template-head] {
  display: flex;
  align-items: center;
  gap: 7px;
}

[data-vela-template-name] {
  font-weight: 600;
  font-size: 13px;
}

/* 默认队员名（队长眼里的工具名），小字跟在中文名后面。 */
[data-vela-template-tool] {
  font-size: 11px;
  color: var(--vela-text-3);
  font-family: ui-monospace, monospace;
}

[data-vela-template-blurb] {
  font-size: 12px;
  line-height: 1.5;
  color: var(--vela-text-2);
}

[data-vela-template-abilities] {
  font-size: 11px;
  color: var(--vela-text-3);
}

/* 空白队员卡：虚线，视觉上明显是「另一个物种」。 */
[data-vela-template-card][data-tone='blank'] {
  border-style: dashed;
  background: transparent;
}

[data-vela-template-plus] {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  color: var(--vela-text-3);
  border: 1px dashed var(--vela-line);
}

[data-vela-abilities] {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

/* 能力是可点的 chip：checkbox 视觉隐藏（键盘与语义保留），span 做成 chip。
   选中的实心高亮，没选的描边——一眼看出这个队员能用哪几类。 */
[data-vela-ability] {
  position: relative;
  display: inline-flex;
}

[data-vela-ability] input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
  margin: 0;
}

[data-vela-ability] span {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--vela-line);
  background: var(--vela-card);
  color: var(--vela-text-2);
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  user-select: none;
}

[data-vela-ability]:hover span {
  border-color: var(--vela-accent);
}

[data-vela-ability][data-on="true"] span {
  background: var(--vela-accent);
  border-color: var(--vela-accent);
  color: var(--vela-accent-text);
  font-weight: 500;
}

[data-vela-ability] input:focus-visible + span {
  outline: 2px solid var(--vela-accent);
  outline-offset: 1px;
}

/* 整支队的设置：几个短字段并排，不再一个占一行。 */
[data-vela-field-row] {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  align-items: flex-end;
}

[data-vela-field-row] label {
  flex: 0 1 auto;
  margin: 4px 0;
}

[data-vela-field-row] select,
[data-vela-field-row] input {
  width: auto;
  min-width: 0;
}

/* 名册默认折叠成一行，点开才看。 */
[data-vela-roster-fold] {
  margin-top: 6px;
}

[data-vela-roster-fold] summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--vela-text-2);
  user-select: none;
}

[data-vela-roster-fold] summary:hover {
  color: var(--vela-accent);
}

/* 编辑器顶部的小队名字：短输入，不撑满整行。 */
[data-vela-squad-editor] > label > input {
  max-width: 340px;
}

/* 队长实际收到的名册：只读展示，要看得出是自动生成的。 */
[data-vela-roster] {
  margin: 5px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--vela-canvas);
  color: var(--vela-text-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 190px;
  overflow-y: auto;
}

[data-vela-squads] label {
  display: block;
  margin: 7px 0;
  font-size: 12px;
  color: var(--vela-text-2);
}

[data-vela-squads] textarea {
  resize: vertical;
  font-family: inherit;
}

/* ── 小队：创建弹窗与详情页 ─────────────────────────────── */

/* 遮罩：盖在整个面板上，点外面关闭。 */
[data-vela-modal-backdrop] {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: var(--vela-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

[data-vela-modal] {
  width: min(560px, 100%);
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  border: 1px solid var(--vela-line);
  background: var(--vela-card);
  box-shadow: var(--vela-card-shadow);
}

[data-vela-modal-head] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vela-line);
  font-size: 14px;
}

[data-vela-modal-body] {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 14px 16px;
}

[data-vela-modal-field] {
  display: block;
  margin: 10px 0;
  font-size: 12px;
  color: var(--vela-text-2);
}

[data-vela-modal-field] input,
[data-vela-modal-field] textarea {
  margin-top: 4px;
}

[data-vela-modal-foot] {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--vela-line);
}

/* 详情页 */
[data-vela-squad-detail] {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
  /* 不限宽：面板是全幅的，详情内容要铺满——之前 760px 的限宽让宽屏右侧大片空白。 */
}

[data-vela-detail-head] {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

[data-vela-back] {
  flex: 0 0 auto;
}

/* 小队名字做成像标题的输入：平时无边框，悬停/聚焦才露出可编辑。特异性盖过通用 input。 */
[data-vela-panel] input[data-vela-detail-title] {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--vela-text);
  border: 1px solid transparent;
  background: transparent;
}

[data-vela-panel] input[data-vela-detail-title]:hover {
  border-color: var(--vela-line);
  background: var(--vela-card);
}

[data-vela-panel] input[data-vela-detail-title]:focus {
  border-color: var(--vela-accent);
  background: var(--vela-card);
}

/* tab 条：按钮做成下划线式，不是通用按钮的卡片样式。特异性盖过 [data-vela-panel] button。 */
[data-vela-tabs] {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--vela-line);
  margin-bottom: 12px;
}

[data-vela-panel] [data-vela-tabs] button {
  border: none;
  background: transparent;
  padding: 7px 12px;
  font-size: 13px;
  color: var(--vela-text-2);
  border-bottom: 2px solid transparent;
  border-radius: 0;
  margin-bottom: -1px;
}

[data-vela-panel] [data-vela-tabs] button:hover:not(:disabled) {
  color: var(--vela-text);
  background: transparent;
}

[data-vela-panel] [data-vela-tabs] button[data-active="true"] {
  color: var(--vela-accent);
  border-bottom-color: var(--vela-accent);
  font-weight: 600;
}

[data-vela-detail-body] {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

[data-vela-detail-foot] {
  display: flex;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--vela-line);
  margin-top: 12px;
}

/* 小队签：与其余 chip 区分开，一眼看得出这张卡背后是一队而不是一人。 */
[data-vela-chip][data-tone="squad"] {
  border-color: var(--vela-accent);
  background: var(--vela-accent-soft);
  color: var(--vela-accent);
}

/* ── 会话头部的提取入口（票 13）──────────────────────────
 * 这一块长在**宿主自己的**会话头里，不在 Vela 面板里，因此它拿不到
 * [data-vela-panel] 那一层色板。色板的选择器因此得把提取块也包进去（见
 * 开头那两个选择器里的 [data-vela-extract]），否则这里的 var() 全部解不开。
 */
[data-vela-extract-open] {
  font: inherit;
  font-size: 12px;
  padding: 3px 9px;
  border-radius: 6px;
  border: 1px solid var(--vela-line);
  background: var(--vela-card);
  color: var(--vela-text-2);
  cursor: pointer;
}

[data-vela-extract-open]:hover {
  background: var(--vela-hover);
  color: var(--vela-text);
}

[data-vela-extract] {
  width: min(420px, 90vw);
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--vela-line);
  background: var(--vela-card);
  box-shadow: var(--vela-card-shadow);
  font-size: 13px;
  color: var(--vela-text);
}

[data-vela-extract-head] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

[data-vela-extract-head] button {
  font: inherit;
  font-size: 15px;
  line-height: 1;
  padding: 2px 6px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--vela-text-2);
  cursor: pointer;
}

[data-vela-extract-note] {
  margin: 4px 0;
  font-size: 11px;
  color: var(--vela-text-2);
  /* 路径很长，得允许在任意处折，否则会把弹层撑宽。 */
  overflow-wrap: anywhere;
}

[data-vela-extract-note][data-tone="warn"] { color: var(--vela-warn); }
[data-vela-extract-note][data-tone="bad"] { color: var(--vela-danger); }

[data-vela-extract-empty] {
  padding: 10px 2px;
  font-size: 12px;
  color: var(--vela-text-2);
}

[data-vela-extract-list] {
  list-style: none;
  margin: 6px 0;
  padding: 0;
  /* 候选可能很多（一次长讨论能拿出二三十条），弹层本身不能无限长。 */
  max-height: 46vh;
  overflow-y: auto;
}

[data-vela-extract-list] li { margin: 2px 0; }

[data-vela-extract-list] label {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  padding: 4px 5px;
  border-radius: 6px;
  cursor: pointer;
  /* 标题会很长，换行而不是溢出去压到旁边。 */
  overflow-wrap: anywhere;
}

[data-vela-extract-list] label:hover { background: var(--vela-hover); }

[data-vela-extract-list] input { margin-top: 3px; }

[data-vela-extract-foot] {
  display: flex;
  gap: 7px;
  margin-top: 8px;
}

[data-vela-extract-foot] button {
  font: inherit;
  font-size: 12px;
  padding: 5px 11px;
  border-radius: 7px;
  border: 1px solid var(--vela-line);
  background: var(--vela-card);
  color: var(--vela-text);
  cursor: pointer;
}

[data-vela-extract-create] {
  border-color: transparent !important;
  background: var(--vela-accent) !important;
  /* 要用色板里的强调色字，不能硬写白色：夜间的强调色是亮靛蓝，
     配白字读不清——色板里的 --vela-accent-text 在夜间正是深色。 */
  color: var(--vela-accent-text) !important;
}

[data-vela-extract-foot] button:disabled {
  opacity: .5;
  cursor: not-allowed;
}

/* ── 技能广场：三个来源各占一列，与看板泳道同款 ──────────── */

[data-vela-skills] {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 14px 18px;
  /* 列自己滚动，页面不滚——列头始终在视野里。 */
  overflow: hidden;
}

[data-vela-skills] h2 {
  margin: 0;
  font-size: 15px;
}

[data-vela-skill-head] {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex: 0 0 auto;
}

[data-vela-skill-head] h2 { flex: 1 1 auto; }

[data-vela-skill-cols] {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  gap: 12px;
}

/* 一列 = 一个来源。外观对齐看板泳道：描边 + 淡底 + 圆角。 */
[data-vela-skill-col] {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--vela-line);
  border-radius: 8px;
  background: var(--vela-lane);
  overflow: hidden;
}

[data-vela-skill-col-head] {
  flex: 0 0 auto;
  padding: 9px 11px 7px;
  border-bottom: 1px solid var(--vela-line-soft);
}

[data-vela-skill-col-head] h3 {
  margin: 0;
  font-size: 12px;
  color: var(--vela-text-2);
}

[data-vela-skill-hint] {
  font-size: 11px;
  color: var(--vela-text-3);
  margin-top: 2px;
}

[data-vela-skill-col-body] {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}

/* 紧凑卡：字母徽 + 名字 + 一行描述，点开看详情。 */
[data-vela-skill-row] {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 9px;
  margin-bottom: 7px;
  border: 1px solid var(--vela-line-soft);
  border-radius: 7px;
  background: var(--vela-card);
  box-shadow: var(--vela-card-shadow);
  cursor: pointer;
  transition: border-color 120ms ease;
}

[data-vela-skill-row]:hover { border-color: var(--vela-line); }
[data-vela-skill-row]:focus-visible {
  outline: 2px solid var(--vela-accent);
  outline-offset: 1px;
}

/* 被同名盖住的技能整行调淡：它还在磁盘上，但生效的不是它。 */
[data-vela-skill-row][data-dim='true'] { opacity: .55; }

[data-vela-skill-main] {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

[data-vela-skill-title] {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

[data-vela-skill-title] code {
  font-weight: 600;
  font-size: 12.5px;
}

/* 卡片上的描述只有一行：详情在弹窗里。 */
[data-vela-skill-row] [data-vela-skill-desc] {
  font-size: 12px;
  color: var(--vela-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

[data-vela-skill-problem] {
  font-size: 12px;
  color: var(--vela-warn);
}

/* 详情弹窗里的字段块。 */
[data-vela-skill-dialog-title] {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 14px;
}

[data-vela-skill-field] { margin-bottom: 12px; }

[data-vela-skill-field-label] {
  font-size: 11px;
  color: var(--vela-text-3);
  margin-bottom: 3px;
}

[data-vela-skill-path] {
  font-size: 11px;
  color: var(--vela-text-3);
  word-break: break-all;
}

[data-vela-skill-footer] {
  flex: 0 0 auto;
  margin-top: 8px;
  font-size: 11px;
  color: var(--vela-text-3);
}

/* ── 记忆页：一个工作区一列，形态与技能广场一致 ────────── */

[data-vela-memory] {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 14px 18px;
  overflow: hidden;
}

[data-vela-memory] h2 {
  margin: 0;
  font-size: 15px;
}

[data-vela-recap-head] {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex: 0 0 auto;
}

[data-vela-recap-head] h2 { flex: 1 1 auto; }

[data-vela-recap-cols] {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  gap: 12px;
  overflow-x: auto;
}

/* 一列 = 一个工作区。列数随工作区变，因此给一个最小宽并允许横向滚。 */
[data-vela-recap-col] {
  flex: 1 1 0;
  min-width: 240px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--vela-line);
  border-radius: 8px;
  background: var(--vela-lane);
  overflow: hidden;
}

[data-vela-recap-col-head] {
  flex: 0 0 auto;
  padding: 9px 11px 7px;
  border-bottom: 1px solid var(--vela-line-soft);
}

[data-vela-recap-col-head] h3 {
  margin: 0;
  font-size: 12px;
  color: var(--vela-text-2);
  word-break: break-all;
}

[data-vela-recap-hint] {
  font-size: 11px;
  color: var(--vela-text-3);
  margin-top: 2px;
}

[data-vela-recap-col-body] {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}

[data-vela-recap-row] {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 9px;
  margin-bottom: 7px;
  border: 1px solid var(--vela-line-soft);
  border-radius: 7px;
  background: var(--vela-card);
  box-shadow: var(--vela-card-shadow);
  cursor: pointer;
  transition: border-color 120ms ease;
}

[data-vela-recap-row]:hover { border-color: var(--vela-line); }
[data-vela-recap-row]:focus-visible {
  outline: 2px solid var(--vela-accent);
  outline-offset: 1px;
}

/* 废弃或陈旧的整行调淡：它还在目录里，但不会被带给 Agent。 */
[data-vela-recap-row][data-dim='true'] { opacity: .55; }

[data-vela-recap-main] {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

[data-vela-recap-title] {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
}

[data-vela-recap-when] {
  font-size: 11px;
  color: var(--vela-text-3);
}

[data-vela-recap-problem] {
  font-size: 12px;
  color: var(--vela-warn);
}

[data-vela-recap-dialog-title] {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 14px;
}

[data-vela-recap-field] { margin-bottom: 12px; }

[data-vela-recap-field-label] {
  font-size: 11px;
  color: var(--vela-text-3);
  margin-bottom: 3px;
}

[data-vela-recap-path] {
  font-size: 11px;
  color: var(--vela-text-3);
  word-break: break-all;
}

/* 正文原样展示：它是 Markdown，不渲染成 HTML——这一页要让人看到
   文件里到底写的是什么，而不是它渲染后好不好看。 */
[data-vela-recap-body] {
  margin: 0;
  padding: 10px;
  border: 1px solid var(--vela-line-soft);
  border-radius: 6px;
  background: var(--vela-lane);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 42vh;
  overflow-y: auto;
}

[data-vela-recap-confirm] {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--vela-text-2);
}

[data-vela-recap-log] {
  flex: 0 0 auto;
  margin-top: 10px;
  font-size: 11px;
  color: var(--vela-text-3);
  max-height: 22vh;
  overflow-y: auto;
}

[data-vela-recap-log] summary { cursor: pointer; }

[data-vela-recap-log] ul {
  margin: 6px 0 0;
  padding-left: 18px;
}

[data-vela-recap-footer] {
  flex: 0 0 auto;
  margin-top: 8px;
  font-size: 11px;
  color: var(--vela-text-3);
}
`;
		/**
		* 注入 Vela 的样式并返回撤销函数。重复调用是幂等的（HMR 会重挂 client fiber），
		* 因此以标签上的标识去重。
		*/
		function installStyles(doc) {
			if (doc === void 0) return () => void 0;
			if (doc.querySelector(`style[data-plugin="${TAG}"]`) !== null) return () => void 0;
			const tag = doc.createElement("style");
			tag.setAttribute("data-plugin", TAG);
			tag.textContent = CSS;
			doc.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		//#endregion
		//#region src/client/components/BoardNav.tsx
		/**
		* sidebar 页脚的导航项（票 03）。点击切换 Board 面板；订阅 panel-state 让激活
		* 态实时反映面板开合。宽态显示文字，折叠态只留图标。
		*
		* 注入面是**直接铺平到 props 上**的（框架的 SlotInjectFace 把 inject 工厂的
		* 返回值展开进 props），不套在 props.inject 里。
		*/
		/** 导航项组件。 */
		function BoardNav(props) {
			const { panel } = props;
			const isOpen = (0, react.useSyncExternalStore)((listener) => panel.subscribe(listener), () => panel.isOpen(), () => panel.isOpen());
			const wide = props.wide ?? true;
			return (0, react.createElement)("button", {
				type: "button",
				onClick: () => panel.toggle(),
				"data-vela-nav": "",
				"data-wide": String(wide),
				"aria-pressed": isOpen,
				"aria-label": "Vela board",
				title: wide ? void 0 : "Vela board"
			}, (0, react.createElement)("span", { "aria-hidden": "true" }, "▦"), ...wide ? [(0, react.createElement)("span", { key: "label" }, "Vela")] : []);
		}
		//#endregion
		//#region src/domain/search.ts
		/**
		* 一条查询能不能命中一张卡。
		*
		* 三条判据，取并集：
		*
		* 1. **编号**。`V-12`、`v-12`、`12` 都命中 12 号，因为 Operator 嘴上说的、
		*    复制粘贴的、以及顺手只打数字的，都是同一个意图。
		* 2. **标题**子串，大小写不敏感。
		* 3. **描述**子串，大小写不敏感。
		*
		* 编号是**精确**匹配而不是子串：输入 `1` 时把 1、10、11、100 全捞出来毫无用处。
		* 但纯数字同时也会去撞标题与描述的子串——那条路径上 `1` 匹配「第 1 步」是对的。
		*/
		function matchesQuery(issue, query) {
			const needle = query.trim().toLowerCase();
			if (needle.length === 0) return true;
			const bare = needle.startsWith("V-".toLowerCase()) ? needle.slice(2) : needle;
			if (/^\d+$/.test(bare) && Number(bare) === issue.number) return true;
			if (issue.title.toLowerCase().includes(needle)) return true;
			return issue.description.toLowerCase().includes(needle);
		}
		/**
		* 过滤出命中的卡。
		*
		* 空查询返回**传进来的那个数组本身**，不是一份副本：这条路径每次轮询都会走，
		* 返回新数组会让下游的 memo 全部失效，白白重渲整个看板。
		*/
		function searchIssues(issues, query) {
			if (query.trim().length === 0) return issues;
			return issues.filter((issue) => matchesQuery(issue, query));
		}
		//#endregion
		//#region src/domain/ordering.ts
		/** 按 position 升序、同值时按 id 稳定排序。 */
		function byPosition(a, b) {
			if (a.position !== b.position) return a.position - b.position;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
		/** Operator 能否把一张卡片从 `from` 拖到 `to`。 */
		function canOperatorMove(from, to) {
			if (from === to) return true;
			return OPERATOR_TRANSITIONS[from].includes(to);
		}
		//#endregion
		//#region src/domain/board.ts
		/** 一个 Issue 当前的活 Run（至多一个）。 */
		function activeRun(issue) {
			return issue.runs.find((run) => run.status === "running");
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
		/** 计费输入 token：三类互斥输入之和。 */
		function billedInputTokens(usage) {
			return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
		}
		/** 一次 Run 的总 token：计费输入 + 输出。推理 token 已含在输出里，不再加。 */
		function totalTokens(usage) {
			return billedInputTokens(usage) + usage.outputTokens;
		}
		/** 一个 Issue 的全部 Run 的累计用量。缺失用量的 Run 不参与累加。 */
		function sumUsage(usages) {
			let total;
			for (const usage of usages) {
				if (usage === void 0) continue;
				total = total === void 0 ? usage : addUsage(total, usage);
			}
			return total;
		}
		//#endregion
		//#region src/client/components/EditIssueForm.tsx
		/**
		* 卡片的就地编辑表单（票 05/11）。除了标题、描述、Workspace、优先级，还承担
		* **单卡片的执行配置覆盖**：agent preset、权限档位、超时、自动重试上限。
		*
		* 覆盖项一律以「跟随全局默认」为默认选项——空值表示不覆盖，而不是覆盖成空。
		* 这让一键派活的手感保持不变：绝大多数卡片什么都不设。
		*/
		/** 「跟随全局默认」的哨兵值。 */
		const INHERIT$1 = "";
		const PRIORITY_LABELS$1 = {
			none: "无",
			low: "低",
			medium: "中",
			high: "高",
			urgent: "紧急"
		};
		/** 编辑表单。 */
		function EditIssueForm(props) {
			const { issue, client, onDone, onCancel } = props;
			const [title, setTitle] = (0, react.useState)(issue.title);
			const [description, setDescription] = (0, react.useState)(issue.description);
			const [workspace, setWorkspace] = (0, react.useState)(issue.workspace);
			const [priority, setPriority] = (0, react.useState)(issue.priority);
			const [maxAttempts, setMaxAttempts] = (0, react.useState)(String(issue.maxAttempts));
			const [sandbox, setSandbox] = (0, react.useState)(issue.exec.sandbox ?? INHERIT$1);
			const [agentPreset, setAgentPreset] = (0, react.useState)(issue.exec.agentPreset ?? INHERIT$1);
			const [squad, setSquad] = (0, react.useState)(issue.exec.squad ?? INHERIT$1);
			const [timeoutText, setTimeoutText] = (0, react.useState)(issue.exec.timeoutMs === void 0 ? INHERIT$1 : String(Math.round(issue.exec.timeoutMs / 1e3)));
			const [busy, setBusy] = (0, react.useState)(false);
			const [local, setLocal] = (0, react.useState)(void 0);
			const submit = async () => {
				if (title.trim().length === 0) {
					setLocal("标题必填");
					return;
				}
				if (workspace.trim().length === 0) {
					setLocal("Workspace 必填");
					return;
				}
				const attempts = Number(maxAttempts);
				if (!Number.isInteger(attempts) || attempts < 0) {
					setLocal("自动重试上限必须是非负整数");
					return;
				}
				const seconds = timeoutText.trim() === INHERIT$1 ? void 0 : Number(timeoutText);
				if (seconds !== void 0 && (!Number.isFinite(seconds) || seconds < 0)) {
					setLocal("超时必须是非负秒数");
					return;
				}
				setBusy(true);
				setLocal(void 0);
				try {
					const result = await client.updateIssue(issue.id, {
						title: title.trim(),
						description,
						workspace: workspace.trim(),
						priority,
						maxAttempts: attempts,
						exec: {
							sandbox: sandbox === INHERIT$1 ? null : sandbox,
							squad: squad === INHERIT$1 ? null : squad,
							agentPreset: squad !== INHERIT$1 || agentPreset.trim() === INHERIT$1 ? null : agentPreset.trim(),
							timeoutMs: seconds === void 0 ? null : Math.round(seconds * 1e3)
						}
					});
					if (!result.ok) {
						setLocal(result.message);
						return;
					}
					onDone();
				} finally {
					setBusy(false);
				}
			};
			const field = (label, control) => (0, react.createElement)("label", {
				key: label,
				style: { display: "block" }
			}, (0, react.createElement)("span", { "data-vela-hint": "" }, label), control);
			return (0, react.createElement)("form", {
				"data-vela-form": "",
				onSubmit: (event) => {
					event.preventDefault();
					submit();
				}
			}, field("标题", (0, react.createElement)("input", {
				"aria-label": "edit title",
				value: title,
				onChange: (event) => setTitle(event.target.value)
			})), field("描述", (0, react.createElement)("textarea", {
				"aria-label": "edit description",
				value: description,
				rows: 3,
				onChange: (event) => setDescription(event.target.value)
			})), field("Workspace", (0, react.createElement)("input", {
				"aria-label": "edit workspace",
				value: workspace,
				onChange: (event) => setWorkspace(event.target.value)
			})), field("优先级", (0, react.createElement)("select", {
				"aria-label": "edit priority",
				value: priority,
				onChange: (event) => setPriority(event.target.value)
			}, ...PRIORITIES.map((value) => (0, react.createElement)("option", {
				key: value,
				value
			}, PRIORITY_LABELS$1[value])))), field("自动重试上限（0 = 不自动重试）", (0, react.createElement)("input", {
				"aria-label": "edit max attempts",
				type: "number",
				min: 0,
				value: maxAttempts,
				onChange: (event) => setMaxAttempts(event.target.value)
			})), field("权限档位", (0, react.createElement)("select", {
				"aria-label": "edit sandbox",
				value: sandbox,
				onChange: (event) => setSandbox(event.target.value)
			}, (0, react.createElement)("option", {
				key: INHERIT$1,
				value: INHERIT$1
			}, "跟随全局默认"), ...props.sandboxPresets.map((name) => (0, react.createElement)("option", {
				key: name,
				value: name
			}, name)))), field("派给哪支小队", (0, react.createElement)("select", {
				"aria-label": "edit squad",
				value: squad,
				onChange: (event) => setSquad(event.target.value)
			}, (0, react.createElement)("option", {
				key: INHERIT$1,
				value: INHERIT$1
			}, "不用小队（派单个 Agent）"), ...props.squads.map((item) => (0, react.createElement)("option", {
				key: item.id,
				value: item.id
			}, item.title)))), field(squad === INHERIT$1 ? "agent preset（留空跟随默认）" : "agent preset（选了小队时不适用）", (0, react.createElement)("input", {
				"aria-label": "edit agent preset",
				value: squad === INHERIT$1 ? agentPreset : "",
				disabled: squad !== INHERIT$1,
				placeholder: squad === INHERIT$1 ? "跟随全局默认" : "由小队决定",
				onChange: (event) => setAgentPreset(event.target.value)
			})), field("超时秒数（留空 = 不限时）", (0, react.createElement)("input", {
				"aria-label": "edit timeout seconds",
				type: "number",
				min: 0,
				value: timeoutText,
				placeholder: "不限时",
				onChange: (event) => setTimeoutText(event.target.value)
			})), ...local === void 0 ? [] : [(0, react.createElement)("div", {
				key: "err",
				"data-vela-error": ""
			}, local)], (0, react.createElement)("div", { "data-vela-actions": "" }, (0, react.createElement)("button", {
				type: "submit",
				disabled: busy,
				"data-tone": "primary"
			}, "保存"), (0, react.createElement)("button", {
				type: "button",
				disabled: busy,
				onClick: onCancel
			}, "取消")));
		}
		//#endregion
		//#region src/client/components/IssueCard.tsx
		/**
		* 一张 Issue 卡片。它是全部按 Issue 的操作的落点：派活、取消、Gate 的接受与
		* 退回、重新派活、编辑、删除，以及 token 用量与失败原因的展示。
		*
		* 按钮集合按 Lane 变化——这不是装饰，而是状态机的直接投影：Running 期间不能
		* 编辑或删除（会让活 Run 成为孤儿），Review 才有 Gate，Done 不再派活入口之外
		* 的操作。
		*/
		const PRIORITY_LABELS = {
			none: "",
			low: "低",
			medium: "中",
			high: "高",
			urgent: "紧急"
		};
		/** 派活按钮在这些 Lane 上出现。Running 已有活 Run，Review 等的是人。 */
		const DISPATCHABLE = [
			"backlog",
			"todo",
			"failed",
			"done"
		];
		/** 用量的紧凑写法。数字大了用 k，看板上一眼能扫过去。 */
		function formatTokens(usage) {
			const total = totalTokens(usage);
			return total >= 1e3 ? `${(total / 1e3).toFixed(1)}k` : String(total);
		}
		/** 卡片组件。 */
		function IssueCard(props) {
			const { issue, client, onChanged, onError } = props;
			const [busy, setBusy] = (0, react.useState)(false);
			const [editing, setEditing] = (0, react.useState)(false);
			/** 跑一次写操作：期间禁用按钮，失败把原因抬到上层显示。 */
			const act = async (operation) => {
				if (busy) return;
				setBusy(true);
				onError(void 0);
				try {
					const result = await operation();
					if (!result.ok) onError(result.message ?? "操作失败");
					await onChanged();
				} finally {
					setBusy(false);
				}
			};
			const running = activeRun(issue);
			const lastRun = issue.runs[issue.runs.length - 1];
			const settledUsage = sumUsage(issue.runs.map((run) => run.usage));
			const priority = PRIORITY_LABELS[issue.priority] ?? "";
			if (editing) return (0, react.createElement)(EditIssueForm, {
				issue,
				sandboxPresets: props.sandboxPresets,
				squads: props.squads,
				client,
				onDone: () => {
					setEditing(false);
					onChanged();
				},
				onCancel: () => setEditing(false),
				onError
			});
			return (0, react.createElement)("article", {
				"data-vela-card": issue.id,
				"data-lane": issue.lane,
				"data-dragging": String(props.isDragging),
				"data-selected": String(props.isSelected),
				draggable: issue.lane !== "running",
				tabIndex: 0,
				onDragStart: () => props.onDragStart(),
				onDragEnd: () => props.onDragEnd(),
				onDrop: (event) => {
					event.preventDefault();
					event.stopPropagation();
					props.onDropBefore();
				},
				onDragOver: (event) => {
					event.preventDefault();
				},
				onKeyDown: (event) => {
					if (!event.altKey) return;
					const direction = {
						ArrowUp: "up",
						ArrowDown: "down",
						ArrowLeft: "left",
						ArrowRight: "right"
					}[event.key];
					if (direction === void 0) return;
					event.preventDefault();
					props.onNudge(direction);
				},
				"aria-label": `${formatIssueNumber(issue.number)} ${issue.title}（${issue.lane}）`
			}, (0, react.createElement)("div", { "data-vela-card-head": "" }, (0, react.createElement)("span", { "data-vela-number": "" }, formatIssueNumber(issue.number)), (0, react.createElement)("button", {
				type: "button",
				"data-vela-card-title": "",
				onClick: () => props.onOpenDetail(),
				"aria-label": `打开 ${formatIssueNumber(issue.number)} 的详情`
			}, issue.title), ...issue.lane === "running" ? [] : [(0, react.createElement)("button", {
				key: "del",
				type: "button",
				disabled: busy,
				"data-vela-icon-btn": "",
				"data-tone": "danger",
				"aria-label": `删除 ${formatIssueNumber(issue.number)} ${issue.title}`,
				title: "删除",
				onClick: () => void act(() => client.deleteIssue(issue.id))
			}, "✕")]), (0, react.createElement)("div", { "data-vela-card-meta": "" }, ...props.showWorkspace ? [(0, react.createElement)("code", { key: "ws" }, issue.workspace)] : [], ...priority === "" ? [] : [(0, react.createElement)("span", {
				key: "prio",
				"data-vela-chip": "",
				"data-tone": issue.priority
			}, priority)], ...issue.runs.length === 0 ? [] : [(0, react.createElement)("span", {
				key: "runs",
				"data-vela-chip": ""
			}, `${issue.runs.length} 次执行`)], ...issue.maxAttempts > 0 ? [(0, react.createElement)("span", {
				key: "retry",
				"data-vela-chip": ""
			}, `自动重试 ≤${issue.maxAttempts}`)] : [], ...issue.exec.sandbox === void 0 ? [] : [(0, react.createElement)("span", {
				key: "sb",
				"data-vela-chip": ""
			}, issue.exec.sandbox)], ...issue.exec.squad === void 0 ? [] : [(0, react.createElement)("span", {
				key: "squad",
				"data-vela-chip": "",
				"data-tone": "squad"
			}, `小队：${props.squads.find((item) => item.id === issue.exec.squad)?.title ?? issue.exec.squad}`)]), ...running !== void 0 && props.liveUsage !== void 0 ? [(0, react.createElement)("div", {
				key: "live",
				"data-vela-live": ""
			}, `${formatTokens(props.liveUsage)} tokens`)] : [], ...running !== void 0 && props.liveMembers !== void 0 && props.liveMembers.length > 0 ? [(0, react.createElement)("div", {
				key: "live-members",
				"data-vela-live-members": ""
			}, `⚡ ${props.liveMembers.join("、")} 在跑`)] : [], ...running === void 0 && settledUsage !== void 0 ? [(0, react.createElement)("div", {
				key: "usage",
				"data-vela-card-meta": ""
			}, (0, react.createElement)("span", null, `${formatTokens(settledUsage)} tokens`))] : [], ...running === void 0 && issue.runs.length > 0 && settledUsage === void 0 ? [(0, react.createElement)("div", {
				key: "unknown",
				"data-vela-hint": ""
			}, "token 用量未知")] : [], ...issue.lane === "failed" && lastRun?.failure !== void 0 ? [(0, react.createElement)("div", {
				key: "fail",
				"data-vela-failure": ""
			}, lastRun.failure)] : [], (0, react.createElement)("div", { "data-vela-actions": "" }, ...lastRun === void 0 ? [] : [(0, react.createElement)("button", {
				key: "open",
				type: "button",
				onClick: () => {
					if (!props.openSession(lastRun.sessionId)) onError("这次执行的会话已不在会话列表里");
				}
			}, issue.lane === "running" ? "看看在干什么" : "看会话")], ...props.canDispatch && DISPATCHABLE.includes(issue.lane) ? [(0, react.createElement)("button", {
				key: "run",
				type: "button",
				disabled: busy,
				"data-tone": "primary",
				onClick: () => void act(() => client.dispatch(issue.id))
			}, issue.runs.length === 0 ? "派活" : "重新派活")] : [], ...issue.lane === "running" ? [(0, react.createElement)("button", {
				key: "stop",
				type: "button",
				disabled: busy,
				"data-tone": "danger",
				onClick: () => void act(() => client.cancel(issue.id))
			}, "停止")] : [], ...issue.lane === "review" ? [(0, react.createElement)("button", {
				key: "accept",
				type: "button",
				disabled: busy,
				"data-tone": "primary",
				onClick: () => void act(() => client.gate(issue.id, "accept"))
			}, "接受"), (0, react.createElement)("button", {
				key: "reject",
				type: "button",
				disabled: busy,
				onClick: () => void act(() => client.gate(issue.id, "reject"))
			}, "退回")] : [], ...issue.lane === "running" ? [] : [(0, react.createElement)("button", {
				key: "edit",
				type: "button",
				disabled: busy,
				onClick: () => setEditing(true)
			}, "编辑")]));
		}
		//#endregion
		//#region src/client/components/NewIssueForm.tsx
		/**
		* 建卡表单（票 04），住在 Backlog 列顶部——新 Issue 只进 Backlog（ADR-0012）。
		*
		* 同时承担票 13 的「一批待办一次落盘」：粘贴多行文本，每行一张卡片。这解决的是
		* 「和 Agent 聊出一批待办后不用逐条重打」这个痛点。
		*/
		/** 「不用小队」选项的哨兵值。用不可打字符，避开与真存在的小队 id 撞车。 */
		const NO_SQUAD = "\0none";
		/** 建卡表单。 */
		function NewIssueForm(props) {
			const { client, onChanged, onError } = props;
			const [open, setOpen] = (0, react.useState)(false);
			const [batch, setBatch] = (0, react.useState)(false);
			const [title, setTitle] = (0, react.useState)("");
			const [workspace, setWorkspace] = (0, react.useState)(props.defaultWorkspace);
			const [squad, setSquad] = (0, react.useState)(NO_SQUAD);
			const [busy, setBusy] = (0, react.useState)(false);
			const [local, setLocal] = (0, react.useState)(void 0);
			const reset = () => {
				setTitle("");
				setLocal(void 0);
			};
			const submit = async () => {
				const path = workspace.trim();
				if (path.length === 0) {
					setLocal("Workspace 必填");
					return;
				}
				const titles = batch ? title.split("\n").map((line) => line.trim()).filter((line) => line.length > 0) : [title.trim()].filter((line) => line.length > 0);
				if (titles.length === 0) {
					setLocal(batch ? "至少要有一行标题" : "标题必填");
					return;
				}
				setBusy(true);
				onError(void 0);
				try {
					const result = batch || titles.length > 1 ? await client.createBatch(path, titles) : await client.createIssue({
						title: titles[0],
						workspace: path,
						...squad === NO_SQUAD ? {} : { exec: { squad } }
					});
					if (!result.ok) {
						setLocal(result.message);
						return;
					}
					reset();
					await onChanged();
				} finally {
					setBusy(false);
				}
			};
			if (!open) return (0, react.createElement)("button", {
				type: "button",
				onClick: () => {
					setOpen(true);
					setWorkspace(props.defaultWorkspace);
				},
				"aria-label": "new issue"
			}, "+ 新建");
			return (0, react.createElement)("form", {
				"data-vela-form": "",
				onSubmit: (event) => {
					event.preventDefault();
					submit();
				}
			}, (0, react.createElement)("div", { "data-vela-card-meta": "" }, (0, react.createElement)("label", { style: {
				display: "flex",
				gap: "4px",
				alignItems: "center"
			} }, (0, react.createElement)("input", {
				type: "checkbox",
				checked: batch,
				style: { width: "auto" },
				onChange: (event) => setBatch(event.target.checked)
			}), "一行一张")), batch ? (0, react.createElement)("textarea", {
				"aria-label": "issue titles",
				placeholder: "每行一个待办\n粘贴聊出来的清单即可",
				value: title,
				rows: 5,
				onChange: (event) => setTitle(event.target.value)
			}) : (0, react.createElement)("input", {
				"aria-label": "issue title",
				placeholder: "标题",
				value: title,
				onChange: (event) => setTitle(event.target.value)
			}), (0, react.createElement)("input", {
				"aria-label": "issue workspace",
				placeholder: "Workspace 绝对路径",
				value: workspace,
				onChange: (event) => setWorkspace(event.target.value)
			}), ...batch || props.squads.length === 0 ? [] : [(0, react.createElement)("label", {
				key: "squad",
				style: { display: "block" }
			}, (0, react.createElement)("span", { "data-vela-hint": "" }, "派给哪支小队"), (0, react.createElement)("select", {
				"aria-label": "new issue squad",
				value: squad,
				onChange: (event) => setSquad(event.target.value)
			}, (0, react.createElement)("option", {
				key: NO_SQUAD,
				value: NO_SQUAD
			}, "不用小队"), ...props.squads.map((item) => (0, react.createElement)("option", {
				key: item.id,
				value: item.id
			}, item.title))))], ...local === void 0 ? [] : [(0, react.createElement)("div", {
				key: "err",
				"data-vela-error": ""
			}, local)], (0, react.createElement)("div", { "data-vela-actions": "" }, (0, react.createElement)("button", {
				type: "submit",
				disabled: busy,
				"data-tone": "primary"
			}, "新建"), (0, react.createElement)("button", {
				type: "button",
				disabled: busy,
				onClick: () => {
					setOpen(false);
					reset();
				}
			}, "收起")));
		}
		//#endregion
		//#region src/client/components/BoardGrid.tsx
		/**
		* Board 的六列网格（票 03/04/06/12）。Lane 集合固定（ADR-0009），因此直接
		* 遍历 LANES 常量。
		*
		* 拖拽用**浏览器原生 drag-and-drop**，不引第三方库：本来就要为票 06 单独做
		* 键盘重排，原生方案让 client bundle 保持零新增依赖。合法落点在 dragover 阶段
		* 就按状态机判定，非法落点直接拒绝——不出现「先接受再回弹」。
		*/
		const LANE_LABELS$1 = {
			backlog: "Backlog",
			todo: "Todo",
			running: "Running",
			review: "待验收",
			done: "Done",
			failed: "Failed"
		};
		/**
		* 每列的状态符号，显示在列名前面。用 unicode 而不是图标库，保持零依赖。
		*
		* 形状跟着语义走：空心是「还没排上」，实心是「准备好了」，三角是「正在进行」，
		* 半圆是「等一个判断」，勾与叉是两种终局。形状与颜色**双重**编码——只靠颜色时，
		* 色弱的人分不清「进行中」和「待验收」。
		*/
		const LANE_ICONS = {
			backlog: "○",
			todo: "●",
			running: "▶",
			review: "◐",
			done: "✓",
			failed: "✕"
		};
		/** 六列网格。 */
		function BoardGrid(props) {
			const { issues, client, onChanged } = props;
			const [dragging, setDragging] = (0, react.useState)(void 0);
			const [error, setError] = (0, react.useState)(void 0);
			/** 把一张卡片放到某列的某个位置。 */
			const drop = async (lane, beforeId) => {
				const active = dragging;
				setDragging(void 0);
				if (active === void 0) return;
				if (!canOperatorMove(active.from, lane)) return;
				const result = await client.moveIssue(active.id, {
					lane,
					...beforeId === void 0 ? {} : { beforeId }
				});
				setError(result.ok ? void 0 : result.message);
				await onChanged();
			};
			/** 键盘重排/跨列移动（票 06 要求键盘可完成同样的操作）。 */
			const nudge = async (issue, direction) => {
				if (direction === "left" || direction === "right") {
					const index = LANES.indexOf(issue.lane);
					const target = LANES[direction === "left" ? index - 1 : index + 1];
					if (target === void 0 || !canOperatorMove(issue.lane, target)) return;
					const result = await client.moveIssue(issue.id, { lane: target });
					setError(result.ok ? void 0 : result.message);
					await onChanged();
					return;
				}
				const column = issues.filter((candidate) => candidate.lane === issue.lane).slice().sort(byPosition);
				const at = column.findIndex((candidate) => candidate.id === issue.id);
				const anchor = direction === "up" ? column[at - 1] : column[at + 2];
				if (direction === "up" && anchor === void 0) return;
				if (direction === "down" && at === column.length - 1) return;
				const result = await client.moveIssue(issue.id, {
					lane: issue.lane,
					...anchor === void 0 ? {} : { beforeId: anchor.id }
				});
				setError(result.ok ? void 0 : result.message);
				await onChanged();
			};
			return (0, react.createElement)("div", { "data-vela-grid": "" }, ...LANES.map((lane) => (0, react.createElement)(LaneColumn, {
				...props,
				key: lane,
				lane,
				issues: issues.filter((issue) => issue.lane === lane).slice().sort(byPosition),
				dragging,
				onDrop: drop,
				onDragEnd: () => setDragging(void 0),
				onDragStart: (id, from) => setDragging({
					id,
					from
				}),
				onNudge: nudge,
				onError: setError,
				error
			})));
		}
		function LaneColumn(props) {
			const { lane, issues, dragging, onDrop, onDragStart, onDragEnd, onNudge, onError, error } = props;
			const [over, setOver] = (0, react.useState)(false);
			const allowed = dragging !== void 0 && canOperatorMove(dragging.from, lane);
			const dropState = dragging === void 0 || !over ? void 0 : allowed ? "ok" : "no";
			return (0, react.createElement)("section", {
				"data-vela-lane": lane,
				...dropState === void 0 ? {} : { "data-drop": dropState },
				onDragOver: (event) => {
					setOver(true);
					if (!allowed) return;
					event.preventDefault();
					if (event.dataTransfer !== void 0) event.dataTransfer.dropEffect = "move";
				},
				onDragLeave: () => setOver(false),
				onDrop: (event) => {
					event.preventDefault();
					setOver(false);
					if (allowed) onDrop(lane, void 0);
				}
			}, (0, react.createElement)("h3", { "data-vela-lane-head": "" }, (0, react.createElement)("span", {
				"data-vela-lane-icon": "",
				"aria-hidden": "true"
			}, LANE_ICONS[lane]), LANE_LABELS$1[lane], (0, react.createElement)("span", { "data-vela-count": "" }, String(issues.length))), (0, react.createElement)("div", { "data-vela-lane-body": "" }, ...lane === "backlog" ? [(0, react.createElement)(NewIssueForm, {
				key: "__new",
				client: props.client,
				defaultWorkspace: props.defaultWorkspace,
				sandboxPresets: props.sandboxPresets,
				squads: props.squads,
				onChanged: props.onChanged,
				onError
			})] : [], ...lane !== "backlog" && issues.length === 0 ? [(0, react.createElement)("div", {
				key: "__empty",
				"data-vela-empty": ""
			}, "空")] : [], ...issues.map((issue, index) => (0, react.createElement)(IssueCard, {
				key: issue.id,
				issue,
				showWorkspace: props.showWorkspace,
				sandboxPresets: props.sandboxPresets,
				squads: props.squads,
				canDispatch: props.canDispatch,
				liveUsage: props.liveUsage[issue.id],
				liveMembers: props.liveMembers[issue.id],
				isSelected: props.selectedId === issue.id,
				onOpenDetail: () => props.onSelect(issue.id),
				openSession: props.openSession,
				client: props.client,
				onChanged: props.onChanged,
				onError,
				isDragging: dragging?.id === issue.id,
				onDragStart: () => onDragStart(issue.id, issue.lane),
				onDragEnd,
				onDropBefore: () => {
					if (dragging !== void 0) onDrop(lane, issue.id);
				},
				onNudge: (direction) => onNudge(issue, direction),
				canMoveUp: index > 0,
				canMoveDown: index < issues.length - 1
			})), ...lane === "backlog" && error !== void 0 ? [(0, react.createElement)("div", {
				key: "__err",
				"data-vela-error": ""
			}, error)] : []));
		}
		//#endregion
		//#region src/domain/timeline.ts
		/** 一条泳道最小占多宽（百分比）。 */
		const MIN_WIDTH = 1.5;
		/**
		* 把一批泳道摊到同一根时间轴上。
		*
		* @param spans - 泳道，顺序不重要。
		* @param now - 当前时刻，用于给还在跑的泳道画到「现在」。
		* @returns 与输入等长、一一对应的几何数组。
		*
		* 两个刻意的取舍：
		*
		* **还在跑的泳道画到 `now`**，于是时间轴会随轮询增长，跑完后定格。
		*
		* **宽度有下限。** 一个 30ms 就结束的队员在一根 5 分钟长的轴上是 0.1%，渲出来是
		* 一条看不见的线——而「它跑过而且很快」正是要传达的信息。
		*/
		function layoutSpans(spans, now) {
			if (spans.length === 0) return [];
			const start = Math.min(...spans.map((span) => span.observedStart));
			const end = Math.max(...spans.map((span) => span.observedEnd ?? now));
			const total = Math.max(end - start, 1);
			return spans.map((span) => {
				const spanEnd = span.observedEnd ?? now;
				const offset = (span.observedStart - start) / total * 100;
				const width = Math.max((spanEnd - span.observedStart) / total * 100, MIN_WIDTH);
				return {
					offset: Math.min(offset, 100 - width),
					width
				};
			});
		}
		//#endregion
		//#region src/client/components/SquadTimeline.tsx
		/**
		* 小队并行时间轴（票 10 / ADR-0019）。
		*
		* 只画一件 DSH 画不出来的事：**这次执行里各个队员谁在什么时候跑、谁和谁重叠**。
		* 某个队员具体做了哪些步骤一笔不画——点泳道跳去 DSH 看官方那份轨迹视图，比我们
		* 重做一份更好（`dsh-client-ui-trajectory` 是内部包，第三方插件 import 不到）。
		*
		* ## 时刻必须照实标注
		*
		* 横轴上的位置来自 **Vela 观察到的时刻**，不是队员真正起跑的时刻。差值是事件派发
		* 延迟，进程内可忽略，但这是近似值。组件底部有一句固定说明——不是免责声明，而是
		* 防止有人拿这张图去做性能归因。
		*/
		/** 停止原因的中文说法。表里没有的原样显示——上游可能加新值。 */
		const STOP_LABELS = {
			completed: "完成",
			error: "出错",
			cancelled: "被取消",
			aborted: "被中断",
			"infrastructure-error": "异常终止"
		};
		/** 一条泳道的状态类别，用于配色。 */
		function toneOf(span) {
			if (span.observedEnd === void 0) return "running";
			return span.stopReason === "completed" ? "ok" : "bad";
		}
		/** 耗时的紧凑写法。 */
		function compactDuration(ms) {
			if (ms < 1e3) return `${ms}ms`;
			const seconds = ms / 1e3;
			if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
			return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60).toString().padStart(2, "0")}s`;
		}
		/** 小队并行时间轴。 */
		function SquadTimeline(props) {
			const { spans, now, openSession } = props;
			if (spans.length === 0) return (0, react.createElement)("div", { "data-vela-timeline-empty": "" }, (0, react.createElement)("p", { "data-vela-muted": "" }, "这次执行里队长一个队员也没派出。"), (0, react.createElement)("p", { "data-vela-muted": "" }, "可能是它自己做完了，也可能是它没意识到手里有队员——后者通常意味着队长的职责说明该写得更明确。"));
			const geometry = layoutSpans(spans, now);
			const first = Math.min(...spans.map((span) => span.observedStart));
			const last = Math.max(...spans.map((span) => span.observedEnd ?? now));
			return (0, react.createElement)("div", { "data-vela-timeline": "" }, (0, react.createElement)("div", { "data-vela-timeline-scale": "" }, (0, react.createElement)("span", void 0, "0"), (0, react.createElement)("span", void 0, compactDuration(last - first))), ...spans.map((span, index) => {
				const geo = geometry[index];
				const tone = toneOf(span);
				const ended = span.observedEnd;
				const duration = (ended ?? now) - span.observedStart;
				return (0, react.createElement)("div", {
					key: span.runId,
					"data-vela-lane": "",
					"data-tone": tone
				}, (0, react.createElement)("button", {
					type: "button",
					"data-vela-lane-label": "",
					onClick: () => {
						openSession(span.sessionId);
					},
					"aria-label": `打开「${span.label}」的会话`,
					title: span.member === void 0 ? span.label : `${span.member}：${span.label}`
				}, ...span.member === void 0 ? [] : [(0, react.createElement)("span", {
					key: "who",
					"data-vela-lane-member": ""
				}, span.member)], (0, react.createElement)("span", { "data-vela-lane-task": "" }, span.label)), (0, react.createElement)("div", { "data-vela-lane-track": "" }, (0, react.createElement)("div", {
					"data-vela-lane-bar": "",
					style: {
						marginInlineStart: `${geo.offset}%`,
						inlineSize: `${geo.width}%`
					}
				})), (0, react.createElement)("span", { "data-vela-lane-status": "" }, ended === void 0 ? `在跑 ${compactDuration(duration)}` : `${STOP_LABELS[span.stopReason ?? ""] ?? span.stopReason ?? "结果未知"} ${compactDuration(duration)}`), ...span.summary === void 0 ? [] : [(0, react.createElement)("div", {
					key: "summary",
					"data-vela-lane-summary": ""
				}, span.summary)]);
			}), (0, react.createElement)("p", { "data-vela-timeline-note": "" }, "横轴用的是 Vela 观察到的时刻，不是队员真正起跑的时刻——这是近似值，不适合拿来做性能归因。"));
		}
		//#endregion
		//#region src/client/components/IssueDrawer.tsx
		/**
		* Issue 详情抽屉（票 04）：点一张卡从右侧滑出，Board 仍留在视野里。
		*
		* 为什么是抽屉而不是整页：Board 是这个插件的主体，看细节时把它整块换掉会丢掉
		* 「这张卡在哪一列、旁边还有什么」这个上下文——而那正是 Operator 打开看板的
		* 理由。抽屉占右侧四成，左边六成的 Board 照常可读可点。
		*
		* 这里也是小队时间轴（票 10）的容器。
		*
		* ## 焦点与键盘
		*
		* 卡片自己带方向键操作（挪动它在看板上的位置）。抽屉一打开就把焦点移进来，
		* 于是那些键落在抽屉里而不是卡片上——「抽屉开着时 Board 的键盘操作不被误触发」
		* 靠的是焦点位置，不是逐个 stopPropagation。关闭时焦点还给原来那张卡，否则
		* 焦点会掉回 body，键盘用户就此失去位置。
		*
		* Escape 由 BoardPanel 统一处理：它知道抽屉开没开，因此能决定这一下是关抽屉
		* 还是关整个面板。两处各挂一个 listener 会变成一个顺序问题。
		*/
		/** Lane 的中文名。与 BoardGrid 的列头保持一致的说法。 */
		const LANE_LABELS = {
			backlog: "待办",
			todo: "准备好",
			running: "进行中",
			review: "待验收",
			done: "完成",
			failed: "失败"
		};
		/** Run 结局的中文名。 */
		const OUTCOME_LABELS = {
			completed: "正常结束",
			error: "出错",
			aborted: "被中断",
			timeout: "超时"
		};
		/** 把毫秒时长写成人能一眼读的形式。 */
		function formatDuration(ms) {
			if (ms < 1e3) return `${ms}ms`;
			const seconds = Math.round(ms / 100) / 10;
			if (seconds < 60) return `${seconds}s`;
			return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60).toString().padStart(2, "0")}s`;
		}
		/** 时刻写成本地时间。日期只在不是今天时才带上——多数 Run 是刚跑的。 */
		function formatMoment(at) {
			const date = new Date(at);
			const time = date.toLocaleTimeString(void 0, { hour12: false });
			const today = /* @__PURE__ */ new Date();
			return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate() ? time : `${date.toLocaleDateString()} ${time}`;
		}
		/** 一行「标签：值」。值为空时整行不渲染，免得抽屉里挂着一排空标签。 */
		function field(label, value) {
			if (value === void 0 || value.trim().length === 0) return void 0;
			return (0, react.createElement)("div", {
				key: label,
				"data-vela-field": ""
			}, (0, react.createElement)("span", { "data-vela-field-label": "" }, label), (0, react.createElement)("span", { "data-vela-field-value": "" }, value));
		}
		/** Issue 详情抽屉。 */
		function IssueDrawer(props) {
			const { issue, client, onChanged, onClose } = props;
			const [title, setTitle] = (0, react.useState)(issue.title);
			const [description, setDescription] = (0, react.useState)(issue.description);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const rootRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				setTitle(issue.title);
				setDescription(issue.description);
				setError(void 0);
			}, [
				issue.id,
				issue.title,
				issue.description
			]);
			(0, react.useEffect)(() => {
				rootRef.current?.focus();
			}, []);
			const dirty = title !== issue.title || description !== issue.description;
			const save = async () => {
				if (!dirty) return;
				setBusy(true);
				const result = await client.updateIssue(issue.id, {
					title,
					description
				});
				setBusy(false);
				if (!result.ok) {
					setError(result.message);
					return;
				}
				setError(void 0);
				await onChanged();
			};
			const runs = [...issue.runs].reverse();
			return (0, react.createElement)("aside", {
				ref: rootRef,
				tabIndex: -1,
				role: "complementary",
				"aria-label": `${formatIssueNumber(issue.number)} 详情`,
				"data-vela-drawer": ""
			}, (0, react.createElement)("header", { "data-vela-drawer-head": "" }, (0, react.createElement)("span", { "data-vela-number": "" }, formatIssueNumber(issue.number)), (0, react.createElement)("span", { "data-vela-drawer-lane": "" }, LANE_LABELS[issue.lane]), (0, react.createElement)("span", { "data-vela-spacer": "" }), (0, react.createElement)("button", {
				type: "button",
				onClick: onClose,
				"aria-label": "关闭详情"
			}, "关闭")), (0, react.createElement)("div", { "data-vela-drawer-body": "" }, (0, react.createElement)("label", { "data-vela-drawer-label": "" }, "标题", (0, react.createElement)("input", {
				value: title,
				disabled: busy,
				"aria-label": "标题",
				onChange: (event) => setTitle(event.target.value)
			})), (0, react.createElement)("label", { "data-vela-drawer-label": "" }, "描述", (0, react.createElement)("textarea", {
				value: description,
				rows: 6,
				disabled: busy,
				"aria-label": "描述",
				onChange: (event) => setDescription(event.target.value)
			})), (0, react.createElement)("div", { "data-vela-drawer-actions": "" }, (0, react.createElement)("button", {
				type: "button",
				disabled: busy || !dirty,
				"data-tone": "primary",
				onClick: () => {
					save();
				}
			}, dirty ? "保存" : "已保存"), ...dirty ? [(0, react.createElement)("button", {
				key: "revert",
				type: "button",
				disabled: busy,
				onClick: () => {
					setTitle(issue.title);
					setDescription(issue.description);
				}
			}, "撤销改动")] : []), ...error === void 0 ? [] : [(0, react.createElement)("p", {
				key: "error",
				"data-vela-error": ""
			}, error)], (0, react.createElement)("h3", { "data-vela-drawer-section": "" }, "执行配置"), (0, react.createElement)("div", { "data-vela-fields": "" }, ...[
				field("Workspace", issue.workspace),
				field("优先级", issue.priority),
				field("小队", issue.exec.squad),
				field("Agent preset", issue.exec.agentPreset),
				field("权限档位", issue.exec.sandbox),
				field("超时", issue.exec.timeoutMs === void 0 ? void 0 : formatDuration(issue.exec.timeoutMs))
			].filter((node) => node !== void 0), ...issue.exec.squad === void 0 && issue.exec.agentPreset === void 0 && issue.exec.sandbox === void 0 && issue.exec.timeoutMs === void 0 ? [(0, react.createElement)("p", {
				key: "defaults",
				"data-vela-muted": ""
			}, "这张卡没有单独配置，全部用全局默认。")] : []), (0, react.createElement)("h3", { "data-vela-drawer-section": "" }, `历次执行（${issue.runs.length}）`), ...runs.length === 0 ? [(0, react.createElement)("p", {
				key: "no-runs",
				"data-vela-muted": ""
			}, "还没有派过活。把卡片拖到「准备好」再点派活，这里会记下每一次执行。")] : runs.map((run, index) => runRow(run, issue.runs.length - index, props))));
		}
		/**
		* 一次执行的记录。
		*
		* @param ordinal - 第几次执行（从 1 起，按发生顺序）。展示成「第 N 次」比一个
		*   随机 id 有用得多——Operator 说的是「第二次跑挂了」。
		*/
		function runRow(run, ordinal, props) {
			const running = run.status === "running";
			const usage = running ? props.liveUsage : run.usage;
			const tokens = usage === void 0 ? void 0 : totalTokens(usage);
			const ended = run.endedAt;
			const spans = props.timelines?.[run.sessionId];
			return (0, react.createElement)("div", {
				key: run.id,
				"data-vela-run": "",
				"data-outcome": run.outcome ?? (running ? "running" : "unknown")
			}, (0, react.createElement)("div", { "data-vela-run-head": "" }, (0, react.createElement)("span", { "data-vela-run-ordinal": "" }, `第 ${ordinal} 次`), (0, react.createElement)("span", { "data-vela-run-outcome": "" }, running ? "正在跑" : OUTCOME_LABELS[run.outcome ?? ""] ?? "结果未知"), (0, react.createElement)("span", { "data-vela-spacer": "" }), (0, react.createElement)("button", {
				type: "button",
				onClick: () => {
					if (!props.openSession(run.sessionId)) props.onChanged();
				},
				"aria-label": `打开第 ${ordinal} 次执行的会话`
			}, "看会话")), (0, react.createElement)("div", { "data-vela-fields": "" }, ...[
				field("开始", formatMoment(run.startedAt)),
				field("结束", ended === void 0 ? void 0 : formatMoment(ended)),
				field("耗时", ended === void 0 ? void 0 : formatDuration(ended - run.startedAt)),
				field("Token", tokens === void 0 ? void 0 : tokens.toLocaleString())
			].filter((node) => node !== void 0)), ...run.failure === void 0 ? [] : [(0, react.createElement)("p", {
				key: "failure",
				"data-vela-run-failure": ""
			}, run.failure)], ...spans === void 0 ? [] : [(0, react.createElement)(SquadTimeline, {
				key: "timeline",
				spans,
				now: props.now ?? Date.now(),
				openSession: props.openSession
			})]);
		}
		//#endregion
		//#region src/domain/nav.ts
		/** 分组标题，按 Multica 的分法。 */
		const NAV_GROUP_LABELS = {
			personal: "个人",
			workspace: "工作区",
			configure: "配置"
		};
		/** 分组的展示顺序。 */
		const NAV_GROUPS = [
			"personal",
			"workspace",
			"configure"
		];
		/**
		* 十二项导航，顺序与分组与 Multica 一致。
		*
		* `inbox` 是唯一一处**换掉语义**而不是接过来的：DSH 没有收件箱，而 Multica 的
		* Inbox 语义（别人给你发消息）在单 Operator 的世界里不存在（ADR-0001）。空着
		* 一格不如换成这个位置真正该有的东西——需要你动手的卡有多少张。
		*/
		const NAV_ITEMS = [
			{
				key: "inbox",
				group: "personal",
				label: "待你处理",
				action: {
					kind: "view",
					view: "attention"
				},
				badge: "attention"
			},
			{
				key: "chat",
				group: "personal",
				label: "聊天",
				action: { kind: "close-panel" }
			},
			{
				key: "myIssues",
				group: "personal",
				label: "我的任务",
				action: {
					kind: "view",
					view: "board"
				}
			},
			{
				key: "issues",
				group: "workspace",
				label: "任务",
				action: {
					kind: "view",
					view: "board"
				}
			},
			{
				key: "projects",
				group: "workspace",
				label: "项目",
				action: {
					kind: "disabled",
					reason: "not-yet",
					note: "下一期：比 Workspace 更粗的一层归组"
				}
			},
			{
				key: "autopilots",
				group: "workspace",
				label: "自动化",
				action: {
					kind: "disabled",
					reason: "not-yet",
					note: "下一期：按规则自动派活"
				}
			},
			{
				key: "agents",
				group: "workspace",
				label: "Agent 配置",
				action: {
					kind: "open-document",
					target: "agent-presets"
				}
			},
			{
				key: "squads",
				group: "workspace",
				label: "小队",
				action: {
					kind: "view",
					view: "squads"
				}
			},
			{
				key: "memory",
				group: "workspace",
				label: "记忆",
				action: {
					kind: "view",
					view: "memory"
				}
			},
			{
				key: "usage",
				group: "workspace",
				label: "用量",
				action: {
					kind: "disabled",
					reason: "not-yet",
					note: "下一期：跨卡与跨小队的用量汇总"
				}
			},
			{
				key: "runtimes",
				group: "configure",
				label: "运行时",
				action: {
					kind: "open-document",
					target: "settings"
				}
			},
			{
				key: "skills",
				group: "configure",
				label: "技能",
				action: {
					kind: "view",
					view: "skills"
				}
			},
			{
				key: "settings",
				group: "configure",
				label: "设置",
				action: {
					kind: "open-document",
					target: "settings"
				}
			}
		];
		/** 某个分组下的导航项，按声明顺序。 */
		function itemsInGroup(group) {
			return NAV_ITEMS.filter((item) => item.group === group);
		}
		//#endregion
		//#region src/client/components/PanelSidebar.tsx
		/**
		* 面板内的左侧导航（票 03 / ADR-0020）。按 Multica 的三组十二项摆开。
		*
		* 归属表本身在 `domain/nav.ts` 里，是一份纯数据——这里只负责把它画出来并把
		* 点击派给对应的动作。**没有任何一项是「跳到 DSH 的某个页面」**：DSH 不给
		* 第三方插件页面导航（见 ADR-0020 的取证一节）。
		*/
		/** 每项前面的小记号。刻意用字符而不是图标字体，免得多一份资源依赖。 */
		const GLYPHS = {
			inbox: "◍",
			chat: "💬",
			myIssues: "◑",
			issues: "▦",
			projects: "❏",
			autopilots: "⟳",
			agents: "⌬",
			squads: "⚑",
			usage: "◴",
			runtimes: "⚙",
			skills: "✦",
			settings: "⚙"
		};
		function renderItem(item, props) {
			const { action } = item;
			const isDisabled = action.kind === "disabled";
			const active = action.kind === "view" && action.view === props.current;
			const badge = item.badge === "attention" && props.attention > 0 ? props.attention : void 0;
			const onClick = () => {
				switch (action.kind) {
					case "view":
						props.onSelect(action.view);
						return;
					case "close-panel":
						props.onClosePanel();
						return;
					case "open-document":
						props.onOpenDocument(action.target);
						return;
					case "disabled": return;
				}
			};
			return (0, react.createElement)("button", {
				key: item.key,
				type: "button",
				disabled: isDisabled,
				onClick,
				"data-vela-nav-item": item.key,
				"data-active": String(active),
				...isDisabled ? { "data-disabled-reason": action.reason } : {},
				title: isDisabled ? action.note : item.label,
				"aria-current": active ? "page" : void 0
			}, (0, react.createElement)("span", {
				"data-vela-nav-glyph": "",
				"aria-hidden": "true"
			}, GLYPHS[item.key] ?? "·"), (0, react.createElement)("span", { "data-vela-nav-label": "" }, item.label), ...badge === void 0 ? [] : [(0, react.createElement)("span", {
				key: "badge",
				"data-vela-nav-badge": ""
			}, String(badge))]);
		}
		/** 面板内的左侧导航。 */
		function PanelSidebar(props) {
			return (0, react.createElement)("nav", {
				"data-vela-sidebar": "",
				"aria-label": "Vela 导航"
			}, ...NAV_GROUPS.map((group) => (0, react.createElement)("div", {
				key: group,
				"data-vela-nav-group": group
			}, (0, react.createElement)("div", { "data-vela-nav-group-title": "" }, NAV_GROUP_LABELS[group]), ...itemsInGroup(group).map((item) => renderItem(item, props)))));
		}
		NAV_ITEMS.length;
		//#endregion
		//#region src/domain/squad.ts
		/** 全部能力组，按展示顺序。 */
		const ABILITIES = [
			"read",
			"edit",
			"shell",
			"web",
			"delegate"
		];
		/** 能力组的中文标签。 */
		const ABILITY_LABELS = {
			read: "读文件",
			edit: "改文件",
			shell: "跑命令",
			web: "联网",
			delegate: "再派下一级"
		};
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
		[
			"# ── Vela 小队队员（以下由 Vela 生成）──────────────────────────",
			"#",
			"# 上面的全部内容是基准 preset 的原文副本，每个队员在下面各占一行。",
			"# 手改这份文件会在下一次保存小队时被整份覆盖。"
		].join("\n");
		//#endregion
		//#region src/client/components/MemberEditor.tsx
		/**
		* 单个队员的编辑卡片。
		*
		* 从 SquadPage 抽出来：它在「创建」与「详情」两处都要用，各自塞一份会分叉。
		* 紧凑的四行布局——名字行 / 职责 / 能力 chip / 白名单小字，不再每个字段独占一行。
		*/
		/**
		* 队员字母徽的色相：按名字哈希到六色之一。
		*
		* 同一个名字永远同一个色——视觉上「这个人」就有了稳定的色彩身份，
		* 列表和时间轴里扫一眼就能认出来。
		*/
		function memberHue(name) {
			let hash = 0;
			for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 997;
			return hash % 6;
		}
		/** 字母徽上显示的字符：英文取首字母大写，中文取第一个字。 */
		function avatarChar(name) {
			const first = [...name][0] ?? "?";
			return /^[a-z]$/.test(first) ? first.toUpperCase() : first;
		}
		/** 单个队员的编辑卡片。 */
		function MemberEditor(props) {
			const { member, onPatch, onRemove, platform } = props;
			return (0, react.createElement)("div", { "data-vela-member": member.name }, (0, react.createElement)("div", { "data-vela-member-head": "" }, (0, react.createElement)("span", {
				"data-vela-avatar": "",
				"data-hue": String(memberHue(member.name)),
				"aria-hidden": "true"
			}, avatarChar(member.name)), (0, react.createElement)("input", {
				"data-vela-member-name": "",
				value: member.name,
				"aria-label": "队员名字",
				title: "名字（队长眼里这个队员就叫这个）",
				onChange: (event) => onPatch({ name: event.target.value })
			}), (0, react.createElement)("select", {
				"data-vela-member-backend": "",
				value: member.backend,
				"aria-label": "执行后端",
				title: "spawn 独立上下文最常用；fork 带上队长已完成的对话。Codex / Claude Code 下一期才支持。",
				onChange: (event) => onPatch({ backend: event.target.value })
			}, (0, react.createElement)("option", { value: "spawn" }, "spawn"), (0, react.createElement)("option", { value: "fork" }, "fork"), (0, react.createElement)("option", {
				value: "codex",
				disabled: true
			}, "Codex（下一期）"), (0, react.createElement)("option", {
				value: "claude-code",
				disabled: true
			}, "Claude Code（下一期）")), (0, react.createElement)("button", {
				type: "button",
				"data-vela-icon-btn": "",
				"data-tone": "danger",
				"aria-label": `移除队员 ${member.name}`,
				title: "移除这个队员",
				onClick: onRemove
			}, "✕")), (0, react.createElement)("textarea", {
				"data-vela-member-instruction": "",
				value: member.instruction,
				rows: 2,
				placeholder: "这个队员负责什么。例如：只改前端，不碰后端接口。",
				"aria-label": "职责说明",
				onChange: (event) => onPatch({ instruction: event.target.value })
			}), props.modelCatalog.length > 0 ? (0, react.createElement)("select", {
				"data-vela-member-model": "",
				value: member.model ?? "",
				"aria-label": `队员 ${member.name} 的模型`,
				title: "这个队员用什么模型。「沿用队长」= 跟队长同一个路由。",
				onChange: (event) => onPatch({ model: event.target.value })
			}, (0, react.createElement)("option", { value: "" }, "沿用队长（默认）"), ...member.model !== void 0 && member.model !== "" && !props.modelCatalog.some((o) => o.value === member.model) ? [(0, react.createElement)("option", {
				key: "__stale",
				value: member.model
			}, `${member.model}（已不在清单里）`)] : [], ...props.modelCatalog.map((option) => (0, react.createElement)("option", {
				key: option.value,
				value: option.value
			}, option.label))) : (0, react.createElement)("input", {
				"data-vela-member-model": "",
				value: member.model ?? "",
				placeholder: "模型（留空沿用队长）；也可写 provider/model",
				"aria-label": `队员 ${member.name} 的模型`,
				title: "这个队员用什么模型。留空 = 沿用队长的路由。参考 dsh-agent-teams 的按队员配模型。",
				onChange: (event) => {
					const value = event.target.value;
					onPatch({ model: value.trim().length === 0 ? "" : value });
				}
			}), (0, react.createElement)("div", { "data-vela-abilities": "" }, ...ABILITIES.map((ability) => {
				const on = member.abilities.includes(ability);
				return (0, react.createElement)("label", {
					key: ability,
					"data-vela-ability": ability,
					"data-on": String(on)
				}, (0, react.createElement)("input", {
					type: "checkbox",
					checked: on,
					"aria-label": ABILITY_LABELS[ability],
					onChange: () => {
						const next = on ? member.abilities.filter((item) => item !== ability) : [...member.abilities, ability];
						onPatch({ abilities: next });
					}
				}), (0, react.createElement)("span", null, ABILITY_LABELS[ability]));
			})), (0, react.createElement)("div", { "data-vela-member-tools": "" }, `白名单：${memberTools(member, platform).join("、") || "（空——至少勾一项，否则这个队员没有任何工具）"}`));
		}
		//#endregion
		//#region src/client/components/SkillsPage.tsx
		/**
		* 技能广场页：这个部署装了的全部技能，只读展示。
		*
		* 布局向看板看齐：三个来源（DSH 目录 / 共享目录 / 出厂自带）各占一列，
		* 列独立滚动。一个技能是一张**紧凑卡**——字母徽、名字、一行描述；详情
		* （完整描述、何时用、文件位置、生效状态）收进点开的弹窗里，与「创建
		* 小队」同一个弹窗形态。
		*
		* 纯展示组件——数据与拉取时机都由 BoardPanel 持有，这里只管把清单画出来。
		*/
		/** 每个来源目录的一句说明（路径给人看，方便去目录里加技能）。 */
		const SOURCE_HINTS = {
			dsh: "~/.dsh/skills",
			agents: "~/.agents/skills",
			bundled: "随 DSH 出厂自带"
		};
		/** 徽章：仅手动调用 / 被同名盖住。卡片与弹窗共用。 */
		function skillChips(skill) {
			return [...skill.userOnly ? [(0, react.createElement)("span", {
				key: "uo",
				"data-vela-chip": "",
				title: "模型看不到它，只能在输入框里手动 / 调用"
			}, "仅手动调用")] : [], ...!skill.effective ? [(0, react.createElement)("span", {
				key: "sh",
				"data-vela-chip": "",
				"data-tone": "medium"
			}, "被同名盖住")] : []];
		}
		/** 技能详情弹窗：点开一张技能卡后的完整信息。 */
		function SkillDetailDialog(props) {
			const { skill, onClose } = props;
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					event.stopPropagation();
					onClose();
				};
				window.addEventListener("keydown", onKey, true);
				return () => window.removeEventListener("keydown", onKey, true);
			}, []);
			return (0, react.createElement)("div", {
				"data-vela-modal-backdrop": "",
				onClick: onClose
			}, (0, react.createElement)("div", {
				"data-vela-modal": "",
				role: "dialog",
				"aria-modal": "true",
				"aria-label": `技能 ${skill.name}`,
				onClick: (event) => event.stopPropagation()
			}, (0, react.createElement)("header", { "data-vela-modal-head": "" }, (0, react.createElement)("span", { "data-vela-skill-dialog-title": "" }, (0, react.createElement)("code", null, `/${skill.name}`), ...skillChips(skill)), (0, react.createElement)("button", {
				type: "button",
				"data-vela-icon-btn": "",
				"aria-label": "关闭",
				onClick: onClose
			}, "✕")), (0, react.createElement)("div", { "data-vela-modal-body": "" }, ...skill.problem !== void 0 ? [(0, react.createElement)("div", {
				key: "prob",
				"data-vela-skill-problem": ""
			}, `⚠ ${skill.problem}`)] : [], (0, react.createElement)("div", { "data-vela-skill-field": "" }, (0, react.createElement)("div", { "data-vela-skill-field-label": "" }, "做什么的"), (0, react.createElement)("div", null, skill.description.length > 0 ? skill.description : "（没有描述）")), ...skill.whenToUse === void 0 ? [] : [(0, react.createElement)("div", {
				key: "when",
				"data-vela-skill-field": ""
			}, (0, react.createElement)("div", { "data-vela-skill-field-label": "" }, "何时用"), (0, react.createElement)("div", null, skill.whenToUse))], (0, react.createElement)("div", { "data-vela-skill-field": "" }, (0, react.createElement)("div", { "data-vela-skill-field-label": "" }, "来源"), (0, react.createElement)("div", null, `${SKILL_SOURCE_LABELS[skill.source]}（${SOURCE_HINTS[skill.source]}）`)), (0, react.createElement)("div", { "data-vela-skill-field": "" }, (0, react.createElement)("div", { "data-vela-skill-field-label": "" }, "文件位置"), (0, react.createElement)("div", { "data-vela-skill-path": "" }, skill.sourcePath)), (0, react.createElement)("div", { "data-vela-skill-field": "" }, (0, react.createElement)("div", { "data-vela-skill-field-label": "" }, "状态"), (0, react.createElement)("div", null, skill.effective ? "生效中：对话里输入 /" + skill.name + " 就能用。" : `被同名盖住：实际生效的是${props.overriddenBy === void 0 ? "优先级更高的目录里的那份" : `${SKILL_SOURCE_LABELS[props.overriddenBy.source]}里的那份（${props.overriddenBy.sourcePath}）`}。`)))));
		}
		/** 一个技能的紧凑卡：字母徽 + 名字 + 一行描述，点开看详情。 */
		function skillCard(skill, onOpen) {
			return (0, react.createElement)("div", {
				key: `${skill.source}:${skill.sourcePath}`,
				"data-vela-skill-row": "",
				"data-dim": String(!skill.effective),
				role: "button",
				tabIndex: 0,
				"aria-label": `技能 ${skill.name}，点开看详情`,
				onClick: () => onOpen(skill),
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") onOpen(skill);
				}
			}, (0, react.createElement)("span", {
				"data-vela-avatar": "",
				"data-hue": String(memberHue(skill.name)),
				"aria-hidden": "true"
			}, avatarChar(skill.name)), (0, react.createElement)("div", { "data-vela-skill-main": "" }, (0, react.createElement)("div", { "data-vela-skill-title": "" }, (0, react.createElement)("code", null, `/${skill.name}`), ...skillChips(skill)), skill.problem !== void 0 ? (0, react.createElement)("div", { "data-vela-skill-problem": "" }, `⚠ ${skill.problem}`) : (0, react.createElement)("div", { "data-vela-skill-desc": "" }, skill.description.length > 0 ? skill.description : "（没有描述）")));
		}
		/** 一个来源一列。 */
		function skillColumn(source, skills, onOpen) {
			return (0, react.createElement)("section", {
				key: source,
				"data-vela-skill-col": source
			}, (0, react.createElement)("header", { "data-vela-skill-col-head": "" }, (0, react.createElement)("h3", null, `${SKILL_SOURCE_LABELS[source]}（${skills.length}）`), (0, react.createElement)("div", { "data-vela-skill-hint": "" }, SOURCE_HINTS[source])), (0, react.createElement)("div", { "data-vela-skill-col-body": "" }, ...skills.length === 0 ? [(0, react.createElement)("div", {
				key: "empty",
				"data-vela-empty": ""
			}, "这个目录还没有技能")] : skills.map((skill) => skillCard(skill, onOpen))));
		}
		/** 技能广场页。 */
		function SkillsPage(props) {
			const { view, failed, loading, onRefresh } = props;
			/** 当前打开详情的那个技能。 */
			const [selected, setSelected] = (0, react.useState)(void 0);
			const head = (0, react.createElement)("div", { "data-vela-skill-head": "" }, (0, react.createElement)("h2", null, "技能"), ...view === void 0 ? [] : [(0, react.createElement)("span", {
				key: "n",
				"data-vela-chip": ""
			}, `${view.skills.length} 个`)], (0, react.createElement)("button", {
				type: "button",
				disabled: loading,
				onClick: onRefresh,
				"aria-label": "刷新技能列表"
			}, loading ? "在扫…" : "刷新"));
			if (failed && view === void 0) return (0, react.createElement)("div", { "data-vela-skills": "" }, head, (0, react.createElement)("div", { "data-vela-error": "" }, "技能列表拉取失败。点「刷新」重试。"));
			if (view === void 0) return (0, react.createElement)("div", { "data-vela-skills": "" }, head, (0, react.createElement)("div", { "data-vela-empty": "" }, "正在扫技能目录…"));
			if (!view.available) return (0, react.createElement)("div", { "data-vela-skills": "" }, head, (0, react.createElement)("div", { "data-vela-empty": "" }, "这个部署没有开技能页。"));
			if (view.skills.length === 0) return (0, react.createElement)("div", { "data-vela-skills": "" }, head, (0, react.createElement)("div", { "data-vela-empty": "" }, "还没有装技能。技能是一个含 SKILL.md 的目录，放进 ~/.dsh/skills 或 ~/.agents/skills 就算装好，回到这里点「刷新」即见。"));
			const winnerOf = selected === void 0 ? void 0 : view.skills.find((skill) => skill.name === selected.name && skill.effective);
			return (0, react.createElement)("div", { "data-vela-skills": "" }, head, (0, react.createElement)("div", { "data-vela-skill-cols": "" }, ...SKILL_SOURCES.map((source) => skillColumn(source, view.skills.filter((skill) => skill.source === source), setSelected))), (0, react.createElement)("div", { "data-vela-skill-footer": "" }, "列的是全局目录。工作区里 .dsh/skills 的项目级技能不在这里——它们只在那个工作区里生效，优先级也更高。"), ...selected === void 0 ? [] : [(0, react.createElement)(SkillDetailDialog, {
				key: "detail",
				skill: selected,
				...winnerOf === void 0 || winnerOf === selected ? {} : { overriddenBy: winnerOf },
				onClose: () => setSelected(void 0)
			})]);
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
		//#endregion
		//#region src/client/components/MemoryPage.tsx
		/**
		* 记忆页：这个部署攒下的全部复盘，按工作区分组的只读浏览 + 删除。
		*
		* 形态向技能广场看齐：一个工作区一列，一篇复盘是一张**紧凑卡**——信任标记、
		* 标题、落盘日期；完整正文收进点开的弹窗里。
		*
		* 三种状态必须分清（这一页最容易做错的地方）：
		* - **没开启**：没配 `memoryPath`，这个功能根本没跑（ADR-0022）
		* - **拉取失败**：接口挂了，该重试
		* - **一篇都没有**：开着、能读，只是还没攒下东西
		*
		* 混成一个空列表会让 Operator 以为「记忆功能不好使」，而实情可能是他没开。
		*
		* 纯展示组件——数据与拉取时机都由 BoardPanel 持有。
		*/
		/** 一篇的徽章：信任等级、废弃、陈旧、被召回过几次。 */
		function recapChips(entry) {
			return [
				(0, react.createElement)("span", {
					key: "trust",
					"data-vela-chip": "",
					"data-tone": entry.trust === "human-reviewed" ? "good" : "medium",
					title: entry.trust === "human-reviewed" ? "验收时经人审过，可以被召回" : "还没人审过，不会被召回"
				}, trustMark(entry.trust)),
				...entry.status === "deprecated" ? [(0, react.createElement)("span", {
					key: "dep",
					"data-vela-chip": "",
					"data-tone": "medium",
					title: "被更晚的执行取代，或验收时判定不值得留"
				}, "已废弃")] : [],
				...entry.stale ? [(0, react.createElement)("span", {
					key: "stale",
					"data-vela-chip": "",
					"data-tone": "warn",
					title: "过了保鲜期，不再参与召回"
				}, "已陈旧")] : [],
				...entry.usageCount > 0 ? [(0, react.createElement)("span", {
					key: "use",
					"data-vela-chip": "",
					title: "被召回展开过几次"
				}, `用过 ${entry.usageCount} 次`)] : []
			];
		}
		/** 详情弹窗：整篇正文，加一个删除入口。 */
		function RecapDialog(props) {
			const { entry, onClose, onRemove } = props;
			const [confirming, setConfirming] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					event.stopPropagation();
					onClose();
				};
				window.addEventListener("keydown", onKey, true);
				return () => window.removeEventListener("keydown", onKey, true);
			}, []);
			return (0, react.createElement)("div", {
				"data-vela-modal-backdrop": "",
				onClick: onClose
			}, (0, react.createElement)("div", {
				"data-vela-modal": "",
				role: "dialog",
				"aria-modal": "true",
				"aria-label": `复盘 ${entry.title}`,
				onClick: (event) => event.stopPropagation()
			}, (0, react.createElement)("header", { "data-vela-modal-head": "" }, (0, react.createElement)("span", { "data-vela-recap-dialog-title": "" }, entry.title, ...recapChips(entry)), (0, react.createElement)("button", {
				type: "button",
				"data-vela-icon-btn": "",
				"aria-label": "关闭",
				onClick: onClose
			}, "✕")), (0, react.createElement)("div", { "data-vela-modal-body": "" }, ...entry.problem === void 0 ? [] : [(0, react.createElement)("div", {
				key: "prob",
				"data-vela-recap-problem": ""
			}, `⚠ 这篇读不了：${entry.problem}`)], (0, react.createElement)("div", { "data-vela-recap-field": "" }, (0, react.createElement)("div", { "data-vela-recap-field-label": "" }, "文件"), (0, react.createElement)("div", { "data-vela-recap-path": "" }, entry.path)), ...entry.workspace === void 0 ? [] : [(0, react.createElement)("div", {
				key: "ws",
				"data-vela-recap-field": ""
			}, (0, react.createElement)("div", { "data-vela-recap-field-label": "" }, "工作区"), (0, react.createElement)("div", { "data-vela-recap-path": "" }, entry.workspace))], (0, react.createElement)("div", { "data-vela-recap-field": "" }, (0, react.createElement)("div", { "data-vela-recap-field-label": "" }, "落盘"), (0, react.createElement)("div", null, entry.generatedAt ?? "未记录")), ...entry.verifiedAt === void 0 ? [] : [(0, react.createElement)("div", {
				key: "vf",
				"data-vela-recap-field": ""
			}, (0, react.createElement)("div", { "data-vela-recap-field-label": "" }, "人审"), (0, react.createElement)("div", null, entry.verifiedAt))], ...entry.body.length === 0 ? [] : [(0, react.createElement)("pre", {
				key: "body",
				"data-vela-recap-body": ""
			}, entry.body)]), (0, react.createElement)("footer", { "data-vela-modal-foot": "" }, confirming ? (0, react.createElement)("span", { "data-vela-recap-confirm": "" }, "删掉这篇？更新历史里会留一行。", (0, react.createElement)("button", {
				type: "button",
				"data-tone": "danger",
				onClick: () => {
					onRemove(entry.path);
					onClose();
				}
			}, "确认删除"), (0, react.createElement)("button", {
				type: "button",
				onClick: () => setConfirming(false)
			}, "算了")) : (0, react.createElement)("button", {
				type: "button",
				"data-tone": "danger",
				onClick: () => setConfirming(true)
			}, "删除"))));
		}
		/** 一篇的紧凑卡。 */
		function recapCard(entry, onOpen) {
			return (0, react.createElement)("div", {
				key: entry.path,
				"data-vela-recap-row": "",
				"data-dim": String(entry.status === "deprecated" || entry.stale),
				role: "button",
				tabIndex: 0,
				"aria-label": `复盘 ${entry.title}，点开看全文`,
				onClick: () => onOpen(entry),
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") onOpen(entry);
				}
			}, (0, react.createElement)("span", {
				"data-vela-avatar": "",
				"data-hue": String(memberHue(entry.title)),
				"aria-hidden": "true"
			}, avatarChar(entry.title)), (0, react.createElement)("div", { "data-vela-recap-main": "" }, (0, react.createElement)("div", { "data-vela-recap-title": "" }, entry.title, ...recapChips(entry)), entry.problem !== void 0 ? (0, react.createElement)("div", { "data-vela-recap-problem": "" }, `⚠ 这篇读不了：${entry.problem}`) : (0, react.createElement)("div", { "data-vela-recap-when": "" }, entry.generatedAt === void 0 ? entry.path : entry.generatedAt.slice(0, 10))));
		}
		/** 一个工作区一列。 */
		function workspaceColumn(workspace, entries, onOpen) {
			const reviewed = entries.filter((entry) => entry.trust === "human-reviewed").length;
			return (0, react.createElement)("section", {
				key: workspace,
				"data-vela-recap-col": ""
			}, (0, react.createElement)("header", { "data-vela-recap-col-head": "" }, (0, react.createElement)("h3", null, `${workspace}（${entries.length}）`), (0, react.createElement)("div", { "data-vela-recap-hint": "" }, `${reviewed} 篇人审过，可被召回`)), (0, react.createElement)("div", { "data-vela-recap-col-body": "" }, ...entries.map((entry) => recapCard(entry, onOpen))));
		}
		/** 记忆页。 */
		function MemoryPage(props) {
			const { view, failed, loading, onRefresh, onRemove } = props;
			const [selected, setSelected] = (0, react.useState)(void 0);
			const head = (0, react.createElement)("div", { "data-vela-recap-head": "" }, (0, react.createElement)("h2", null, "记忆"), ...view === void 0 || !view.available ? [] : [(0, react.createElement)("span", {
				key: "n",
				"data-vela-chip": ""
			}, `${view.entries.length} 篇`)], (0, react.createElement)("button", {
				type: "button",
				disabled: loading,
				onClick: onRefresh,
				"aria-label": "刷新记忆列表"
			}, loading ? "在读…" : "刷新"));
			if (failed && view === void 0) return (0, react.createElement)("div", { "data-vela-memory": "" }, head, (0, react.createElement)("div", { "data-vela-error": "" }, "记忆列表拉取失败。点「刷新」重试。"));
			if (view === void 0) return (0, react.createElement)("div", { "data-vela-memory": "" }, head, (0, react.createElement)("div", { "data-vela-empty": "" }, "正在读记忆库…"));
			if (!view.available) return (0, react.createElement)("div", { "data-vela-memory": "" }, head, (0, react.createElement)("div", { "data-vela-empty": "" }, "记忆库没开启。给 Vela 配上 memoryPath（一个绝对路径）之后，每次执行结束会在那里落一篇复盘，验收时你可以顺手裁定它可不可信。"));
			if (view.entries.length === 0) return (0, react.createElement)("div", { "data-vela-memory": "" }, head, (0, react.createElement)("div", { "data-vela-empty": "" }, "还没有复盘。派一张卡、等它跑完，这里就会出现第一篇。"));
			const groups = /* @__PURE__ */ new Map();
			for (const entry of view.entries) {
				const key = entry.workspace ?? "（未记录工作区）";
				const group = groups.get(key) ?? [];
				group.push(entry);
				groups.set(key, group);
			}
			return (0, react.createElement)("div", { "data-vela-memory": "" }, head, (0, react.createElement)("div", { "data-vela-recap-cols": "" }, ...[...groups].map(([workspace, entries]) => workspaceColumn(workspace, entries, setSelected))), ...view.history.length === 0 ? [] : [(0, react.createElement)("details", {
				key: "log",
				"data-vela-recap-log": ""
			}, (0, react.createElement)("summary", null, `更新历史（${view.history.length} 条）`), (0, react.createElement)("ul", null, ...view.history.slice(0, 50).map((line, at) => (0, react.createElement)("li", { key: at }, line))))], (0, react.createElement)("div", { "data-vela-recap-footer": "" }, "只有「人审过」且未废弃未陈旧的复盘会在派活时被带给 Agent。这些文件是普通 Markdown，可以直接改、可以整个目录拷走。"), ...selected === void 0 ? [] : [(0, react.createElement)(RecapDialog, {
				key: "detail",
				entry: selected,
				onClose: () => setSelected(void 0),
				onRemove
			})]);
		}
		//#endregion
		//#region src/client/components/CreateSquadDialog.tsx
		/**
		* 创建小队的对话框。
		*
		* 参考 Multica 的创建弹窗：轻量、居中、只做**骨架**——名称加队长职责。队员
		* 刻意不放进来：每个队员要带能力白名单与后端，塞进弹窗会挤成一团。创建完进
		* 详情页再加（Multica 也是「附加成员，可选，也可稍后再加」的思路）。
		*
		* 编辑已有小队不走这里——那在详情页里改（详情页有 tab，空间够）。
		*/
		/** 创建小队的弹窗。 */
		function CreateSquadDialog(props) {
			const { busy, onClose, onCreate } = props;
			const [title, setTitle] = (0, react.useState)("");
			const [instruction, setInstruction] = (0, react.useState)("");
			const canSubmit = title.trim().length > 0 && !busy;
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					event.stopPropagation();
					onClose();
				};
				window.addEventListener("keydown", onKey, true);
				return () => window.removeEventListener("keydown", onKey, true);
			}, []);
			const submit = () => {
				if (!canSubmit) return;
				onCreate({
					title: title.trim(),
					instruction: instruction.trim()
				});
			};
			return (0, react.createElement)("div", {
				"data-vela-modal-backdrop": "",
				onClick: onClose
			}, (0, react.createElement)("div", {
				"data-vela-modal": "",
				role: "dialog",
				"aria-modal": "true",
				"aria-label": "创建小队",
				onClick: (event) => event.stopPropagation()
			}, (0, react.createElement)("header", { "data-vela-modal-head": "" }, (0, react.createElement)("strong", null, "创建小队"), (0, react.createElement)("button", {
				type: "button",
				"data-vela-icon-btn": "",
				"aria-label": "关闭",
				onClick: onClose
			}, "✕")), (0, react.createElement)("div", { "data-vela-modal-body": "" }, (0, react.createElement)("p", { "data-vela-hint": "" }, "一个队长带若干队员：队长接到任务后自己拆活、派给队员。这里先建骨架，队员进去再加。"), (0, react.createElement)("label", { "data-vela-modal-field": "" }, "小队名字", (0, react.createElement)("input", {
				value: title,
				placeholder: "例如：后端团队",
				autoFocus: true,
				onChange: (event) => setTitle(event.target.value),
				onKeyDown: (event) => {
					if (event.key === "Enter") submit();
				}
			})), (0, react.createElement)("label", { "data-vela-modal-field": "" }, "队长职责", (0, react.createElement)("textarea", {
				value: instruction,
				rows: 4,
				placeholder: "写清这支队负责什么、怎么拆活、什么算做完。",
				onChange: (event) => setInstruction(event.target.value)
			}))), (0, react.createElement)("footer", { "data-vela-modal-foot": "" }, (0, react.createElement)("button", {
				type: "button",
				onClick: onClose
			}, "取消"), (0, react.createElement)("button", {
				type: "button",
				"data-tone": "primary",
				disabled: !canSubmit,
				onClick: submit
			}, busy ? "创建中…" : "创建小队"))));
		}
		//#endregion
		//#region src/domain/role-templates.ts
		/** 全部模板，按展示顺序。 */
		const ROLE_TEMPLATES = [
			{
				id: "engineer",
				label: "工程师",
				name: "engineer",
				blurb: "写实现、修 bug，能跑命令验证",
				instruction: "你写实现代码。改动最小、贴合既有风格，完成后跑一遍相关测试。",
				abilities: [
					"read",
					"edit",
					"shell"
				]
			},
			{
				id: "researcher",
				label: "研究员",
				name: "researcher",
				blurb: "查资料、读代码、给结论，不动文件",
				instruction: "你只读不写：查资料、读代码、回答问题。结论要给出处（文件、行、链接）。",
				abilities: ["read", "web"]
			},
			{
				id: "reviewer",
				label: "审查员",
				name: "reviewer",
				blurb: "只读审查：找逻辑错误与边界漏洞",
				instruction: "你只读不写。审查改动：找逻辑错误、漏掉的边界、与既有风格不一致的地方，按严重程度列出。",
				abilities: ["read"]
			},
			{
				id: "designer",
				label: "界面设计师",
				name: "designer",
				blurb: "界面与样式，贴合既有视觉体系",
				instruction: "你负责界面与样式。保持与既有视觉体系一致：色板变量、间距节奏、明暗两套主题都要成立。",
				abilities: ["read", "edit"]
			},
			{
				id: "docs",
				label: "文档员",
				name: "docs",
				blurb: "只写文档与注释，不碰实现",
				instruction: "你只改文档与注释，不碰实现。写给人看：说清是什么、怎么用、为什么这么做。",
				abilities: ["read", "edit"]
			},
			{
				id: "analyst",
				label: "数据分析师",
				name: "analyst",
				blurb: "跑脚本、读数据、给带样本数的结论",
				instruction: "你跑脚本、读数据、给数字结论。结论必须带样本数，不许只报比例不报底数。",
				abilities: ["read", "shell"]
			}
		];
		/**
		* 把一个模板实例化成队员草稿。名字撞上已有队员时自动加序号
		* （engineer → engineer_2），因为队员名是工具名，撞了整支队起不来。
		*/
		function instantiateTemplate(template, existingNames) {
			const taken = new Set(existingNames);
			let name = template.name;
			for (let n = 2; taken.has(name); n += 1) name = `${template.name}_${n}`;
			return {
				name,
				instruction: template.instruction,
				abilities: template.abilities,
				backend: template.backend ?? "spawn"
			};
		}
		//#endregion
		//#region src/client/components/AddMemberDialog.tsx
		/**
		* 加队员的对话框。
		*
		* 结构沿用创建小队弹窗（CreateSquadDialog，Multica 移植体系）的 modal 基建：
		* 遮罩 + 居中弹窗 + 头/体/底，Esc 在捕获阶段拦截，免得连带关掉整个面板。
		* 形态参考 Qoder「新建 Waker」弹窗（遮罩压暗、角色卡片网格、四种关闭方式），
		* 但不做它的表单流——这里点卡即加，队员的名字/职责/能力加进来后在详情页改。
		*
		* 为什么从页面内联展开改成弹窗：内联展开把详情页内容往下顶，队员一多，
		* 模板区和队员列表互相挤压；挑角色是「专注做一件事」的场景，弹窗把它隔离开。
		*/
		/** 空白队员的默认骨架。 */
		function newMember(index) {
			return {
				name: `member_${index + 1}`,
				instruction: "",
				abilities: ["read"],
				backend: "spawn"
			};
		}
		/** 加队员的弹窗：6 张角色模板卡 + 1 张空白队员卡，点卡即加。 */
		function AddMemberDialog(props) {
			const { onClose, onPick } = props;
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					event.stopPropagation();
					onClose();
				};
				window.addEventListener("keydown", onKey, true);
				return () => window.removeEventListener("keydown", onKey, true);
			}, []);
			return (0, react.createElement)("div", {
				"data-vela-modal-backdrop": "",
				onClick: onClose
			}, (0, react.createElement)("div", {
				"data-vela-modal": "",
				"data-vela-add-member": "",
				role: "dialog",
				"aria-modal": "true",
				"aria-label": "加队员",
				onClick: (event) => event.stopPropagation()
			}, (0, react.createElement)("header", { "data-vela-modal-head": "" }, (0, react.createElement)("strong", null, "加队员"), (0, react.createElement)("button", {
				type: "button",
				"data-vela-icon-btn": "",
				"aria-label": "关闭",
				onClick: onClose
			}, "✕")), (0, react.createElement)("div", { "data-vela-modal-body": "" }, (0, react.createElement)("p", { "data-vela-hint": "" }, "点一张卡直接加入小队——名字、职责、能力加进来后都能在队员卡里改。"), (0, react.createElement)("div", { "data-vela-template-grid": "" }, ...ROLE_TEMPLATES.map((template) => (0, react.createElement)("button", {
				key: template.id,
				type: "button",
				"data-vela-template-card": "",
				onClick: () => onPick(instantiateTemplate(template, props.existingNames))
			}, (0, react.createElement)("span", { "data-vela-template-head": "" }, (0, react.createElement)("span", {
				"data-vela-avatar": "",
				"data-hue": String(memberHue(template.name)),
				"aria-hidden": "true"
			}, avatarChar(template.name)), (0, react.createElement)("span", { "data-vela-template-name": "" }, template.label), (0, react.createElement)("span", { "data-vela-template-tool": "" }, template.name)), (0, react.createElement)("span", { "data-vela-template-blurb": "" }, template.blurb), (0, react.createElement)("span", { "data-vela-template-abilities": "" }, template.abilities.map((a) => ABILITY_LABELS[a]).join(" · ")))), (0, react.createElement)("button", {
				key: "__blank",
				type: "button",
				"data-vela-template-card": "",
				"data-tone": "blank",
				onClick: () => onPick(newMember(props.memberCount))
			}, (0, react.createElement)("span", { "data-vela-template-head": "" }, (0, react.createElement)("span", {
				"data-vela-template-plus": "",
				"aria-hidden": "true"
			}, "+"), (0, react.createElement)("span", { "data-vela-template-name": "" }, "空白队员")), (0, react.createElement)("span", { "data-vela-template-blurb": "" }, "从零写：名字、职责、能力都自己定")))), (0, react.createElement)("footer", { "data-vela-modal-foot": "" }, (0, react.createElement)("button", {
				type: "button",
				onClick: onClose
			}, "取消"))));
		}
		//#endregion
		//#region src/client/components/SquadDetail.tsx
		/**
		* 小队详情页：点进一支小队后的界面。
		*
		* 参考 Multica 的详情页用 **tab 分区**——成员 / 职责说明 / 设置——不再把所有
		* 字段堆成一长条。这解决了之前「编辑器没有呼吸感」的核心问题：每个 tab 只放
		* 一类事。
		*
		* 层级仍然守住（ADR-0017）：权限档位在「设置」tab（队级），队员的能力白名单
		* 在「成员」tab（队员级），两个 tab 天然把它们隔开，不会让人以为能混着设。
		*
		* 编辑是草稿式的：所有改动先落在本地 draft，点「保存」才提交——不会每敲一个
		* 字就写盘。
		*/
		/** 「沿用全局默认」这个档位选项的哨兵值。\u0000 前缀让它不会撞任何真实档位名。 */
		const INHERIT = "\0inherit";
		function draftOf(squad) {
			return {
				title: squad.title,
				instruction: squad.instruction,
				members: squad.members.map((member) => ({ ...member })),
				sandbox: squad.sandbox ?? INHERIT,
				maxParallelMembers: squad.maxParallelMembers
			};
		}
		/** 小队详情页。 */
		function SquadDetail(props) {
			const { squad, platform, busy } = props;
			const [draft, setDraft] = (0, react.useState)(() => draftOf(squad));
			const [tab, setTab] = (0, react.useState)("members");
			/** 「+ 加队员」的弹窗是否打开。 */
			const [dialogOpen, setDialogOpen] = (0, react.useState)(false);
			const patch = (change) => {
				setDraft((current) => ({
					...current,
					...change
				}));
			};
			/** 弹窗里点中一张卡：队员进草稿，然后关窗——任务完成了就别再占着地方。 */
			const addMember = (member) => {
				patch({ members: [...draft.members, member] });
				setDialogOpen(false);
			};
			const patchMember = (index, change) => {
				setDraft((current) => ({
					...current,
					members: current.members.map((member, at) => at === index ? {
						...member,
						...change
					} : member)
				}));
			};
			const save = () => {
				props.onSave(squad.id, {
					title: draft.title.trim(),
					instruction: draft.instruction,
					members: draft.members,
					maxParallelMembers: draft.maxParallelMembers,
					...draft.sandbox === INHERIT ? {} : { sandbox: draft.sandbox }
				});
			};
			const tabs = [
				{
					key: "members",
					label: `成员 ${draft.members.length + 1}`
				},
				{
					key: "instructions",
					label: "职责说明"
				},
				{
					key: "settings",
					label: "设置"
				}
			];
			/** 队长固定拿着的能力。只读展示——它们来自基准 preset，不在小队层面改。 */
			const LEADER_ABILITIES = [
				"读文件",
				"改文件",
				"跑命令",
				"联网",
				"委派队员"
			];
			return (0, react.createElement)("div", { "data-vela-squad-detail": "" }, (0, react.createElement)("div", { "data-vela-detail-head": "" }, (0, react.createElement)("button", {
				type: "button",
				"data-vela-back": "",
				onClick: props.onBack
			}, "← 小队"), (0, react.createElement)("input", {
				"data-vela-detail-title": "",
				value: draft.title,
				"aria-label": "小队名字",
				onChange: (event) => patch({ title: event.target.value })
			}), (0, react.createElement)("button", {
				type: "button",
				"data-vela-icon-btn": "",
				"data-tone": "danger",
				"aria-label": `删除小队 ${squad.title}`,
				title: "删除小队",
				onClick: () => props.onDelete(squad.id)
			}, "✕")), (0, react.createElement)("div", {
				"data-vela-tabs": "",
				role: "tablist"
			}, ...tabs.map((item) => (0, react.createElement)("button", {
				key: item.key,
				type: "button",
				role: "tab",
				"aria-selected": tab === item.key,
				"data-active": String(tab === item.key),
				onClick: () => setTab(item.key)
			}, item.label))), (0, react.createElement)("div", { "data-vela-detail-body": "" }, ...tab === "members" ? [(0, react.createElement)("div", { key: "members" }, (0, react.createElement)("div", { "data-vela-squad-head": "" }, (0, react.createElement)("div", { "data-vela-hint": "" }, "队长接收派给这支队的第一手任务，再按职责分给队员。工具是队员级的——每个队员只能用自己那几类（跟「设置」里的队级档位不是一回事）。"), (0, react.createElement)("div", { "data-vela-squad-add": "" }, (0, react.createElement)("button", {
				type: "button",
				"data-tone": "primary",
				onClick: () => setDialogOpen(true)
			}, "+ 加队员"))), (0, react.createElement)("div", { "data-vela-leader": "" }, (0, react.createElement)("div", { "data-vela-member-head": "" }, (0, react.createElement)("span", {
				"data-vela-avatar": "",
				"data-hue": "leader",
				"aria-hidden": "true"
			}, "队"), (0, react.createElement)("span", { "data-vela-leader-name": "" }, "队长"), (0, react.createElement)("span", { "data-vela-leader-badge": "" }, "LEADER")), (0, react.createElement)("textarea", {
				"data-vela-member-instruction": "",
				value: draft.instruction,
				rows: 2,
				placeholder: "队长的常驻职责：这支队负责什么、怎么拆活、什么算做完。",
				"aria-label": "队长职责",
				onChange: (event) => patch({ instruction: event.target.value })
			}), (0, react.createElement)("div", {
				"data-vela-abilities": "",
				"data-readonly": ""
			}, ...LEADER_ABILITIES.map((label) => (0, react.createElement)("span", {
				key: label,
				"data-vela-ability": label,
				"data-on": "true"
			}, (0, react.createElement)("span", null, label)))), (0, react.createElement)("div", { "data-vela-member-tools": "" }, "队长拿全部能力——安全边界设在队员身上：每个队员只能用自己白名单里的工具。")), ...draft.members.length === 0 ? [(0, react.createElement)("div", {
				key: "none",
				"data-vela-empty": ""
			}, "还没有队员。右上「+ 加队员」可以从角色模板一键起一个——先建一个光杆队长也是正当用法。")] : [(0, react.createElement)("div", {
				key: "grid",
				"data-vela-member-grid": ""
			}, ...draft.members.map((member, index) => (0, react.createElement)(MemberEditor, {
				key: index,
				member,
				index,
				platform,
				modelCatalog: props.modelCatalog,
				onPatch: (change) => patchMember(index, change),
				onRemove: () => patch({ members: draft.members.filter((_, at) => at !== index) })
			})))])] : [], ...tab === "instructions" ? [(0, react.createElement)("div", { key: "instructions" }, (0, react.createElement)("label", { "data-vela-modal-field": "" }, "队长职责", (0, react.createElement)("textarea", {
				value: draft.instruction,
				rows: 6,
				placeholder: "写清这支队负责什么、怎么拆活、什么算做完。",
				onChange: (event) => patch({ instruction: event.target.value })
			})), (0, react.createElement)("details", { "data-vela-roster-fold": "" }, (0, react.createElement)("summary", null, `队员名册（${draft.members.length} 人）——队长实际会看到`), (0, react.createElement)("div", { "data-vela-hint": "" }, "Vela 会把这段名册自动追加到队长的职责说明后面。DSH 给每个队员生成的工具说明是同一句通用话术，不加名册队长分不出谁是谁。"), (0, react.createElement)("pre", { "data-vela-roster": "" }, leaderInstruction({
				id: squad.id,
				title: draft.title,
				instruction: "",
				members: draft.members,
				maxParallelMembers: draft.maxParallelMembers
			}, platform).trim() || "（还没有队员）")))] : [], ...tab === "settings" ? [(0, react.createElement)("div", { key: "settings" }, (0, react.createElement)("div", { "data-vela-hint": "" }, "权限档位对整个小队生效——队员继承它且不能超出（这是队级，不是某个队员的）。"), (0, react.createElement)("div", { "data-vela-field-row": "" }, (0, react.createElement)("label", null, "权限档位", (0, react.createElement)("select", {
				value: draft.sandbox,
				onChange: (event) => patch({ sandbox: event.target.value })
			}, (0, react.createElement)("option", {
				key: INHERIT,
				value: INHERIT
			}, "沿用全局默认"), ...props.sandboxPresets.map((name) => (0, react.createElement)("option", {
				key: name,
				value: name
			}, name)))), (0, react.createElement)("label", null, "同时最多几个队员在跑", (0, react.createElement)("input", {
				type: "number",
				min: 1,
				value: String(draft.maxParallelMembers),
				onChange: (event) => {
					const parsed = Number.parseInt(event.target.value, 10);
					patch({ maxParallelMembers: Number.isInteger(parsed) && parsed >= 1 ? parsed : 1 });
				}
			}))), (0, react.createElement)("div", { "data-vela-hint": "" }, "并发上限是硬拦截：领不到号牌的队员会排队等，不是靠劝队长自律。"))] : []), (0, react.createElement)("div", { "data-vela-detail-foot": "" }, (0, react.createElement)("button", {
				type: "button",
				"data-tone": "primary",
				disabled: busy || draft.title.trim().length === 0,
				onClick: save
			}, busy ? "保存中…" : "保存"), (0, react.createElement)("button", {
				type: "button",
				disabled: busy,
				onClick: props.onBack
			}, "放弃改动")), ...dialogOpen ? [(0, react.createElement)(AddMemberDialog, {
				key: "add-member",
				existingNames: draft.members.map((m) => m.name),
				memberCount: draft.members.length,
				onPick: addMember,
				onClose: () => setDialogOpen(false)
			})] : []);
		}
		//#endregion
		//#region src/client/components/SquadsPage.tsx
		/**
		* 小队页（重构后）。
		*
		* 三个状态，而不是过去那种「列表和一长条编辑器挤在一个页面」：
		* - **列表**：干净的一行一支，点进去看详情。删除是右上角的小图标。
		* - **创建**：弹一个居中的对话框（CreateSquadDialog），只建骨架。
		* - **详情**：点进一支后整页给它，用 tab 分区（SquadDetail）。
		*
		* 编辑逻辑（草稿、保存）沉在 SquadDetail 里；这里只做视图切换与提交。
		*/
		/** 小队页。 */
		function SquadsPage(props) {
			const { client, onChanged } = props;
			const [view, setView] = (0, react.useState)({ kind: "list" });
			const [createOpen, setCreateOpen] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const act = async (operation) => {
				if (busy) return false;
				setBusy(true);
				setError(void 0);
				try {
					const result = await operation();
					if (!result.ok) {
						setError(result.message ?? "操作失败");
						return false;
					}
					await onChanged();
					return true;
				} finally {
					setBusy(false);
				}
			};
			if (!props.canManage) return (0, react.createElement)("div", { "data-vela-squads": "" }, (0, react.createElement)("div", { "data-vela-empty": "" }, "这个部署没有可写的 agent 配置目录，所以建不了小队。给 Vela 配上 squadRoot 就能用。"));
			if (view.kind === "detail") {
				const squad = props.squads.find((item) => item.id === view.id);
				if (squad === void 0) {
					setView({ kind: "list" });
					return (0, react.createElement)("div", { "data-vela-squads": "" });
				}
				return (0, react.createElement)("div", { "data-vela-squads": "" }, (0, react.createElement)(SquadDetail, {
					key: squad.id,
					squad,
					platform: props.platform,
					modelCatalog: props.modelCatalog,
					sandboxPresets: props.sandboxPresets,
					busy,
					onBack: () => setView({ kind: "list" }),
					onSave: (id, payload) => {
						act(() => client.updateSquad(id, payload)).then((ok) => {
							if (ok) setView({ kind: "list" });
						});
					},
					onDelete: (id) => {
						act(() => client.deleteSquad(id)).then((ok) => {
							if (ok) setView({ kind: "list" });
						});
					}
				}));
			}
			return (0, react.createElement)("div", { "data-vela-squads": "" }, ...error === void 0 ? [] : [(0, react.createElement)("div", {
				key: "err",
				"data-vela-error": ""
			}, error)], (0, react.createElement)("div", { "data-vela-squad-head": "" }, (0, react.createElement)("h2", null, "小队"), (0, react.createElement)("button", {
				type: "button",
				"data-tone": "primary",
				disabled: busy,
				onClick: () => setCreateOpen(true)
			}, "新建小队")), ...props.squads.length === 0 ? [(0, react.createElement)("div", {
				key: "empty",
				"data-vela-empty": ""
			}, "还没有小队。一支小队 = 一个队长 + 若干队员，队长自己决定把活派给谁。")] : props.squads.map((squad) => (0, react.createElement)("div", {
				key: squad.id,
				"data-vela-squad-row": squad.id,
				role: "button",
				tabIndex: 0,
				onClick: () => setView({
					kind: "detail",
					id: squad.id
				}),
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") setView({
						kind: "detail",
						id: squad.id
					});
				}
			}, (0, react.createElement)("span", {
				"data-vela-avatar": "",
				"data-hue": String(memberHue(squad.title)),
				"aria-hidden": "true"
			}, avatarChar(squad.title)), (0, react.createElement)("div", { "data-vela-squad-main": "" }, (0, react.createElement)("div", { "data-vela-squad-title": "" }, squad.title), (0, react.createElement)("div", { "data-vela-squad-meta": "" }, (0, react.createElement)("span", { "data-vela-chip": "" }, `${squad.members.length + 1} 名成员`), (0, react.createElement)("span", { "data-vela-chip": "" }, `同时最多 ${squad.maxParallelMembers} 个在跑`), (0, react.createElement)("span", { "data-vela-chip": "" }, squad.sandbox === void 0 ? "档位沿用默认" : squad.sandbox))), (0, react.createElement)("button", {
				type: "button",
				disabled: busy,
				"data-vela-icon-btn": "",
				"data-tone": "danger",
				"aria-label": `删除小队 ${squad.title}`,
				title: "删除小队",
				onClick: (event) => {
					event.stopPropagation();
					act(() => client.deleteSquad(squad.id));
				}
			}, "✕"))), ...createOpen ? [(0, react.createElement)(CreateSquadDialog, {
				key: "create",
				busy,
				onClose: () => setCreateOpen(false),
				onCreate: (input) => {
					act(() => client.createSquad({
						title: input.title,
						instruction: input.instruction,
						members: [],
						maxParallelMembers: 3
					})).then((ok) => {
						if (ok) setCreateOpen(false);
					});
				}
			})] : []);
		}
		//#endregion
		//#region src/client/components/BoardPanel.tsx
		/**
		* 全幅 Board 面板（票 03，挂 shell.overlay）。overlay 层是 absolute inset:0 /
		* z-index:20 / pointer-events:none 的点击穿透层，因此这里的根节点必须自己开启
		* pointer-events（样式里做），并靠 data-* 提供样式钩子（不耦合哈希 class）。
		*
		* 面板关闭时渲染 null——不占据 overlay、不拦截下面的点击。打开时：
		* - 全幅覆盖（含 sidebar 之上），因为 shell.overlay 的 owner props 是空对象，
		*   拿不到 sidebar 宽度，全幅是唯一稳妥的几何（ADR-0002）。
		* - Escape 关闭；打开时把焦点移入面板，关闭时不劫持。
		* - 打开期间轮询 Board 视图；失败保留上次成功快照。
		*/
		/** 打开时的轮询间隔。够实时，又不打爆回环。 */
		const POLL_MS = 2e3;
		/** 「全部 Workspace」这个筛选选项的哨兵值。 */
		const ALL = "\0all";
		/** 全幅 Board 面板。 */
		function BoardPanel(props) {
			const { panel, client } = props;
			const [isOpen, setOpen] = (0, react.useState)(panel.isOpen());
			const [view, setView] = (0, react.useState)(client.snapshot);
			const [workspace, setWorkspace] = (0, react.useState)(ALL);
			const [nav, setNav] = (0, react.useState)("board");
			/**
			* 搜索词。**不落盘**（票 11）：刷新后回到未搜索状态。一个被持久化的搜索词
			* 会让下一次打开看板时看到一个残缺的看板，而原因藏在输入框里。
			*/
			const [query, setQuery] = (0, react.useState)("");
			const [notice, setNotice] = (0, react.useState)(void 0);
			/**
			* 详情抽屉里那张卡的 id。存 id 而不是整个 Issue 对象：轮询会拿回新快照，
			* 存对象会让抽屉停在打开那一瞬的旧数据上（比如 Run 跑完了但抽屉里还写着
			* 「正在跑」）。
			*/
			const [selectedId, setSelectedId] = (0, react.useState)(void 0);
			const [skillsView, setSkillsView] = (0, react.useState)(void 0);
			const [skillsFailed, setSkillsFailed] = (0, react.useState)(false);
			const [skillsLoading, setSkillsLoading] = (0, react.useState)(false);
			const [memoryView, setMemoryView] = (0, react.useState)(void 0);
			const [memoryFailed, setMemoryFailed] = (0, react.useState)(false);
			const [memoryLoading, setMemoryLoading] = (0, react.useState)(false);
			const rootRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const unsubscribe = panel.subscribe(() => setOpen(panel.isOpen()));
				return () => {
					unsubscribe();
				};
			}, [panel]);
			const refresh = (0, react.useCallback)(async () => {
				const next = await client.refresh();
				if (next !== void 0) setView(next);
			}, [client]);
			const refreshSkills = (0, react.useCallback)(async () => {
				setSkillsLoading(true);
				try {
					const next = await client.listSkills();
					setSkillsFailed(next === void 0);
					if (next !== void 0) setSkillsView(next);
				} finally {
					setSkillsLoading(false);
				}
			}, [client]);
			(0, react.useEffect)(() => {
				if (!isOpen || nav !== "skills") return;
				refreshSkills();
			}, [
				isOpen,
				nav,
				refreshSkills
			]);
			const refreshMemory = (0, react.useCallback)(async () => {
				setMemoryLoading(true);
				try {
					const next = await client.listMemory();
					setMemoryFailed(next === void 0);
					if (next !== void 0) setMemoryView(next);
				} finally {
					setMemoryLoading(false);
				}
			}, [client]);
			(0, react.useEffect)(() => {
				if (!isOpen || nav !== "memory") return;
				refreshMemory();
			}, [
				isOpen,
				nav,
				refreshMemory
			]);
			const removeRecap = (0, react.useCallback)(async (path) => {
				const next = await client.removeRecap(path);
				if (next === void 0) {
					refreshMemory();
					return;
				}
				setMemoryView(next);
				setMemoryFailed(false);
			}, [client, refreshMemory]);
			(0, react.useEffect)(() => {
				if (!isOpen) return void 0;
				refresh();
				const timer = setInterval(() => {
					refresh();
				}, POLL_MS);
				return () => {
					clearInterval(timer);
				};
			}, [isOpen, refresh]);
			(0, react.useEffect)(() => {
				if (!isOpen) return void 0;
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					if (selectedId !== void 0) {
						setSelectedId(void 0);
						return;
					}
					panel.close();
				};
				window.addEventListener("keydown", onKey);
				return () => {
					window.removeEventListener("keydown", onKey);
				};
			}, [
				isOpen,
				panel,
				selectedId
			]);
			(0, react.useEffect)(() => {
				if (isOpen) rootRef.current?.focus();
			}, [isOpen]);
			const workspaces = (0, react.useMemo)(() => {
				const seen = /* @__PURE__ */ new Set();
				for (const issue of view?.board.issues ?? []) seen.add(issue.workspace);
				return [...seen].sort();
			}, [view]);
			(0, react.useEffect)(() => {
				if (workspace !== ALL && !workspaces.includes(workspace)) setWorkspace(ALL);
			}, [workspace, workspaces]);
			if (!isOpen) return null;
			const all = view?.board.issues ?? [];
			const inWorkspace = workspace === ALL ? all : all.filter((issue) => issue.workspace === workspace);
			const attentionIssues = inWorkspace.filter((issue) => issue.lane === "review" || issue.lane === "failed");
			const attentionCount = all.filter((issue) => issue.lane === "review" || issue.lane === "failed").length;
			const visible = searchIssues(nav === "attention" ? attentionIssues : inWorkspace, query);
			const searching = query.trim().length > 0;
			const selected = selectedId === void 0 ? void 0 : all.find((issue) => issue.id === selectedId);
			const openDocument = (target) => {
				client.openDocument(target).then((outcome) => {
					if (outcome.opened) {
						setNotice(void 0);
						return;
					}
					setNotice(outcome.path === void 0 ? "这个环境打不开配置文件" : `打不开，文件在：${outcome.path}`);
				});
			};
			return (0, react.createElement)("div", {
				ref: rootRef,
				tabIndex: -1,
				role: "dialog",
				"aria-label": "Vela board",
				"data-vela-panel": ""
			}, (0, react.createElement)("header", { "data-vela-bar": "" }, (0, react.createElement)("span", { "data-vela-title": "" }, "Vela"), (0, react.createElement)("span", { "data-vela-spacer": "" }), ...notice === void 0 ? [] : [(0, react.createElement)("span", {
				key: "notice",
				"data-vela-notice": ""
			}, notice)], ...nav === "squads" || nav === "skills" || nav === "memory" ? [] : [(0, react.createElement)("label", {
				key: "search",
				"data-vela-search": ""
			}, (0, react.createElement)("input", {
				type: "search",
				value: query,
				placeholder: "找卡：编号、标题、描述",
				"aria-label": "搜索卡片",
				onChange: (event) => setQuery(event.target.value)
			}), ...searching ? [(0, react.createElement)("span", {
				key: "hits",
				"data-vela-search-hits": ""
			}, `${visible.length} 张`)] : [])], ...nav === "squads" || nav === "skills" || nav === "memory" ? [] : [(0, react.createElement)("label", {
				key: "filter",
				"data-vela-filter": ""
			}, "Workspace", (0, react.createElement)("select", {
				value: workspace,
				style: {
					width: "auto",
					maxWidth: "22rem"
				},
				"aria-label": "filter by workspace",
				onChange: (event) => setWorkspace(event.target.value)
			}, (0, react.createElement)("option", {
				key: ALL,
				value: ALL
			}, `全部（${workspaces.length}）`), ...workspaces.map((path) => (0, react.createElement)("option", {
				key: path,
				value: path
			}, path))))], (0, react.createElement)("button", {
				type: "button",
				onClick: () => {
					refresh();
				},
				"aria-label": "refresh"
			}, "刷新"), (0, react.createElement)("button", {
				type: "button",
				onClick: () => panel.close(),
				"aria-label": "close"
			}, "关闭")), (0, react.createElement)("div", { "data-vela-body": "" }, (0, react.createElement)(PanelSidebar, {
				current: nav,
				attention: attentionCount,
				onSelect: setNav,
				onClosePanel: () => panel.close(),
				onOpenDocument: openDocument
			}), nav === "squads" ? (0, react.createElement)(SquadsPage, {
				squads: view?.squads ?? [],
				canManage: view?.canManageSquads ?? false,
				sandboxPresets: view?.sandboxPresets ?? [],
				platform: view?.platform ?? "linux",
				modelCatalog: view?.modelCatalog ?? [],
				client,
				onChanged: refresh
			}) : nav === "skills" ? (0, react.createElement)(SkillsPage, {
				...skillsView === void 0 ? {} : { view: skillsView },
				failed: skillsFailed,
				loading: skillsLoading,
				onRefresh: () => {
					refreshSkills();
				}
			}) : nav === "memory" ? (0, react.createElement)(MemoryPage, {
				...memoryView === void 0 ? {} : { view: memoryView },
				failed: memoryFailed,
				loading: memoryLoading,
				onRefresh: () => {
					refreshMemory();
				},
				onRemove: (path) => {
					removeRecap(path);
				}
			}) : searching && visible.length === 0 ? (0, react.createElement)("div", { "data-vela-no-results": "" }, (0, react.createElement)("p", void 0, `没有卡片匹配「${query.trim()}」。`), (0, react.createElement)("p", { "data-vela-muted": "" }, "编号可以只打数字（比如 12），标题与描述是模糊匹配。"), (0, react.createElement)("button", {
				type: "button",
				onClick: () => setQuery("")
			}, "清空搜索"), (0, react.createElement)("button", {
				type: "button",
				onClick: () => panel.close(),
				title: "DSH 没有给插件的跳页接口，只能把看板让开"
			}, "去 DSH 找历史会话")) : (0, react.createElement)(BoardGrid, {
				issues: visible,
				showWorkspace: workspace === ALL,
				defaultWorkspace: workspace === ALL ? workspaces[0] ?? "" : workspace,
				sandboxPresets: view?.sandboxPresets ?? [],
				squads: view?.squads ?? [],
				canDispatch: view?.canDispatch ?? false,
				liveUsage: view?.liveUsage ?? {},
				liveMembers: view?.liveMembers ?? {},
				selectedId,
				onSelect: setSelectedId,
				openSession: props.openSession,
				client,
				onChanged: refresh
			}), ...selected === void 0 ? [] : [(0, react.createElement)(IssueDrawer, {
				key: "drawer",
				issue: selected,
				liveUsage: view?.liveUsage?.[selected.id],
				...view?.timelines === void 0 ? {} : { timelines: view.timelines },
				client,
				openSession: props.openSession,
				onChanged: refresh,
				onClose: () => setSelectedId(void 0)
			})]));
		}
		//#endregion
		//#region src/domain/extract.ts
		/**
		* 一行最短要有几个字才算候选。
		*
		* 一两个字的清单项（「是」「好」「1」）几乎总是别的东西——表格残片、
		* 枚举值、代码里的数组元素。
		*/
		const MIN_TITLE_LENGTH = 4;
		/** 一行最长到哪就不像标题了。超过的多半是整段说明被写成了一个列表项。 */
		const MAX_TITLE_LENGTH = 120;
		/**
		* 列表标记：`- `、`* `、`+ `、`1. `、`1) `、`（1）`。
		*
		* 刻意**不**认无标记的裸行——那会把整段散文的每一行都当成候选。
		*
		* 符号类标记（`-` `*` `+`）**必须**跟一个空白，否则 `-减去` 、`*星号` 这类
		* 行文会被当成列表。编号类标记的空白是**可选**的：中文习惯里
		* `1.先跑一遍` 与 `（1）先跑一遍` 都不加空格，而它们的标记本身已经够明确。
		*/
		const LIST_MARKER = /^\s{0,6}(?:[-*+]\s+|(?:\d{1,3}[.)]|（\d{1,3}）|\(\d{1,3}\))\s*)/;
		/** 已勾选的复选框。这些是**已完成**的事，不该再变成待办。 */
		const CHECKED_BOX = /^\[[xX✓]\]\s*/;
		/** 未勾选的复选框，去掉标记后剩下的才是标题。 */
		const UNCHECKED_BOX = /^\[\s?\]\s*/;
		/** 行内 markdown 强调与代码标记。留着会让卡片标题里带一堆星号反引号。 */
		const INLINE_MARKS = /(\*\*|__|`|~~)/g;
		/** 行尾的引用式脚注与括注编号，例如 `…（见上）` 后面跟的 `[1]`。 */
		const TRAILING_REF = /\s*\[\^?\d+\]\s*$/;
		/**
		* 把一行清理成候选标题；判定它不是候选时返回 undefined。
		* @param line - 原始一行。
		* @returns 清理后的标题，或 undefined。
		*/
		function titleOf(line) {
			if (!LIST_MARKER.test(line)) return void 0;
			let text = line.replace(LIST_MARKER, "").trim();
			if (CHECKED_BOX.test(text)) return void 0;
			text = text.replace(UNCHECKED_BOX, "");
			text = text.replace(INLINE_MARKS, "").replace(TRAILING_REF, "").trim();
			if (!/[\p{L}\p{N}]/u.test(text)) return void 0;
			if (text.length < MIN_TITLE_LENGTH || text.length > MAX_TITLE_LENGTH) return void 0;
			return text;
		}
		/**
		* 从若干段文本里挑出候选待办。
		*
		* 同一条待办在一次会话里常被重复提及（先列计划、后逐条确认），所以按标题去重，
		* 保留第一次出现的位置——那通常是它被提出来的地方。
		*
		* @param texts - 会话里的文本段，按时间顺序。
		* @returns 候选清单，按出现顺序。
		*/
		function extractCandidates(texts) {
			const seen = /* @__PURE__ */ new Set();
			const found = [];
			for (const [source, text] of texts.entries()) for (const line of stripFences(text).split("\n")) {
				const title = titleOf(line);
				if (title === void 0) continue;
				const key = title.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				found.push({
					title,
					source
				});
			}
			return found;
		}
		/**
		* 去掉围栏代码块。
		*
		* 未闭合的围栏（模型输出被截断时常见）按「一直开到结尾」处理——宁可少捞几条，
		* 也不要把半个配置文件变成一堆卡片。
		*
		* @param text - 原始文本。
		* @returns 去掉围栏块后的文本。
		*/
		function stripFences(text) {
			const kept = [];
			let inside = false;
			for (const line of text.split("\n")) {
				if (/^\s*(?:```|~~~)/.test(line)) {
					inside = !inside;
					continue;
				}
				if (!inside) kept.push(line);
			}
			return kept.join("\n");
		}
		//#endregion
		//#region src/client/components/SessionExtract.tsx
		/**
		* 会话头部的「提取待办」按钮与它的候选清单（票 13）。
		*
		* 这是 Vela 唯一一个挂在**会话作用域**的界面：Board 面板挂在最外层，定义上不知道
		* 「当前会话」是哪个，所以「把刚讨论的事变成卡片」这件事只能在这里做。
		*
		* 三个数据都从框架给的标准 props 来，不额外走网络：
		* - 会话 id：框架直接给 `sessionId`
		* - 消息文本：`useSession()` 拿到的快照里的 `nodes`
		* - 工作目录：会话列表里那一行的 `cwd`
		*
		* **一个诚实的限制**：`nodes` 只覆盖当前已加载的那一扇窗口。客户端没有能读完整
		* 历史的接口（那是宿主侧的 API），所以往前滚过很远的长会话会漏掉早期的待办。
		* 快照的 `hasMore` 会告诉我们这种情况，界面上如实写出来，而不是默默少捞几条。
		*/
		/** 从一个节点里取出纯文本。 */
		function textOf(node) {
			return [...node.content ?? [], ...node.blocks ?? []].filter((block) => (block.kind ?? block.type) === "text" || block.kind === void 0 && block.type === "text").map((block) => block.text ?? "").join("\n");
		}
		/** 会话头部的提取按钮。 */
		function SessionExtract(props) {
			const { client, sessions, sessionId, useSession, onCreated } = props;
			const [open, setOpen] = (0, react.useState)(false);
			const [picked, setPicked] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [busy, setBusy] = (0, react.useState)(false);
			const [problem, setProblem] = (0, react.useState)(void 0);
			const texts = useSession((snapshot) => open ? (snapshot.nodes ?? []).map(textOf).filter((text) => text.trim().length > 0) : []);
			const truncated = useSession((snapshot) => snapshot.hasMore === true);
			const candidates = extractCandidates(texts);
			const workspace = sessions.list?.get?.()?.byId?.[sessionId]?.cwd;
			const toggle = (title) => {
				setPicked((current) => {
					const next = new Set(current);
					if (next.has(title)) next.delete(title);
					else next.add(title);
					return next;
				});
			};
			const create = async () => {
				if (workspace === void 0 || picked.size === 0) return;
				setBusy(true);
				setProblem(void 0);
				const titles = candidates.map((one) => one.title).filter((title) => picked.has(title));
				const result = await client.createBatch(workspace, titles);
				setBusy(false);
				if (result.ok !== true) {
					setProblem(result.message);
					return;
				}
				setPicked(/* @__PURE__ */ new Set());
				setOpen(false);
				onCreated();
			};
			if (!open) return (0, react.createElement)("button", {
				type: "button",
				onClick: () => setOpen(true),
				"data-vela-extract-open": "",
				title: "把这次讨论里的待办提取成卡片"
			}, "提取待办");
			return (0, react.createElement)("div", { "data-vela-extract": "" }, (0, react.createElement)("div", { "data-vela-extract-head": "" }, (0, react.createElement)("strong", void 0, `提取待办（${candidates.length}）`), (0, react.createElement)("button", {
				type: "button",
				onClick: () => setOpen(false),
				"aria-label": "收起"
			}, "×")), workspace === void 0 ? (0, react.createElement)("div", {
				"data-vela-extract-note": "",
				"data-tone": "warn"
			}, "这个会话没有记下工作目录，没法自动决定卡片归哪个仓库。请在看板里手动建卡。") : (0, react.createElement)("div", { "data-vela-extract-note": "" }, `建到：${workspace}`), truncated ? (0, react.createElement)("div", {
				"data-vela-extract-note": "",
				"data-tone": "warn"
			}, "只扫了当前已加载的消息。更早的内容需要先在会话里往上滚，让它加载出来。") : void 0, candidates.length === 0 ? (0, react.createElement)("div", { "data-vela-extract-empty": "" }, "没找到清单形式的待办。提取只认「- 」「1. 」这类列表行——散文里的事得自己建卡。") : (0, react.createElement)("ul", { "data-vela-extract-list": "" }, ...candidates.map((candidate) => (0, react.createElement)("li", { key: candidate.title }, (0, react.createElement)("label", void 0, (0, react.createElement)("input", {
				type: "checkbox",
				checked: picked.has(candidate.title),
				onChange: () => toggle(candidate.title)
			}), (0, react.createElement)("span", void 0, candidate.title))))), problem === void 0 ? void 0 : (0, react.createElement)("div", {
				"data-vela-extract-note": "",
				"data-tone": "bad"
			}, problem), (0, react.createElement)("div", { "data-vela-extract-foot": "" }, (0, react.createElement)("button", {
				type: "button",
				disabled: busy || picked.size === 0 || workspace === void 0,
				onClick: () => {
					create();
				},
				"data-vela-extract-create": ""
			}, busy ? "正在建…" : `建 ${picked.size} 张卡`), candidates.length === 0 ? void 0 : (0, react.createElement)("button", {
				type: "button",
				onClick: () => setPicked(picked.size === candidates.length ? /* @__PURE__ */ new Set() : new Set(candidates.map((one) => one.title)))
			}, picked.size === candidates.length ? "全不选" : "全选")));
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Vela client half（票 03 / 13）。三个 slot entry：
		* - `sidebar.footer.action`（根作用域）：导航项，点击切换面板开关。
		* - `shell.overlay`（根作用域）：全幅 Board 面板（ADR-0002）。
		* - `conversation.session.header.actions`（**会话**作用域）：把这次讨论里的待办
		*   提取成卡片。它必须挂在这里而不是面板里：根作用域的 slot 拿不到
		*   「当前会话」，而提取的全部前提就是知道当前会话是哪个。
		* 前两个共享同一个 panel-state 单例，因此点导航项能开合面板。
		*
		* 所有注册、controller、listener 都随 client fiber dispose——绑在
		* ctx.effect 的 disposer 上，HMR 不留泄漏。
		*/
		/** 浏览器侧插件名。 */
		const name = "vela";
		/**
		* 需要 slots（注册入口）与 sessions（跳到一次执行的会话）。两者都是 web shell 的
		* 核心服务，官方的十几个 client 插件同样这么声明。
		*/
		const inject = ["slots", "sessions"];
		/** 应用 client 插件。 */
		function apply(ctx) {
			ctx.effect(() => {
				const panel = createPanelState();
				const client = new BoardClient((input, init) => globalThis.fetch(input, init));
				const openSession = (sessionId) => {
					const ids = ctx.sessions.list?.get?.()?.ids;
					if (ids !== void 0 && !ids.includes(sessionId)) return false;
					try {
						ctx.sessions.open(sessionId);
						panel.close();
						return true;
					} catch {
						return false;
					}
				};
				const injected = {
					panel,
					client,
					openSession
				};
				const disposeStyles = installStyles(globalThis.document);
				const disposers = [];
				ctx.slots.inject("sidebar.footer.action", () => {
					const dispose = ctx.slots.register({
						name: "sidebar.footer.action",
						id: "vela-nav",
						order: 20,
						inject: () => injected
					}, BoardNav);
					disposers.push(dispose);
					return dispose;
				});
				ctx.slots.inject("shell.overlay", () => {
					const dispose = ctx.slots.register({
						name: "shell.overlay",
						id: "vela-board",
						order: 20,
						inject: () => injected
					}, BoardPanel);
					disposers.push(dispose);
					return dispose;
				});
				const extractInjected = {
					client,
					sessions: ctx.sessions,
					onCreated: () => {
						client.refresh();
					}
				};
				ctx.slots.inject("conversation.session.header.actions", () => {
					const dispose = ctx.slots.register({
						name: "conversation.session.header.actions",
						id: "vela-extract",
						order: 40,
						inject: () => extractInjected
					}, SessionExtract);
					disposers.push(dispose);
					return dispose;
				});
				return () => {
					for (const dispose of disposers) dispose();
					disposeStyles();
				};
			}, "vela: sidebar nav + board overlay");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return exports;
	}
});
