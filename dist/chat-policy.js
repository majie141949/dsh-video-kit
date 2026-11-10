//#region src/chat-policy.ts
const name = "video-kit-chat-policy";
const inject = ["tools"];
function apply(ctx) {
	ctx.tools.restrict({ allow: [] });
	ctx.tools.guard((execution) => execution.name === "web_search" ? void 0 : "聊天模式只允许网页搜索。");
}

//#endregion
export { apply, inject, name };