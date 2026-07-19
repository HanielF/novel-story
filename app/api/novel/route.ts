import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

function cleanText(value: string) {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>|<\/br\s*>/gi, "\n").replace(/<\/(?:p|div|h1|h2|h3|li|section|article)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

function normalizeTitle(value: string) {
  return cleanText(value).replace(/[\s【】〖〗《》]/g, "").toLowerCase();
}

function postProcessChapter(value: string, expectedTitle = "") {
  let lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  const titleKey = normalizeTitle(expectedTitle);
  if (titleKey) {
    let lastTitleIndex = -1;
    for (let index = 0; index < lines.length; index += 1) {
      if (normalizeTitle(lines[index]) === titleKey) lastTitleIndex = index;
    }
    if (lastTitleIndex >= 0) lines = lines.slice(lastTitleIndex + 1);
  }
  lines = lines.filter((line) => {
    const compact = line.replace(/\s+/g, "");
    if (!compact || /^[()（）]+$/.test(compact)) return false;
    if (titleKey && normalizeTitle(line) === titleKey) return false;
    if (/(快捷键|上一章|下一章|返回目录|返回书页|章节列表|加入书签|投推荐票|错误举报)/.test(compact)) return false;
    if (/(飘天文学|PT文学|Copyright|本站域名|请记住本站|最新网址|手机阅读|加入收藏)/i.test(compact)) return false;
    return true;
  });
  return lines.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function validateUrl(raw: unknown) {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("链接无效");
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol)) throw new Error("只支持 http 或 https 链接");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || /^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error("不支持内部网络地址");
  return url;
}

async function fetchHtml(url: URL) {
  const directoryUrl = new URL(url.href);
  if (/\.html?$/i.test(directoryUrl.pathname)) directoryUrl.pathname = directoryUrl.pathname.replace(/[^/]+$/, "");
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
      referer: directoryUrl.href,
      "cache-control": "no-cache",
    },
  });
  if (!response.ok) throw new Error(`目标网站返回 ${response.status}`);
  const bytes = await response.arrayBuffer();
  const probe = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(probe)?.[1]?.toLowerCase() || "utf-8";
  let html: string;
  try { html = new TextDecoder(charset === "gb2312" ? "gb18030" : charset).decode(bytes); }
  catch { html = new TextDecoder("utf-8").decode(bytes); }
  if (/Attention Required|cf-error-details|captcha|验证码/i.test(html)) throw new Error("目标网站要求浏览器验证，暂时无法自动读取。请稍后重试，或更换可公开访问的来源。");
  return html;
}

function extractBalancedElement(html: string, openPattern: RegExp) {
  const open = openPattern.exec(html);
  if (!open || open.index === undefined) return "";
  const start = open.index + open[0].length;
  const tagPattern = /<\/?div\b[^>]*>/gi;
  tagPattern.lastIndex = start;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html))) {
    if (/^<\/div/i.test(match[0])) depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(start, match.index);
  }
  return html.slice(start);
}

function parseIndex(html: string, base: URL) {
  const title = cleanText(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "未命名小说").replace(/最新章节.*|全文阅读.*|_.*$/, "").trim();
  const bodyText = cleanText(html.slice(0, Math.min(html.length, 120000)));
  const author = /作者[：:\s]+([^\s|/]{2,24})/.exec(bodyText)?.[1] || "";
  const seen = new Set<string>();
  const chapters: { title: string; url: string }[] = [];
  const linkRe = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(linkRe)) {
    const text = cleanText(match[2]);
    if (!text || text.length > 100 || !/(第.{0,12}[章节卷回部篇]|序章|楔子|番外|正文)/.test(text)) continue;
    try {
      const href = new URL(match[1], base);
      if (!/^https?:$/.test(href.protocol) || href.hostname !== base.hostname || seen.has(href.href)) continue;
      seen.add(href.href); chapters.push({ title: text, url: href.href });
    } catch { /* ignore malformed links */ }
  }
  if (!chapters.length) throw new Error("没有识别到章节。请确认这是包含完整章节列表的目录页。");
  return { title, author, chapters };
}

function parseChapter(html: string, expectedTitle = "") {
  const candidates = [
    extractBalancedElement(html, /<div\b[^>]*\bid=["'](?:content|contents|chaptercontent)["'][^>]*>/i),
    extractBalancedElement(html, /<div\b[^>]*\bclass=["'][^"']*(?:showtxt|chapter-content|read-content|readcontent|nr_nr)[^"']*["'][^>]*>/i),
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] || "",
  ];
  let content = "";
  for (const value of candidates) { const cleaned = cleanText(value); if (cleaned.length > content.length) content = cleaned; }
  if (content.length < 80) {
    const withoutChrome = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
      .replace(/<form[\s\S]*?<\/form>/gi, " ");
    const h1End = withoutChrome.search(/<\/h1\s*>/i);
    const bodyEnd = withoutChrome.search(/<\/body\s*>/i);
    const articleLike = withoutChrome.slice(h1End >= 0 ? h1End + 5 : 0, bodyEnd > h1End ? bodyEnd : undefined);
    const lines = cleanText(articleLike)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !/^(上一章|下一章|返回目录|返回书页|章节列表|加入书签|投推荐票|错误举报|繁體中文|简体中文|[|｜·•]+)$/.test(line))
      .filter((line) => !/(飘天文学|PT文学|Copyright|本站域名|请记住本站|最新网址|章节错误|手机阅读|加入收藏)/i.test(line));
    const fallback = lines.join("\n\n");
    if (fallback.length > content.length) content = fallback;
  }
  content = postProcessChapter(content.replace(/(?:请记住本站|最新网址|手机阅读|章节错误|加入书签|返回目录)[\s\S]{0,120}$/gi, "").trim(), expectedTitle);
  if (content.length < 80) throw new Error("未能识别正文，页面结构可能已变化");
  return content;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const url = validateUrl(body.url);
    const html = await fetchHtml(url);
    if (body.action === "index") return NextResponse.json(parseIndex(html, url));
    if (body.action === "chapter") return NextResponse.json({ content: parseChapter(html, typeof body.title === "string" ? body.title : "") });
    return NextResponse.json({ error: "未知操作" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "处理失败" }, { status: 400 });
  }
}
