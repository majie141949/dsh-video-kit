import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { homedir } from "node:os";

//#region src/shared/constants.ts
const PLUGIN_ID = "dsh-video-kit";
const ROUTE_PREFIX = "/api/video-kit";
const TOOL_NAMES = {
	generate: "video_generate",
	status: "video_status",
	list: "video_list",
	cancel: "video_cancel"
};
const DEFAULT_CONFIG = {
	defaultProvider: "",
	providers: {}
};

//#endregion
//#region src/host/storage.ts
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const DATA_DIR = join(DSH_HOME, "storages", "video-kit");
const VIDEO_DIR = join(DATA_DIR, "videos");
const THUMB_DIR = join(DATA_DIR, "thumbnails");
const JOBS_FILE = join(DATA_DIR, "jobs.json");
const CONFIG_FILE = join(DATA_DIR, "config.json");
const IGNORED_IMPORTS_FILE = join(DATA_DIR, "ignored-imports.json");
async function ensureDirs() {
	await mkdir(VIDEO_DIR, { recursive: true });
	await mkdir(THUMB_DIR, { recursive: true });
}
async function readJson(file, fallback) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return fallback;
	}
}
async function writeJsonAtomic(file, value) {
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 384 });
	await rename(tmp, file);
}

//#endregion
//#region src/host/kit.ts
const POLL_TIMEOUT_MS = 2700 * 1e3;
const DEFAULT_POLL_MS = 2e3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function probe(file) {
	return new Promise((resolve) => {
		const child = spawn("ffprobe", [
			"-v",
			"error",
			"-show_entries",
			"format=duration,size,bit_rate,format_name:stream=codec_type,codec_name,width,height,r_frame_rate",
			"-of",
			"json",
			file
		], { stdio: [
			"ignore",
			"pipe",
			"ignore"
		] });
		let output = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => {
			output += chunk;
		});
		child.on("error", () => resolve(void 0));
		child.on("close", (code) => {
			if (code !== 0) return resolve(void 0);
			try {
				resolve(JSON.parse(output));
			} catch {
				resolve(void 0);
			}
		});
	});
}
function rate(value) {
	if (!value) return void 0;
	const [a, b] = value.split("/").map(Number);
	const result = b ? a / b : a;
	return Number.isFinite(result) ? result : void 0;
}
function thumbnail(source, target) {
	return new Promise((resolve) => {
		const child = spawn("ffmpeg", [
			"-loglevel",
			"error",
			"-ss",
			"1",
			"-i",
			source,
			"-frames:v",
			"1",
			"-q:v",
			"4",
			"-y",
			target
		], { stdio: "ignore" });
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
}
const TERMINAL_OK = new Set([
	"succeeded",
	"success",
	"completed",
	"complete",
	"done",
	"finished"
]);
const TERMINAL_FAIL = new Set([
	"failed",
	"failure",
	"error",
	"cancelled",
	"canceled"
]);
function normalizeStatus(raw) {
	const value = String(raw ?? "").toLowerCase();
	if (TERMINAL_OK.has(value)) return "succeeded";
	if (TERMINAL_FAIL.has(value)) return "failed";
	if (value === "queued" || value === "pending" || value === "waiting") return "pending";
	return "running";
}
function normalizeProgress(raw) {
	const value = Number(raw);
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, value > 0 && value <= 1 ? value * 100 : value));
}
function isCancelled(job) {
	return job.status === "cancelled";
}
function isSucceeded(job) {
	return job.status === "succeeded";
}
function trimBase(url) {
	return url.replace(/\/+$/, "");
}
function withId(template, id) {
	return template.includes("{id}") ? template.replaceAll("{id}", id) : `${trimBase(template)}/${id}`;
}
const SIZES = {
	"16:9": [854, 480],
	"9:16": [480, 854],
	"1:1": [640, 640]
};
function sizeFor(aspect, resolution) {
	const [width, height] = SIZES[aspect] ?? SIZES["16:9"];
	if (resolution === "720P") return aspect === "9:16" ? [720, 1280] : aspect === "1:1" ? [960, 960] : [1280, 720];
	if (resolution === "1080P") return aspect === "9:16" ? [1080, 1920] : aspect === "1:1" ? [1440, 1440] : [1920, 1080];
	return [width, height];
}
function authHeaders(config) {
	const headers = {};
	if (config.apiKey) headers[(config.apiKeyHeader || "x-api-key").toLowerCase()] = config.apiKey;
	if (config.token) headers.authorization = `Bearer ${config.token}`;
	return headers;
}
var Kit = class {
	jobs = /* @__PURE__ */ new Map();
	config = structuredClone(DEFAULT_CONFIG);
	writes = Promise.resolve();
	ignoredImports = /* @__PURE__ */ new Set();
	controllers = /* @__PURE__ */ new Map();
	importCandidates = /* @__PURE__ */ new Map();
	lastImportScanAt = 0;
	async init() {
		await ensureDirs();
		const [jobs, config] = await Promise.all([readJson(JOBS_FILE, []), readJson(CONFIG_FILE, DEFAULT_CONFIG)]);
		this.ignoredImports = new Set(await readJson(IGNORED_IMPORTS_FILE, []));
		this.config = this.mergeConfig(config);
		for (const job of Array.isArray(jobs) ? jobs : []) {
			if (!job?.id) continue;
			if (job.status === "queued" || job.status === "running") {
				job.status = "failed";
				job.error = "宿主已重启，任务中断";
				job.completedAt = Date.now();
				job.generationElapsedMs = job.startedAt ? job.completedAt - job.startedAt : void 0;
				job.updatedAt = Date.now();
			}
			this.jobs.set(job.id, job);
			if (job.fileName && basename(job.fileName) === job.fileName) {
				const file = join(VIDEO_DIR, job.fileName);
				stat(file).then(async (info) => {
					job.filePath = file;
					job.fileSize = info.size;
					job.fileMissing = false;
					if (job.actualDurationSec === void 0 || job.actualWidth === void 0 || job.actualHeight === void 0 || job.codec === void 0) await this.updateMedia(job, file);
					const thumb = join(THUMB_DIR, `${job.id}.jpg`);
					if (!await stat(thumb).catch(() => void 0) && await thumbnail(file, thumb)) job.thumbnailPath = thumb;
					this.save();
				}).catch(() => {
					job.fileMissing = true;
					this.save();
				});
			}
		}
		await this.importFiles();
		await this.save();
	}
	mergeConfig(config) {
		const providers = Object.fromEntries(Object.entries(config?.providers ?? {}).filter(([, provider]) => provider.kind === "http"));
		return {
			defaultProvider: config?.defaultProvider && providers[config.defaultProvider] ? config.defaultProvider : Object.keys(providers)[0] || "",
			providers
		};
	}
	async updateConfig(patch) {
		const config = this.mergeConfig({
			...this.config,
			...patch
		});
		await writeJsonAtomic(CONFIG_FILE, config);
		this.config = config;
		return config;
	}
	list() {
		return [...this.jobs.values()].filter((job) => job.provider !== "mock").sort((a, b) => b.createdAt - a.createdAt);
	}
	async listModels(name$1) {
		const providerName = name$1 || this.config.defaultProvider;
		const provider = this.config.providers[providerName];
		if (!provider || provider.kind !== "http" || !provider.baseUrl) return [];
		const payload = await this.requestJson(`${trimBase(provider.baseUrl)}${provider.modelsPath || "/v1/models"}`, {
			method: "GET",
			headers: authHeaders(provider)
		});
		const raw = Array.isArray(payload) ? payload : payload.models ?? payload.data ?? payload.items ?? [];
		return (Array.isArray(raw) ? raw : Object.keys(raw ?? {})).map((item) => typeof item === "string" ? { id: item } : item);
	}
	get(id) {
		return this.jobs.get(id);
	}
	async importFiles(force = false) {
		const now = Date.now();
		if (!force && now - this.lastImportScanAt < 3e3) return false;
		this.lastImportScanAt = now;
		let changed = false;
		const seen = /* @__PURE__ */ new Set();
		const known = new Set((await Promise.all([...this.jobs.values()].map(async (job) => job.fileName ? realpath(join(VIDEO_DIR, job.fileName)).catch(() => join(VIDEO_DIR, job.fileName)) : void 0))).filter(Boolean));
		for (const name$1 of await readdir(VIDEO_DIR)) {
			if (!/\.(mp4|mov|webm|m4v)$/i.test(name$1)) continue;
			const file = join(VIDEO_DIR, name$1);
			const canonical = await realpath(file).catch(() => file);
			if (this.ignoredImports.has(canonical)) continue;
			if (known.has(canonical)) continue;
			const info = await stat(file);
			if (!info.isFile() || info.size <= 0) continue;
			seen.add(canonical);
			const candidate = this.importCandidates.get(canonical);
			if (!candidate || candidate.size !== info.size || candidate.modifiedAt !== info.mtimeMs) {
				this.importCandidates.set(canonical, {
					size: info.size,
					modifiedAt: info.mtimeMs,
					firstSeenAt: now
				});
				continue;
			}
			if (now - candidate.firstSeenAt < 1e3) continue;
			const id = randomUUID();
			if (this.jobs.has(id)) continue;
			changed = true;
			this.jobs.set(id, {
				id,
				prompt: "",
				provider: "",
				source: "imported",
				status: "succeeded",
				progress: 100,
				stage: "已导入",
				durationSec: 0,
				aspect: "",
				fileName: name$1,
				filePath: file,
				fileSize: info.size,
				fileCreatedAt: info.birthtimeMs,
				createdAt: info.birthtimeMs || info.mtimeMs,
				updatedAt: info.mtimeMs
			});
			known.add(canonical);
			const job = this.jobs.get(id);
			this.updateMedia(job, file).then(async () => {
				const thumb = join(THUMB_DIR, `${id}.jpg`);
				if (await thumbnail(file, thumb)) job.thumbnailPath = thumb;
				this.save();
			});
		}
		for (const path of this.importCandidates.keys()) if (!seen.has(path)) this.importCandidates.delete(path);
		return changed;
	}
	save() {
		const snapshot = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
		this.writes = this.writes.then(() => writeJsonAtomic(JOBS_FILE, snapshot)).catch((error) => {
			console.warn("[video-kit] 保存任务失败:", error);
		});
		return this.writes;
	}
	cancel(id) {
		const job = this.jobs.get(id);
		if (!job) return false;
		if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") return false;
		this.controllers.get(id)?.abort();
		job.status = "cancelled";
		job.stage = "已取消";
		job.completedAt = Date.now();
		job.generationElapsedMs = job.startedAt ? job.completedAt - job.startedAt : void 0;
		job.updatedAt = Date.now();
		this.save();
		return true;
	}
	async rename(id, displayName) {
		const job = this.jobs.get(id);
		if (!job) return void 0;
		job.displayName = displayName.trim() || void 0;
		job.updatedAt = Date.now();
		this.save();
		return job;
	}
	async favorite(id, favorite) {
		const job = this.jobs.get(id);
		if (!job) return void 0;
		job.favorite = favorite;
		job.updatedAt = Date.now();
		await this.save();
		return job;
	}
	async delete(id) {
		const job = this.jobs.get(id);
		if (!job || ["queued", "running"].includes(job.status)) return false;
		if (job.fileName) {
			if (basename(job.fileName) !== job.fileName) throw new Error("无效的视频文件名");
			await unlink(join(VIDEO_DIR, job.fileName)).catch((error) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
		this.jobs.delete(id);
		await unlink(join(THUMB_DIR, `${job.id}.jpg`)).catch(() => void 0);
		await this.save();
		return true;
	}
	async updateMedia(job, file) {
		const info = await stat(file).catch(() => void 0);
		if (!info) return;
		const metadata = await probe(file);
		const video = metadata?.streams?.find((stream) => stream.codec_type === "video");
		job.filePath = file;
		job.fileMissing = false;
		job.fileSize = info.size;
		job.fileCreatedAt = info.birthtimeMs;
		job.actualDurationSec = Number(metadata?.format?.duration) || void 0;
		job.actualWidth = Number(video?.width) || void 0;
		job.actualHeight = Number(video?.height) || void 0;
		job.actualFps = rate(video?.r_frame_rate);
		job.codec = video?.codec_name;
		job.bitrate = Number(metadata?.format?.bit_rate) || void 0;
		job.container = metadata?.format?.format_name;
		await this.save();
	}
	async generate(input) {
		const prompt = input.prompt;
		if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prompt 必须是非空的用户原文");
		const providerName = input.provider || this.config.defaultProvider;
		const provider = this.config.providers[providerName];
		if (!provider) throw new Error(`未配置的视频服务: ${providerName}`);
		if (!provider.baseUrl) throw new Error(`视频服务 ${providerName} 缺少 baseUrl`);
		const now = Date.now();
		const aspect = input.aspect || "16:9";
		const resolution = input.resolution || "480P";
		const [width, height] = sizeFor(aspect, resolution);
		const job = {
			id: randomUUID(),
			prompt,
			promptVerbatim: true,
			provider: providerName,
			source: input.source || "panel",
			model: provider.model,
			negativePrompt: input.negativePrompt,
			status: "queued",
			progress: 0,
			stage: "排队中",
			durationSec: Math.max(1, Math.min(30, Number(input.durationSec) || 5)),
			aspect,
			resolution,
			requestedWidth: Number(input.width) || width,
			requestedHeight: Number(input.height) || height,
			frames: input.frames,
			fps: input.fps != null && Number.isFinite(Number(input.fps)) ? Number(input.fps) : 24,
			steps: input.steps != null && Number.isFinite(Number(input.steps)) ? Number(input.steps) : 20,
			seed: input.seed != null && Number.isFinite(Number(input.seed)) ? Number(input.seed) : -1,
			initImage: input.initImage,
			createdAt: now,
			startedAt: now,
			updatedAt: now
		};
		this.jobs.set(job.id, job);
		await this.save();
		this.run(job, provider);
		return job;
	}
	async run(job, provider) {
		job.status = "running";
		job.stage = "启动中";
		job.updatedAt = Date.now();
		this.save();
		try {
			await this.runHttp(job, provider);
		} catch (error) {
			if (isCancelled(job)) return;
			job.status = "failed";
			job.error = error instanceof Error ? error.message : String(error);
			job.stage = "失败";
		} finally {
			job.updatedAt = Date.now();
			job.completedAt = job.status === "running" ? void 0 : job.updatedAt;
			job.generationElapsedMs = job.completedAt && job.startedAt ? job.completedAt - job.startedAt : void 0;
			this.controllers.delete(job.id);
			if (isSucceeded(job)) job.progress = 100;
			this.save();
		}
	}
	async runHttp(job, provider) {
		const base = trimBase(provider.baseUrl);
		const controller = new AbortController();
		this.controllers.set(job.id, controller);
		const headers = {
			"content-type": "application/json",
			...authHeaders(provider)
		};
		const requestBody = JSON.stringify({
			model: job.model || void 0,
			prompt: job.prompt,
			voice_text: "",
			negative_prompt: job.negativePrompt || void 0,
			width: job.requestedWidth,
			height: job.requestedHeight,
			duration: job.durationSec,
			frames: job.frames || void 0,
			fps: job.fps || void 0,
			steps: job.steps || void 0,
			seed: job.seed ?? void 0,
			init_image: job.initImage || void 0
		});
		const submitted = await this.requestJson(`${base}${provider.submitPath || "/v1/videos"}`, {
			method: "POST",
			headers,
			signal: controller.signal,
			body: requestBody
		});
		const { init_image, ...request } = JSON.parse(requestBody);
		job.submission = {
			...request,
			initImageLength: typeof init_image === "string" ? init_image.length : 0,
			initImageSha256: typeof init_image === "string" ? createHash("sha256").update(Buffer.from(init_image, "base64")).digest("hex") : void 0,
			voiceInferred: typeof (submitted.voice_inferred ?? submitted.data?.voice_inferred) === "boolean" ? submitted.voice_inferred ?? submitted.data?.voice_inferred : void 0
		};
		const remoteId = String(submitted.task_id ?? submitted.id ?? submitted.tid ?? submitted.data?.id ?? "");
		if (!remoteId) throw new Error(`视频服务未返回任务 id: ${JSON.stringify(submitted).slice(0, 200)}`);
		job.remoteId = remoteId;
		job.stage = "已提交";
		job.progress = Math.max(job.progress, 5);
		this.save();
		const statusUrl = withId(`${base}${provider.statusPath || "/v1/videos/{id}"}`, remoteId);
		const interval = provider.pollIntervalMs && provider.pollIntervalMs > 0 ? provider.pollIntervalMs : DEFAULT_POLL_MS;
		const deadline = Date.now() + POLL_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (isCancelled(job)) return;
			await sleep(interval);
			if (isCancelled(job)) return;
			const payload = await this.requestJson(statusUrl, {
				method: "GET",
				headers,
				signal: controller.signal
			});
			const body = payload.data && typeof payload.data === "object" ? {
				...payload,
				...payload.data
			} : payload;
			const status = normalizeStatus(body.status ?? body.state);
			job.progress = Math.max(job.progress, normalizeProgress(body.progress ?? body.percentage));
			job.stage = String(body.stage ?? body.message ?? job.stage ?? "");
			job.updatedAt = Date.now();
			this.save();
			if (status === "failed") throw new Error(String(body.error ?? body.message ?? "视频服务返回失败"));
			if (status === "succeeded") {
				const listed = [
					body.outputs,
					body.videos,
					body.result?.outputs,
					body.data?.outputs
				].find(Array.isArray);
				const outputs = (listed?.length ? listed : [body]).map((output) => String(output?.download_url ?? output?.video_url ?? output?.url ?? output?.file ?? ""));
				if (outputs.length === 1 && !outputs[0]) outputs[0] = `v1/videos/${remoteId}/file`;
				const failures = [];
				for (const [index, url] of outputs.entries()) {
					const outputJob = index === 0 ? job : {
						...job,
						id: randomUUID(),
						fileName: void 0,
						filePath: void 0,
						thumbnailPath: void 0,
						fileSize: void 0,
						actualWidth: void 0,
						actualHeight: void 0,
						actualDurationSec: void 0,
						actualFps: void 0,
						codec: void 0,
						bitrate: void 0,
						container: void 0,
						status: "running",
						progress: job.progress,
						stage: "下载中"
					};
					if (index > 0) this.jobs.set(outputJob.id, outputJob);
					if (!url) {
						outputJob.status = "failed";
						outputJob.error = "任务成功但未返回视频地址";
						failures.push(outputJob.error);
						continue;
					}
					outputJob.remoteUrl = url;
					const absolute = /^https?:\/\//i.test(url) ? url : `${base}/${url.replace(/^\/+/, "")}`;
					const fileName = `${outputJob.id}.mp4`;
					const destination = join(VIDEO_DIR, fileName);
					const partial = `${destination}.${randomUUID()}.part`;
					try {
						await this.download(absolute, partial, controller.signal, headers);
						if (!(await stat(partial)).size) throw new Error("下载的视频文件为空");
						await rename(partial, destination);
						outputJob.fileName = fileName;
						await this.updateMedia(outputJob, destination);
						const thumb = join(THUMB_DIR, `${outputJob.id}.jpg`);
						if (await thumbnail(destination, thumb)) outputJob.thumbnailPath = thumb;
						outputJob.status = "succeeded";
						outputJob.stage = "完成";
						outputJob.progress = 100;
						outputJob.completedAt = Date.now();
						outputJob.generationElapsedMs = outputJob.startedAt ? outputJob.completedAt - outputJob.startedAt : void 0;
						outputJob.updatedAt = outputJob.completedAt;
						this.save();
					} catch (error) {
						await unlink(partial).catch(() => void 0);
						outputJob.status = "failed";
						outputJob.error = error instanceof Error ? error.message : String(error);
						outputJob.stage = "失败";
						failures.push(outputJob.error);
						this.save();
					}
				}
				if (!outputs.length || failures.length === outputs.length) throw new Error(failures.join("；") || "任务成功但未返回视频地址");
				return;
			}
		}
		throw new Error("等待视频服务超时");
	}
	async requestJson(url, init) {
		const response = await fetch(url, init);
		const text = await response.text();
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
		if (!text) return {};
		try {
			return JSON.parse(text);
		} catch {
			throw new Error(`视频服务返回了非 JSON 内容: ${text.slice(0, 200)}`);
		}
	}
	async download(url, dest, signal, headers = {}) {
		const { "content-type": _omit, ...rest } = headers;
		const response = await fetch(url, {
			signal,
			headers: rest
		});
		if (!response.ok || !response.body) throw new Error(`下载视频失败 HTTP ${response.status}`);
		await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
	}
};

//#endregion
//#region src/host/server.ts
function publicConfig(config) {
	return {
		...config,
		providers: Object.fromEntries(Object.entries(config.providers).map(([name$1, provider]) => {
			const { token, apiKey, ...rest } = provider;
			return [name$1, {
				...rest,
				hasToken: Boolean(token),
				hasApiKey: Boolean(apiKey)
			}];
		}))
	};
}
function sendJson(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(value));
}
async function readBody(req, limit = 1024 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new Error("请求体过大");
		chunks.push(chunk);
	}
	if (!chunks.length) return {};
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text.trim()) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("请求体不是合法 JSON");
	}
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function createHandler(kit) {
	return async function handleRequest(req, res) {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		if (!url.pathname.startsWith(ROUTE_PREFIX)) {
			sendJson(res, 404, {
				ok: false,
				error: "not found"
			});
			return;
		}
		const route = url.pathname.slice(ROUTE_PREFIX.length) || "/";
		const method = (req.method || "GET").toUpperCase();
		try {
			if (method === "GET" && route === "/health") {
				sendJson(res, 200, {
					ok: true,
					plugin: "dsh-video-kit",
					defaultProvider: kit.config.defaultProvider
				});
				return;
			}
			if (method === "GET" && route === "/jobs") {
				if (await kit.importFiles()) await kit.save();
				const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
				const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 24));
				const query = (url.searchParams.get("q") || "").trim().toLocaleLowerCase();
				const status = url.searchParams.get("status") || "all";
				const sort = url.searchParams.get("sort") || "date";
				const filtered = kit.list().filter((job) => (status === "all" || (status === "favorite" ? job.favorite : status === "active" ? ["queued", "running"].includes(job.status) : job.status === status)) && (!query || `${job.prompt} ${job.model} ${job.fileName} ${job.provider}`.toLocaleLowerCase().includes(query)));
				filtered.sort((a, b) => sort === "model" ? (a.model || "").localeCompare(b.model || "") || b.createdAt - a.createdAt : sort === "duration" ? (b.actualDurationSec || b.durationSec) - (a.actualDurationSec || a.durationSec) : b.createdAt - a.createdAt);
				const jobs = filtered.slice(offset, offset + limit).map(({ initImage, ...job }) => job);
				sendJson(res, 200, {
					ok: true,
					jobs,
					total: filtered.length,
					hasMore: offset + jobs.length < filtered.length
				});
				return;
			}
			if (method === "POST" && route === "/jobs") {
				const body = await readBody(req, 20 * 1024 * 1024);
				sendJson(res, 200, {
					ok: true,
					job: await kit.generate(body)
				});
				return;
			}
			if (route.startsWith("/jobs/")) {
				const rest = decodeURIComponent(route.slice(6));
				if (method === "POST" && rest.endsWith("/cancel")) {
					const id = rest.slice(0, -7);
					sendJson(res, 200, {
						ok: kit.cancel(id),
						job: kit.get(id) ?? null
					});
					return;
				}
				if (method === "GET") {
					const job = kit.get(rest);
					if (!job) {
						sendJson(res, 404, {
							ok: false,
							error: "任务不存在"
						});
						return;
					}
					sendJson(res, 200, {
						ok: true,
						job
					});
					return;
				}
				if (method === "PATCH") {
					const id = rest;
					const body = await readBody(req);
					const job = body.favorite === void 0 ? await kit.rename(id, String(body.displayName ?? "")) : await kit.favorite(id, Boolean(body.favorite));
					sendJson(res, job ? 200 : 404, job ? {
						ok: true,
						job
					} : {
						ok: false,
						error: "任务不存在"
					});
					return;
				}
				if (method === "DELETE") {
					const removed = await kit.delete(rest);
					sendJson(res, removed ? 200 : 404, { ok: removed });
					return;
				}
			}
			if (method === "GET" && route === "/models") {
				sendJson(res, 200, {
					ok: true,
					models: await kit.listModels(url.searchParams.get("provider") || void 0).catch(() => [])
				});
				return;
			}
			if (method === "GET" && route === "/config") {
				sendJson(res, 200, {
					ok: true,
					config: publicConfig(kit.config)
				});
				return;
			}
			if ((method === "PUT" || method === "POST") && route === "/config") {
				const body = await readBody(req);
				const providers = Object.fromEntries(Object.entries(body.providers ?? {}).map(([name$1, value]) => {
					const previous = kit.config.providers[name$1];
					return [name$1, {
						...value,
						token: value.token === null ? void 0 : value.token || previous?.token,
						apiKey: value.apiKey === null ? void 0 : value.apiKey || previous?.apiKey
					}];
				}));
				sendJson(res, 200, {
					ok: true,
					config: publicConfig(await kit.updateConfig({
						...body,
						providers
					}))
				});
				return;
			}
			if (method === "POST" && route === "/open-folder") {
				spawn(process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open", [VIDEO_DIR], {
					detached: true,
					stdio: "ignore"
				}).unref();
				sendJson(res, 200, {
					ok: true,
					dir: VIDEO_DIR
				});
				return;
			}
			if (method === "POST" && route === "/open-file-location") {
				const body = await readBody(req);
				const job = kit.get(String(body.id ?? ""));
				if (!job?.fileName) {
					sendJson(res, 404, {
						ok: false,
						error: "视频文件不存在"
					});
					return;
				}
				if (basename(job.fileName) !== job.fileName) {
					sendJson(res, 400, {
						ok: false,
						error: "无效的视频文件名"
					});
					return;
				}
				const file = join(VIDEO_DIR, job.fileName);
				if (!await stat(file).catch(() => void 0)) {
					sendJson(res, 404, {
						ok: false,
						error: "视频文件已被删除"
					});
					return;
				}
				spawn(process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open", process.platform === "win32" ? ["/select,", file] : process.platform === "darwin" ? ["-R", file] : [VIDEO_DIR], {
					detached: true,
					stdio: "ignore"
				}).unref();
				sendJson(res, 200, { ok: true });
				return;
			}
			if (method === "GET" && route.startsWith("/thumbnail/")) {
				const id = decodeURIComponent(route.slice(11));
				const path = kit.get(id)?.thumbnailPath;
				const file = path === join(THUMB_DIR, `${id}.jpg`) ? path : void 0;
				if (!file) {
					sendJson(res, 404, {
						ok: false,
						error: "封面不存在"
					});
					return;
				}
				const info = await stat(file).catch(() => void 0);
				if (!info) {
					sendJson(res, 404, {
						ok: false,
						error: "封面不存在"
					});
					return;
				}
				res.writeHead(200, {
					"content-type": "image/jpeg",
					"content-length": info.size,
					"cache-control": "public, max-age=31536000, immutable"
				});
				createReadStream(file).pipe(res);
				return;
			}
			if (method === "GET" && route.startsWith("/file/")) {
				const name$1 = decodeURIComponent(route.slice(6));
				const job = [...kit.jobs.values()].find((item) => item.fileName === name$1 || item.id === name$1.replace(/\.mp4$/, ""));
				if (!job?.fileName) {
					sendJson(res, 404, {
						ok: false,
						error: "视频文件不存在"
					});
					return;
				}
				if (basename(job.fileName) !== job.fileName) {
					sendJson(res, 400, {
						ok: false,
						error: "无效的视频文件名"
					});
					return;
				}
				const file = join(VIDEO_DIR, job.fileName);
				const info = await stat(file).catch(() => void 0);
				if (!info) {
					sendJson(res, 404, {
						ok: false,
						error: "视频文件已被删除"
					});
					return;
				}
				const range = req.headers.range;
				const type = {
					".mp4": "video/mp4",
					".m4v": "video/mp4",
					".mov": "video/quicktime",
					".webm": "video/webm"
				}[extname(job.fileName).toLowerCase()] || "application/octet-stream";
				if (range) {
					const match = /bytes=(\d*)-(\d*)/.exec(range);
					const start = match?.[1] ? Number(match[1]) : 0;
					const end = match?.[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
					if (start >= info.size || start > end) {
						res.writeHead(416, { "content-range": `bytes */${info.size}` });
						res.end();
						return;
					}
					res.writeHead(206, {
						"content-type": type,
						"content-length": end - start + 1,
						"content-range": `bytes ${start}-${end}/${info.size}`,
						"accept-ranges": "bytes",
						"cache-control": "public, max-age=31536000, immutable"
					});
					createReadStream(file, {
						start,
						end
					}).pipe(res);
					return;
				}
				res.writeHead(200, {
					"content-type": type,
					"content-length": info.size,
					"accept-ranges": "bytes",
					"cache-control": "public, max-age=31536000, immutable"
				});
				createReadStream(file).pipe(res);
				return;
			}
			sendJson(res, 404, {
				ok: false,
				error: "not found"
			});
		} catch (error) {
			sendJson(res, 500, {
				ok: false,
				error: errorMessage(error)
			});
		}
	};
}

