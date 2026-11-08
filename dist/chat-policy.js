//#region src/chat-policy.ts
const name = "video-kit-chat-policy";
const inject = ["tools", "systemPrompt"];
function apply(ctx) {
	ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
		const assembly = await next();
		return {
			...assembly,
			tools: assembly.tools.filter((tool) => tool.name === "web_search")
		};
	});
	ctx.tools.guard((execution) => execution.name === "web_search" ? void 0 : "聊天模式只允许网页搜索。");
}

//#endregion
export { apply, inject, name };