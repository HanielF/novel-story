import { NextRequest, NextResponse } from "next/server";
import iconv from "iconv-lite";

export const runtime = "edge";

function cleanText(value: string) {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>|<\/br\s*>/gi, "\n").replace(/<\/(?:p|div|h1|h2|h3|h4|li|section|article|blockquote|tr)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;|&ensp;|&emsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16))).replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
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

type ParsedPage = { title: string; html: string };

function sourceFor(url: URL) {
  const host = url.hostname.toLowerCase();
  if (host === "piaotia.com" || host.endsWith(".piaotia.com")) return "piaotia";
  if (host === "biqu33.cc" || host.endsWith(".biqu33.cc")) return "biqu33";
  if (host === "zh.wikisource.org" || host.endsWith(".wikisource.org")) return "wikisource";
  if (host === "aozora.gr.jp" || host === "www.aozora.gr.jp") return "aozora";
  if (host === "zongheng.com" || host.endsWith(".zongheng.com")) return "zongheng";
  if (host === "jjwxc.net" || host.endsWith(".jjwxc.net")) return "jjwxc";
  return "generic";
}

type SearchMatch = { title: string; author?: string; url: string; sourceKey: string; source: string };
type SearchAttempt = { source: string; ok: boolean; detail: string };

function encodeFormGbk(values: Record<string, string>) {
  const parts: number[] = [];
  const safe = /[A-Za-z0-9_.~-]/;
  const push = (value: string) => {
    for (const byte of iconv.encode(value, "gb18030")) {
      const character = String.fromCharCode(byte);
      if (safe.test(character)) parts.push(byte);
      else for (const code of `%${byte.toString(16).toUpperCase().padStart(2, "0")}`) parts.push(code.charCodeAt(0));
    }
  };
  Object.entries(values).forEach(([key, value], index) => {
    if (index) parts.push(38);
    push(key); parts.push(61); push(value);
  });
  return new Uint8Array(parts);
}

async function searchPiaotia(query: string): Promise<SearchMatch | null> {
  const url = new URL("https://www.piaotia.com/modules/article/search.php");
  const response = await fetch(url, {
    method: "POST",
    redirect: "follow",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      referer: "https://www.piaotia.com/",
    },
    body: encodeFormGbk({ searchtype: "articlename", searchkey: query }),
  });
  if (!response.ok) throw new Error(`返回 ${response.status}`);
  const html = new TextDecoder("gb18030").decode(await response.arrayBuffer());
  const direct = /<caption>[\s\S]*?<font[^>]*>([\s\S]*?)<\/font>[\s\S]*?<a\b[^>]*href=["'](https?:\/\/www\.piaotia\.com\/html\/\d+\/\d+\/(?:index\.html)?)['"]/i.exec(html);
  if (direct && normalizeTitle(direct[1]) === normalizeTitle(query)) return { title: cleanText(direct[1]), url: direct[2], sourceKey: "piaotia", source: "飘天文学" };
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const link = /<a\b[^>]*href=["'](https?:\/\/www\.piaotia\.com\/(?:bookinfo|html)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(row[1]);
    if (!link) continue;
    const title = cleanText(link[2]);
    if (normalizeTitle(title) !== normalizeTitle(query)) continue;
    const url = new URL(link[1]);
    if (/bookinfo/i.test(url.pathname)) url.pathname = url.pathname.replace(/^\/bookinfo\/(\d+)\/(\d+)\.html$/i, "/html/$1/$2/");
    return { title, url: url.href, sourceKey: "piaotia", source: "飘天文学" };
  }
  return null;
}

async function searchZongheng(query: string): Promise<SearchMatch | null> {
  const url = new URL("https://search.zongheng.com/search/book");
  url.search = new URLSearchParams({ keyword: query, sort: "null", pageNo: "1", pageNum: "20", isFromHuayu: "0" }).toString();
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; ShiyeNovelTxt/1.0)" } });
  if (!response.ok) throw new Error(`返回 ${response.status}`);
  const data = await response.json() as { data?: { datas?: { list?: Array<Record<string, unknown>> } } };
  const books = data.data?.datas?.list || [];
  for (const item of books) {
    const title = cleanText(String(item.name || item.bookName || item.keyword || ""));
    const id = String(item.bookId || item.id || "");
    if (normalizeTitle(title) === normalizeTitle(query) && /^\d+$/.test(id)) return { title, author: String(item.authorName || item.author || ""), url: `https://www.zongheng.com/detail/${id}`, sourceKey: "zongheng", source: "纵横中文网" };
  }
  return null;
}