//#endregion
//#region src/host/tools.ts
const textBlock = (text) => [{
	type: "text",
	text
}];
const jobSchema = {
	type: "object",
	additionalProperties: true,
	properties: {
		id: { type: "string" },
		prompt: { type: "string" },
		status: { type: "string" },
		progress: { type: "number" },
		stage: { type: "string" },
		provider: { type: "string" },
		model: { type: "string" },
		source: { type: "string" },
		negativePrompt: { type: "string" },
		durationSec: { type: "number" },
		aspect: { type: "string" },
		resolution: { type: "string" },
		requestedWidth: { type: "number" },
		requestedHeight: { type: "number" },
		fps: { type: "number" },
		steps: { type: "number" },
		seed: { type: "number" },
		frames: { type: "number" },
		fileName: { type: "string" },
		error: { type: "string" }
	}
};
function jobView(job) {
	return {
		...job,
		fileUrl: job.fileName ? `/api/video-kit/file/${job.fileName}` : void 0
	};
}
function generateTool(kit) {
	return {
		name: TOOL_NAMES.generate,
		description: "Generate a short video from the exact original user message, without rewriting, summarizing, translating, extracting dialogue, or trimming any characters. Submits the job to the configured video provider (a local model server on the LAN or a cloud HTTP API) and returns immediately with a job id. Before generation, require the user to specify or explicitly accept defaults for aspect ratio, duration, and resolution. If any are missing, call this tool without filling them in; it returns needsParameters and must not create a task. Ask the user to confirm the listed video settings, then call again with the confirmed values. Mention that FPS defaults to 24, steps to 20, and seed to automatic unless the user wants to change them. Use video_status to poll progress and video_list to browse recent jobs. This is the only supported Agent video generation path: do not generate videos through another tool or API, because those requests cannot be linked to persistent video history. When the user asks for a video, call this instead of describing how to make one.",
		parameters: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description: "Copy the complete original user message verbatim, including dialogue, punctuation, quotes, whitespace and line breaks. Never optimize it. The local video API handles interpretation."
				},
				userMessageId: {
					type: "string",
					description: "Optional original human message ID. Use this to select the original generation request after a parameter-confirmation turn. The host reads its text directly; model-written prompt cannot override it. If validation returns candidateMessages, select the relevant original message ID."
				},
				provider: {
					type: "string",
					description: "Optional provider name from the plugin settings. Defaults to the configured default provider."
				},
				durationSec: {
					type: "number",
					description: "User-confirmed clip length in seconds, 1-30."
				},
				aspect: {
					type: "string",
					enum: [
						"16:9",
						"9:16",
						"1:1"
					],
					description: "User-confirmed aspect ratio."
				},
				resolution: {
					type: "string",
					enum: [
						"480P",
						"720P",
						"1080P"
					],
					description: "User-confirmed output resolution tier."
				},
				width: {
					type: "number",
					description: "Explicit output width, when specified."
				},
				height: {
					type: "number",
					description: "Explicit output height, when specified."
				},
				negativePrompt: {
					type: "string",
					description: "What to avoid in the video."
				},
				steps: {
					type: "number",
					description: "Sampling steps. Defaults to the server default (20)."
				},
				seed: {
					type: "number",
					description: "Random seed; -1 for random."
				},
				frames: {
					type: "number",
					description: "Frame count when using frame-based duration."
				},
				fps: {
					type: "number",
					description: "Frame rate, default 24."
				},
				initImage: {
					type: "string",
					description: "Base64 first-frame image for image-to-video."
				}
			},
			required: ["prompt"]
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: { type: "boolean" },
					needsParameters: {
						type: "array",
						items: { type: "string" }
					},
					promptMessage: { type: "string" },
					job: jobSchema,
					error: { type: "string" }
				},
				required: ["ok"]
			},
			render: (_args, value) => textBlock(JSON.stringify(value))
		},
		async execute(args, exec) {
			try {
				const messages = (exec?.agent?.session?.snapshotEvents?.() ?? []).filter((event) => event.type === "user/message" && event.data.source?.kind === "user").map((event) => ({
					id: event.data.id,
					prompt: event.data.content.filter((block) => block.type === "text").map((block) => block.text).join("")
				}));
				const original = messages.findLast((message) => args?.userMessageId ? message.id === args.userMessageId : message.prompt === args?.prompt);
				if (!original) return {
					ok: false,
					needsParameters: ["userMessageId"],
					error: "无法核对用户原文，本次未提交。请选择原始视频请求的 userMessageId，或逐字传入该条用户消息作为 prompt；不得改写、总结或提取台词。若无法确定原始消息，请用户补充。",
					candidateMessages: messages.slice(-5)
				};
				const needsParameters = [
					args?.aspect == null ? "aspect" : void 0,
					args?.durationSec == null ? "durationSec" : void 0,
					args?.resolution == null ? "resolution" : void 0
				].filter(Boolean);
				if (needsParameters.length) {
					const labels = {
						aspect: "画面比例（横屏 16:9、竖屏 9:16、方形 1:1）",
						durationSec: "输出时长（1–30 秒）",
						resolution: "分辨率（480P、720P、1080P）"
					};
					return {
						ok: true,
						needsParameters,
						promptMessage: `开始生成前请询问用户补充${needsParameters.map((key) => labels[key]).join("、")}，或明确接受建议默认值（16:9、5 秒、480P）。帧率默认 24 FPS、步数默认 20、随机种子自动。请等待用户回复后再生成；本次没有创建任务。`
					};
				}
				return {
					ok: true,
					job: jobView(await kit.generate({
						source: "agent",
						prompt: original.prompt,
						provider: args?.provider ? String(args.provider) : void 0,
						durationSec: args?.durationSec,
						aspect: args?.aspect,
						resolution: args?.resolution,
						width: args?.width,
						height: args?.height,
						negativePrompt: args?.negativePrompt,
						steps: args?.steps,
						seed: args?.seed,
						frames: args?.frames,
						fps: args?.fps,
						initImage: args?.initImage
					})),
					hint: "任务已提交，用 video_status 查询进度"
				};
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
	};
}
function statusTool(kit) {
	return {
		name: TOOL_NAMES.status,
		description: "Check one video generation job by id, including status, progress, stage and error.",
		parameters: {
			type: "object",
			properties: { jobId: {
				type: "string",
				description: "Job id returned by video_generate or video_list."
			} },
			required: ["jobId"]
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: { type: "boolean" },
					job: jobSchema,
					error: { type: "string" }
				},
				required: ["ok"]
			},
			render: (_args, value) => textBlock(JSON.stringify(value))
		},
		async execute(args) {
			const job = kit.get(String(args?.jobId ?? ""));
			if (!job) return {
				ok: false,
				error: "任务不存在"
			};
			return {
				ok: true,
				job: jobView(job)
			};
		}
	};
}
function listTool(kit) {
	return {
		name: TOOL_NAMES.list,
		description: "List recent video generation jobs, newest first.",
		parameters: {
			type: "object",
			properties: { limit: {
				type: "number",
				description: "How many jobs to return, default 10, max 50."
			} }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: { type: "boolean" },
					jobs: {
						type: "array",
						items: jobSchema
					}
				},
				required: ["ok"]
			},
			render: (_args, value) => textBlock(JSON.stringify(value))
		},
		async execute(args) {
			const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10));
			return {
				ok: true,
				jobs: kit.list().slice(0, limit).map(jobView)
			};
		}
	};
}
function cancelTool(kit) {
	return {
		name: TOOL_NAMES.cancel,
		description: "Cancel a running video generation job.",
		parameters: {
			type: "object",
			properties: { jobId: {
				type: "string",
				description: "Job id to cancel."
			} },
			required: ["jobId"]
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: { type: "boolean" },
					error: { type: "string" }
				},
				required: ["ok"]
			},
			render: (_args, value) => textBlock(JSON.stringify(value))
		},
		async execute(args) {
			const id = String(args?.jobId ?? "");
			if (!kit.get(id)) return {
				ok: false,
				error: "任务不存在"
			};
			return { ok: kit.cancel(id) };
		}
	};
}
function createTools(kit) {
	return [
		generateTool(kit),
		statusTool(kit),
		listTool(kit),
		cancelTool(kit)
	];
}

