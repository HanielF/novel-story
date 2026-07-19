import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

function cleanText(value: string) {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
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
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; ShiyeReader/1.0)", accept: "text/html,application/xhtml+xml" } });
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

function parseChapter(html: string) {
  const candidates = [
    /<div[^>]+id=["']content["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class=["'][^"']*(?:content|chapter-content|read-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
  ];
  let content = "";
  for (const pattern of candidates) { const value = pattern.exec(html)?.[1]; if (value && cleanText(value).length > content.length) content = cleanText(value); }
  content = content.replace(/(?:请记住本站|最新网址|手机阅读|章节错误|加入书签|返回目录)[\s\S]{0,120}$/gi, "").trim();
  if (content.length < 80) throw new Error("未能识别正文，页面结构可能已变化");
  return content;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const url = validateUrl(body.url);
    const html = await fetchHtml(url);
    if (body.action === "index") return NextResponse.json(parseIndex(html, url));
    if (body.action === "chapter") return NextResponse.json({ content: parseChapter(html) });
    return NextResponse.json({ error: "未知操作" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "处理失败" }, { status: 400 });
  }
}