async function searchWikisource(query: string): Promise<SearchMatch | null> {
  const url = new URL("https://zh.wikisource.org/w/api.php");
  url.search = new URLSearchParams({ action: "query", titles: query, redirects: "1", format: "json", formatversion: "2", origin: "*" }).toString();
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "ShiyeNovelTxt/1.0 (public-domain personal reading tool)" } });
  if (!response.ok) throw new Error(`返回 ${response.status}`);
  const data = await response.json() as { query?: { pages?: Array<{ title: string; missing?: boolean }> } };
  const found = data.query?.pages?.find((item) => !item.missing);
  return found ? { title: found.title, url: `https://zh.wikisource.org/wiki/${encodeURIComponent(found.title.replace(/ /g, "_"))}`, sourceKey: "wikisource", source: "中文维基文库" } : null;
}

async function searchBook(query: string, requested: string) {
  const definitions = [
    { key: "piaotia", name: "飘天文学", search: searchPiaotia },
    { key: "zongheng", name: "纵横中文网", search: searchZongheng },
    { key: "wikisource", name: "中文维基文库", search: searchWikisource },
  ].filter((item) => requested === "auto" || requested === item.key);
  if (!definitions.length) throw new Error("该书源暂只支持粘贴作品链接");
  const attempts: SearchAttempt[] = [];
  for (const definition of definitions) {
    try {
      const match = await definition.search(query);
      attempts.push({ source: definition.name, ok: Boolean(match), detail: match ? "已找到" : "没有同名作品" });
      if (match) return { match, attempts };
    } catch (error) {
      attempts.push({ source: definition.name, ok: false, detail: error instanceof Error ? error.message : "读取失败" });
    }
  }
  return { match: null, attempts };
}

