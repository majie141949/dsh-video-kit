# dsh-video-kit

DeepSeek Harness 的视频生成插件：给 Agent 提供视频工具、在侧栏提供视频面板，并把结果插回会话。既支持局域网里的本地模型服务，也支持云端 HTTP 视频接口。

## 安装

在线安装（推荐），已发布到 npm，走国内镜像也快：

```sh
dsh plugin --profile <profile> add @majie141949/dsh-video-kit
```

桌面版由应用独占管理插件，命令行安装不生效，在「插件扩展 → 添加插件」的输入框里填 `@majie141949/dsh-video-kit`，安装源选「中国大镜像源」。国内网络可先执行 `npm config set registry https://registry.npmmirror.com`。

也可以从 GitHub 装（国内可能较慢）：

```sh
dsh plugin --profile <profile> add github:majie141949/dsh-video-kit
```

装好后插件按 npm 版本检查更新，作者发布新版本后应用里会出现「升级」。

需要支持 bundle 与 client 插件的 DeepSeek Harness，最低声明版本 `0.2.1-rc.1`。面板依赖 `dsh-tauri`、`dsh-tauri-ui` 两个客户端包，桌面端自带；纯命令行环境只能用到 Agent 工具部分。

## 配置

面板「设置 → 模型 → 视频模型」里新增一个模型：填名称、API 地址、模型 ID、认证方式（Bearer Token 或 API Key 请求头）和密钥。接口需兼容 `/v1/videos` 异步提交与轮询，提交路径、状态查询路径可自定义，默认 `/v1/videos` 与 `/v1/videos/{id}`。

密钥只落本地配置，不会写进提示词或日志，也不会随仓库分发。

## 使用

面板里直接填提示词、比例、分辨率、时长、步数、种子和首帧参考图生成；生成记录支持收藏、重命名、搜索、再次生成、删除和打开文件位置。Agent 侧通过 `video_generate`、`video_status`、`video_list`、`video_cancel` 提交与查询任务，提交的是用户原文，不做改写。

## 开发

```sh
pnpm install
pnpm build     # tsdown，产物写入 dist
pnpm vitest run
```

仓库里同时提交了 `dist`，装包不需要构建。

## 许可

MIT，见 `LICENSE`。
