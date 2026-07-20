# Novel TXT Downloader

一个用于把网页小说整理成 TXT 的小工具。页面可以读取小说目录页，批量下载章节正文，清理目录残留、翻页导航、重复标题等噪音，然后组装成适合导入手机阅读器或 Kindle 的纯文本文件。

当前默认书源是 [飘天文学](https://www.piaotia.com/)，并带有若干备用适配：

- 飘天文学：默认书源，支持目录页和书名搜索。
- 笔趣阁 biqu33：支持目录页，并能沿章节页的“上一章”链回溯补齐历史章节。
- 中文维基文库：支持书名搜索。
- 纵横中文网：支持书名搜索和目录页。
- 晋江、青空文库、通用 HTML：支持直接粘贴目录页。

> 请只下载你有权保存和阅读的内容，并遵守目标网站的服务条款。

## 本地运行

需要 Node.js `>=22.13.0`。

```bash
pnpm install
pnpm run dev
```

常用校验命令：

```bash
pnpm run build
pnpm run lint
```

## 部署到 GitHub + Cloudflare

这个应用包含服务端 API，用来抓取和解析章节正文，因此不能作为纯静态 GitHub Pages 站点完整运行。推荐把源码托管在 GitHub，并通过 GitHub Actions 部署到 Cloudflare Workers/Pages。

仓库已包含 `.github/workflows/deploy-cloudflare.yml`。在 GitHub 仓库 Settings -> Secrets and variables -> Actions 中添加：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

然后推送到 `main` 或 `master`，或者在 Actions 页面手动运行 `Deploy to Cloudflare` 工作流。

## 项目结构

- `app/page.tsx`：前端页面和下载流程。
- `app/api/novel/route.ts`：书源识别、目录解析、章节正文提取和后处理。
- `app/globals.css`：页面样式。
- `tests/`：渲染和基础行为测试。

## 已发布站点

当前 Sites 版本仍可通过这个地址访问：

https://shiye-novel-txt.open-joy-7839.chatgpt.site/