function pageNameFromWikisourceUrl(url: URL) {
  const queryTitle = url.searchParams.get("title");
  if (queryTitle) return queryTitle;
  const raw = url.pathname.replace(/^\/(?:wiki|zh-hans|zh-hant|zh)\//, "");
  if (!raw || raw === url.pathname.slice(1)) throw new Error("请粘贴维基文库的具体作品页链接");
  try { return decodeURIComponent(raw).replace(/_/g, " "); }
  catch { throw new Error("维基文库链接无法识别"); }
}

async function fetchWikisourcePage(url: URL): Promise<ParsedPage> {
  const api = new URL("/w/api.php", url);
  api.searchParams.set("action", "parse");
  api.searchParams.set("page", pageNameFromWikisourceUrl(url));
  api.searchParams.set("prop", "text|displaytitle");
  api.searchParams.set("format", "json");
  api.searchParams.set("formatversion", "2");
  const response = await fetch(api, {
    headers: {
      "user-agent": "ShiyeNovelTxt/1.0 (public-domain personal reading tool)",
      accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`维基文库接口返回 ${response.status}`);
  const data = await response.json() as { error?: { info?: string }; parse?: { title?: string; displaytitle?: string; text?: string } };
  if (data.error || !data.parse?.text) throw new Error(data.error?.info || "维基文库页面不存在");
  return { title: cleanText(data.parse.displaytitle || data.parse.title || "未命名作品"), html: data.parse.text };
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

function removeBalancedDiv(html: string, openPattern: RegExp) {
  let result = html;
  for (;;) {
    const open = openPattern.exec(result);
    if (!open || open.index === undefined) return result;
    const tagPattern = /<\/?div\b[^>]*>/gi;
    tagPattern.lastIndex = open.index + open[0].length;
    let depth = 1;
    let match: RegExpExecArray | null;
    let end = result.length;
    while ((match = tagPattern.exec(result))) {
      depth += /^<\/div/i.test(match[0]) ? -1 : 1;
      if (depth === 0) { end = tagPattern.lastIndex; break; }
    }
    result = result.slice(0, open.index) + result.slice(end);
  }
}

function htmlWithReadableImages(html: string) {
  return html
    .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, "")
    .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, "")
    .replace(/<\/?(?:ruby|rb)\b[^>]*>/gi, "")
    .replace(/<img\b[^>]*\balt=["']([^"']+)["'][^>]*>/gi, "$1");
}

function parseWikisourceIndex(page: ParsedPage, base: URL) {
  const rootName = pageNameFromWikisourceUrl(base).replace(/ /g, "_");
  const seen = new Set<string>();
  const chapters: { title: string; url: string }[] = [];
  const linkRe = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of page.html.matchAll(linkRe)) {
    const title = cleanText(match[2]);
    if (!title || title.length > 160 || !/(?:^|\s)(?:第.{0,14}[\u7ae0\u8282\u5377\u56de\u90e8\u7bc7]|[卷篇][零〇一二三四五六七八九十百千两\d]+|[序楔引跋附录])/.test(title)) continue;
    try {
      const href = new URL(match[1], base);
      if (href.hostname !== base.hostname || !href.pathname.startsWith("/wiki/")) continue;
      const linkedName = decodeURIComponent(href.pathname.slice(6)).replace(/ /g, "_");
      if (!linkedName.startsWith(`${rootName}/`) || linkedName.includes(":")) continue;
      href.hash = "";
      if (seen.has(href.href)) continue;
      seen.add(href.href);
      chapters.push({ title, url: href.href });
    } catch { /* ignore malformed links */ }
  }
  const author = /(?:作者|著者|輯者)[：:\s]+([^\n]{2,60})/.exec(cleanText(page.html))?.[1]?.replace(/\s{2,}.*/, "").trim() || "";
  if (!chapters.length) chapters.push({ title: page.title, url: base.href });
  return { title: page.title.replace(/\s*[-—|].*$/, "").trim(), author, chapters, source: "维基文库", recommendedConcurrency: 4, notice: "自由文本；导出后请保留作者与来源信息。" };
}

function parseWikisourceChapter(page: ParsedPage, expectedTitle: string) {
  let html = page.html;
  for (const id of ["headerContainer", "licenseContainer", "footerContainer", "ws-data"]) {
    html = removeBalancedDiv(html, new RegExp(`<div\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i"));
  }
  html = html
    .replace(/<(?:span|div)\b[^>]*\bclass=["'][^"']*(?:mw-editsection|noprint|noexport|reference)[^"']*["'][^>]*>[\s\S]*?<\/(?:span|div)>/gi, " ")
    .replace(/<sup\b[^>]*\bclass=["'][^"']*reference[^"']*["'][^>]*>[\s\S]*?<\/sup>/gi, " ");
  const content = postProcessChapter(cleanText(htmlWithReadableImages(html)), expectedTitle);
  if (content.length < 40) throw new Error("维基文库正文过短或页面为空");
  return content;
}

function parseAozoraIndex(html: string, base: URL) {
  const title = cleanText(/<td\b[^>]*class=["']header["'][^>]*>\s*作品名：\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i.exec(html)?.[1] || /<h1\b[^>]*class=["']title["'][^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "未命名作品").replace(/図書カード：/, "").trim();
  const author = cleanText(/<td\b[^>]*class=["']header["'][^>]*>\s*著者名：\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i.exec(html)?.[1] || /<h2\b[^>]*class=["']author["'][^>]*>([\s\S]*?)<\/h2>/i.exec(html)?.[1] || "");
  let contentUrl = base.href;
  if (/\/card\d+\.html?$/i.test(base.pathname)) {
    const file = /<a\b[^>]*href=["']([^"']*\/files\/[^"']+\.html?)["'][^>]*>(?:[^<]*(?:XHTML|いますぐ)|[^<]*\.html?)/i.exec(html)?.[1]
      || /<a\b[^>]*href=["']([^"']*\/files\/[^"']+\.html?)["']/i.exec(html)?.[1];
    if (!file) throw new Error("图书卡中没有找到 XHTML 正文");
    contentUrl = new URL(file, base).href;
  }
  return { title, author, chapters: [{ title: "全文", url: contentUrl }], source: "青空文库", recommendedConcurrency: 1, notice: "请按作品图书卡标注的版权条件使用。" };
}

function parseAozoraChapter(html: string) {
  const main = extractBalancedElement(html, /<div\b[^>]*\bclass=["'][^"']*main_text[^"']*["'][^>]*>/i);
  const content = cleanText(htmlWithReadableImages(main || html));
  if (content.length < 40) throw new Error("青空文库正文过短或页面为空");
  return content;
}

function metaContent(html: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return cleanText(new RegExp(`<meta\\b(?=[^>]*(?:property|name)=["']${escaped}["'])(?=[^>]*content=["']([^"']*)["'])[^>]*>`, "i").exec(html)?.[1] || "");
}

function zonghengBookId(url: URL) {
  const match = /(?:detail|book)\/(\d+)/.exec(url.pathname) || /chapter\/(\d+)\//.exec(url.pathname);
  if (!match) throw new Error("请粘贴纵横中文网的作品详情页链接");
  return match[1];
}

async function parseZonghengIndex(html: string, base: URL) {
  const bookId = zonghengBookId(base);
  const api = new URL("https://bookapi.zongheng.com/api/chapter/getChapterList");
  const response = await fetch(api, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": "Mozilla/5.0 (compatible; ShiyeNovelTxt/1.0)",
      referer: base.href,
    },
    body: new URLSearchParams({ bookId }).toString(),
  });
  if (!response.ok) throw new Error(`纵横目录接口返回 ${response.status}`);
  const data = await response.json() as { result?: { chapterList?: Array<{ chapterViewList?: Array<{ chapterId: number; chapterName: string; bookId: number; level?: number; issueTime?: string; createTime?: string }> }> } };
  const all = (data.result?.chapterList || []).flatMap((volume) => volume.chapterViewList || []);
  const free = all.filter((chapter) => !chapter.level).sort((a, b) => String(a.issueTime || a.createTime || "").localeCompare(String(b.issueTime || b.createTime || "")));
  if (!free.length) throw new Error("该作品没有可公开读取的免费章节");
  const title = metaContent(html, "og:novel:book_name") || metaContent(html, "og:title") || cleanText(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || `纵横作品 ${bookId}`).replace(/[_-]纵横中文网.*$/, "").trim();
  const author = metaContent(html, "og:novel:author") || /(?:作者|作家)[：:\s]+([^\s|]{2,30})/.exec(cleanText(html.slice(0, 120000)))?.[1] || "";
  return {
    title,
    author,
    chapters: free.map((chapter) => ({ title: chapter.chapterName, url: `https://read.zongheng.com/chapter/${chapter.bookId}/${chapter.chapterId}.html` })),
    source: "纵横中文网·公开章节",
    recommendedConcurrency: 4,
    notice: all.length > free.length ? `已自动排除 ${all.length - free.length} 个付费或锁定章节。` : "仅整理当前可公开阅读的章节。",
  };
}

function parseZonghengChapter(html: string, expectedTitle: string) {
  const main = extractBalancedElement(html, /<div\b[^>]*\bclass=["'][^"']*\bcontent\b[^"']*["'][^>]*>/i);
  const content = postProcessChapter(cleanText(main), expectedTitle)
    .replace(/^作者：[\s\S]{0,80}?本章字数：\s*\d+\s*更新时间：\s*[\d-]+\s+[\d:]+\s*/, "")
    .trim();
  if (content.length < 80) throw new Error("纵横正文未能识别，或该章已不再公开");
  return content;
}

function jjwxcBookId(url: URL) {
  const id = url.searchParams.get("novelid") || /\/(?:book2|onebook)\/(\d+)/.exec(url.pathname)?.[1];
  if (!id || !/^\d+$/.test(id)) throw new Error("请粘贴晋江文学城的作品页链接");
  return id;
}

function parseJjwxcIndex(html: string, base: URL) {
  const bookId = jjwxcBookId(base);
  const pageTitle = cleanText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "");
  const title = /《([^>]+)》/.exec(pageTitle)?.[1]?.trim() || cleanText(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || `晋江作品 ${bookId}`);
  const author = /》([^_^|]+?)(?:_|晋江)/.exec(pageTitle)?.[1]?.trim() || "";
  const chapters: { title: string; url: string }[] = [];
  let locked = 0;
  const rowRe = /<tr\b[^>]*\bitemprop=["'][^"']*chapter[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi;
  for (const rowMatch of html.matchAll(rowRe)) {
    const row = rowMatch[1];
    const link = /<a\b[^>]*(?:href|rel)=["']([^"']*(?:novelid|book2)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!link) continue;
    const ids = /novelid=(\d+).*?chapterid=(\d+)/i.exec(link[1]) || /book2\/(\d+)\/(\d+)/i.exec(link[1]);
    if (!ids) continue;
    if (/\[VIP\]|锁定|🔒/i.test(cleanText(row))) { locked += 1; continue; }
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => cleanText(match[1]));
    const heading = cleanText(link[2]);
    const summary = cells[2] && cells[2] !== heading ? cells[2] : "";
    chapters.push({ title: [heading, summary].filter(Boolean).join(" "), url: `https://m.jjwxc.net/book2/${ids[1]}/${ids[2]}` });
  }
  if (!chapters.length) throw new Error("该作品没有可公开读取的免费章节");
  return { title, author, chapters, source: "晋江文学城·免费章节", recommendedConcurrency: 3, notice: locked ? `已自动排除 ${locked} 个 VIP 或锁定章节。` : "仅整理当前可公开阅读的章节。" };
}

function parseJjwxcChapter(html: string, expectedTitle: string) {
  const list = /<ul\b[^>]*\bclass=["'][^"']*content_ul[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i.exec(html)?.[1] || "";
  const content = postProcessChapter(cleanText(list), expectedTitle)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (content.length < 80 || /(?:请购买|订阅本章|登录后阅读)/.test(content.slice(0, 300))) throw new Error("该章不是可公开读取的免费章节");
  return content;
}

function previousLink(html: string, base: URL) {
  const match = /<a\b(?=[^>]*(?:rel=["']?prev["']?|>\s*上一章\s*<))[^>]*href=["']?([^\s"'>]+)["']?[^>]*>/i.exec(html)
    || /<a\b[^>]*href=["']?([^\s"'>]+)["']?[^>]*>\s*上一章\s*<\/a>/i.exec(html);
  if (!match) return "";
  try {
    const url = new URL(match[1], base);
    return url.hostname === base.hostname && url.pathname !== base.pathname ? url.href : "";
  } catch { return ""; }
}

function biquChapterTitle(html: string) {
  return cleanText(/<h2\b[^>]*id=["']?post-h2["']?[^>]*>([\s\S]*?)<\/h2>/i.exec(html)?.[1]
    || /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]
    || /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
    || "未命名章节").replace(/^.*?<br\s*\/?>(.*)$/i, "$1").trim();
}

async function parseBiqu33Index(html: string, base: URL) {
  const title = cleanText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "未命名小说").replace(/[-_].*$/, "").trim();
  const author = /<title[^>]*>[^<]*?-([^<-]{2,30})-(?:无删减|无错字)/i.exec(html)?.[1]?.trim() || /作者[：:\s]+([^\s|/]{2,24})/.exec(cleanText(html))?.[1] || "";
  const seen = new Set<string>();
  const newestFirst: { title: string; url: string }[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']?(\/book\/[^\s"'>]+\/\d+\/)["']?[^>]*(?:title=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = new URL(match[1], base).href;
    const chapterTitle = cleanText(match[2] || match[3]);
    if (!chapterTitle || seen.has(url)) continue;
    seen.add(url); newestFirst.push({ title: chapterTitle, url });
  }
  if (!newestFirst.length) throw new Error("没有识别到最新章节");
  const chapters = newestFirst.reverse();
  let cursor = "";
  try { cursor = previousLink(await fetchHtml(new URL(chapters[0].url)), new URL(chapters[0].url)); } catch { /* latest list still remains usable */ }
  return {
    title, author, chapters,
    source: "笔趣阁 biqu33·链式回溯",
    sourceKey: "biqu33",
    recommendedConcurrency: 2,
    notice: cursor ? "目录仅展示最近章节，正在支持沿“上一章”回溯完整目录。" : "已读取网站公开展示的章节。",
    discovery: cursor ? { mode: "previous-chain", cursor, complete: false } : undefined,
  };
}

async function discoverPrevious(url: URL) {
  const html = await fetchHtml(url);
  const title = biquChapterTitle(html);
  const cursor = previousLink(html, url);
  return { chapter: { title, url: url.href }, cursor, complete: !cursor };
}

async function discoverPreviousBatch(url: URL, requestedLimit: unknown) {
  const limit = Math.max(1, Math.min(20, Number(requestedLimit) || 12));
  const chapters: { title: string; url: string }[] = [];
  let cursor = url.href;
  for (let index = 0; index < limit && cursor; index += 1) {
    const result = await discoverPrevious(new URL(cursor));
    chapters.push(result.chapter);
    cursor = result.cursor;
  }
  return { chapters, cursor, complete: !cursor };
}

async function parseBiqu33Chapter(html: string, base: URL, expectedTitle: string) {
  const pageUrls = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href=["']?([^\s"'>]+_\d+\/)["']?[^>]*class=["']?post-page-numbers/gi)) {
    try { pageUrls.add(new URL(match[1], base).href); } catch { /* ignore malformed pagination */ }
  }
  const extraPages = await Promise.all([...pageUrls].slice(0, 12).map(async (href) => ({ href, html: await fetchHtml(new URL(href)) })));
  const pages = [{ href: base.href, html }, ...extraPages].sort((a, b) => {
    const number = (href: string) => Number(/_(\d+)\/$/.exec(new URL(href).pathname)?.[1] || 1);
    return number(a.href) - number(b.href);
  });
  const content = pages.map((page) => {
    const main = extractBalancedElement(page.html, /<div\b[^>]*\bid=["']?hp_photos["']?[^>]*>/i)
      || extractBalancedElement(page.html, /<div\b[^>]*\bclass=["'][^"']*article-content[^"']*["'][^>]*>/i);
    return cleanText(main);
  }).filter(Boolean).join("\n\n");
  const cleaned = postProcessChapter(content, expectedTitle);
  if (cleaned.length < 80) throw new Error("笔趣阁分页正文未能识别");
  return cleaned;
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
    if (body.action === "search") {
      const query = typeof body.query === "string" ? body.query.trim() : "";
      const requested = typeof body.source === "string" ? body.source : "auto";
      if (query.length < 2 || query.length > 80) throw new Error("请输入 2–80 个字的书名");
      const result = await searchBook(query, requested);
      if (!result.match) return NextResponse.json({ error: "没有在可检索书源中找到同名作品", attempts: result.attempts }, { status: 404 });
      return NextResponse.json(result);
    }
    const url = validateUrl(body.url);
    const source = sourceFor(url);
    const expectedTitle = typeof body.title === "string" ? body.title : "";
    if (body.action === "previous") {
      if (source !== "biqu33") throw new Error("该书源不支持上一章链式发现");
      return NextResponse.json(await discoverPrevious(url));
    }
    if (body.action === "previous-batch") {
      if (source !== "biqu33") throw new Error("该书源不支持上一章链式发现");
      return NextResponse.json(await discoverPreviousBatch(url, body.limit));
    }
    if (source === "wikisource") {
      const page = await fetchWikisourcePage(url);
      if (body.action === "index") return NextResponse.json(parseWikisourceIndex(page, url));
      if (body.action === "chapter") return NextResponse.json({ content: parseWikisourceChapter(page, expectedTitle) });
    }
    const html = await fetchHtml(url);
    if (source === "biqu33") {
      if (body.action === "index") return NextResponse.json(await parseBiqu33Index(html, url));
      if (body.action === "chapter") return NextResponse.json({ content: await parseBiqu33Chapter(html, url, expectedTitle) });
    }
    if (source === "piaotia") {
      if (body.action === "index") return NextResponse.json({ ...parseIndex(html, url), source: "飘天文学", sourceKey: "piaotia", recommendedConcurrency: 8, notice: "默认书源；仅整理当前公开可访问的章节。" });
      if (body.action === "chapter") return NextResponse.json({ content: parseChapter(html, expectedTitle) });
    }
    if (source === "zongheng") {
      if (body.action === "index") return NextResponse.json(await parseZonghengIndex(html, url));
      if (body.action === "chapter") return NextResponse.json({ content: parseZonghengChapter(html, expectedTitle) });
    }
    if (source === "jjwxc") {
      if (body.action === "index") return NextResponse.json(parseJjwxcIndex(html, url));
      if (body.action === "chapter") return NextResponse.json({ content: parseJjwxcChapter(html, expectedTitle) });
    }
    if (source === "aozora") {
      if (body.action === "index") return NextResponse.json(parseAozoraIndex(html, url));
      if (body.action === "chapter") return NextResponse.json({ content: parseAozoraChapter(html) });
    }
    if (body.action === "index") return NextResponse.json({ ...parseIndex(html, url), source: "通用公开 HTML", sourceKey: "generic", recommendedConcurrency: 6, notice: "仅整理你有权保存的公开内容。" });
    if (body.action === "chapter") return NextResponse.json({ content: parseChapter(html, expectedTitle) });
    return NextResponse.json({ error: "未知操作" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "处理失败" }, { status: 400 });
  }
}