//#endregion
//#region src/index.ts
const name = PLUGIN_ID;
const inject = [
	"tools",
	"webServer",
	"systemPrompt",
	"agentPresets"
];
async function apply(ctx) {
	const kit = new Kit();
	await kit.init();
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "prefix",
			path: ROUTE_PREFIX,
			handler: createHandler(kit)
		});
		return () => dispose();
	}, `${PLUGIN_ID}: routes`);
	ctx.systemPrompt.section({
		name: `${PLUGIN_ID}:agent-video-generation`,
		order: ctx.systemPrompt.getSectionOrder("TOOL_GOAL"),
		text: "视频生成必须统一调用 video_generate，由视频插件提交模型请求并持久化提示词、模型与全部请求参数。prompt 必须是用户原始消息全文，逐字保留台词、标点、引号、空白和换行；禁止先用大模型改写、优化、翻译或总结，禁止拆分画面与语音或提取 voice_text。视频 API 服务统一负责后续解析。参数确认后应选择最初视频请求的 userMessageId，不能把确认回复或改写描述当作原文。工具返回 candidateMessages 时选择对应原始消息，无法确定时询问用户。重试同样使用原始用户消息。不得绕过该工具通过终端、代码、HTTP 或其他工具直接生成视频，也不得把这种结果当作插件任务。参数缺失时先询问用户并等待确认；任务完成后再依据 video_status 的真实状态回复。"
	});
	for (const tool of createTools(kit)) ctx.tools.register(tool);
	const disposeChat = await ctx.agentPresets.register({
		id: "chat",
		name: "聊天模式",
		description: "日常对话；需要时搜索网页。",
		order: 0,
		plugins: [
			{
				id: "persona",
				name: "@deepseek-ai/dsh-persona",
				config: {
					prefix: "你是一个友善、准确的对话助手。根据用户的问题自然回答；需要最新信息时可以搜索网页并引用来源。",
					complete: true,
					includeRuntimeContext: false
				}
			},
			{
				id: "tool-web",
				name: "@deepseek-ai/dsh-tool-web",
				config: {
					search: true,
					fetch: false,
					searchTimeoutMs: 6e4
				}
			},
			{
				id: "tool-presentation",
				name: "@deepseek-ai/dsh-agent-tool-presentation",
				config: { mode: "native" }
			},
			{
				id: "chat-policy",
				name: "dsh-video-kit/chat-policy"
			}
		]
	});
	ctx.effect(() => () => disposeChat(), `${PLUGIN_ID}: chat preset`);
}

//#endregion
export { apply, inject, name };