"use client";

import { useMemo, useRef, useState } from "react";

type Chapter = { title: string; url: string; selected: boolean; status: "waiting" | "done" | "failed" };
type BookInfo = { title: string; author: string; source?: string; notice?: string; recommendedConcurrency?: number; chapters: Omit<Chapter, "selected" | "status">[] };

const EXAMPLE = "https://zh.wikisource.org/wiki/%E7%B4%85%E6%A8%93%E5%A4%A2";
const SOURCES = [
  { name: "中文维基文库", detail: "中文公版及自由授权文本 · 支持分回目录", url: EXAMPLE, action: "试试《红楼梦》" },
  { name: "青空文库", detail: "日文公版与授权作品 · 支持图书卡和 XHTML", url: "https://www.aozora.gr.jp/cards/000148/card773.html", action: "试试『こころ』" },
  { name: "纵横中文网", detail: "tickmao 精选规则 · 官方目录 · 自动排除付费章节", url: "https://www.zongheng.com/detail/1067695", action: "试试公开章节" },
  { name: "晋江文学城", detail: "tickmao 精选规则 · 仅免费章节 · 自动跳过 VIP", url: "https://www.jjwxc.net/onebook.php?novelid=4368324", action: "试试免费作品" },
];

export default function Home() {
  const [url, setUrl] = useState(EXAMPLE);
  const [book, setBook] = useState<BookInfo | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [message, setMessage] = useState("粘贴小说目录页链接，从读取目录开始");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [concurrency, setConcurrency] = useState(6);
  const [failureReason, setFailureReason] = useState("");
  const contentsRef = useRef<Record<string, string>>({});
  const abortRef = useRef(false);

  const selectedCount = chapters.filter((c) => c.selected).length;
  const doneCount = chapters.filter((c) => c.selected && c.status === "done").length;
  const percent = selectedCount ? Math.round((doneCount / selectedCount) * 100) : 0;

  async function readDirectory() {
    setLoading(true);
    setMessage("正在辨认书名与章节目录…");
    setBook(null);
    setChapters([]);
    contentsRef.current = {};
    setFailureReason("");
    try {
      const response = await fetch("/api/novel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "index", url }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "目录读取失败");
      setBook(data);
      if (data.recommendedConcurrency) setConcurrency(data.recommendedConcurrency);
      setChapters(data.chapters.map((c: Chapter) => ({ ...c, selected: true, status: "waiting" })));
      setMessage(`已找到 ${data.chapters.length} 章，请检查后开始制作`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "目录读取失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  async function buildTxt() {
    if (!book || !selectedCount) return;
    abortRef.current = false;
    setRunning(true);
    setFailureReason("");
    setMessage(`正在以 ${concurrency} 路并发整理，请保持页面开启`);
    const nextContents = contentsRef.current;
    const workingChapters = chapters.map((chapter) => ({ ...chapter }));
    const pendingIndexes = workingChapters
      .map((chapter, index) => ({ chapter, index }))
      .filter(({ chapter }) => chapter.selected && !nextContents[chapter.url])
      .map(({ index }) => index);
    let queuePosition = 0;
    let completedSinceRender = 0;
    let failureStreak = 0;
    let lastFailure = "";
    let totalFailures = 0;
    async function worker() {
      while (!abortRef.current) {
        const position = queuePosition;
        queuePosition += 1;
        if (position >= pendingIndexes.length) return;
        const index = pendingIndexes[position];
        const chapter = workingChapters[index];
        try {
          let data: { content?: string; error?: string } = {};
          let response: Response | null = null;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            response = await fetch("/api/novel", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "chapter", url: chapter.url, title: chapter.title }),
            });
            data = await response.json();
            if (response.ok) break;
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
          }
          if (!response?.ok || !data.content) throw new Error(data.error || "章节读取失败");
          nextContents[chapter.url] = data.content;
          workingChapters[index].status = "done";
          failureStreak = 0;
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : "章节读取失败";
          failureStreak += 1;
          totalFailures += 1;
          setFailureReason(lastFailure);
          workingChapters[index].status = "failed";
          if (failureStreak >= concurrency * 2) {
            setMessage(`已暂停：连续多章失败。${lastFailure}`);
            abortRef.current = true;
          }
        }
        completedSinceRender += 1;
        if (completedSinceRender >= 10 || abortRef.current) {
          completedSinceRender = 0;
          setChapters(workingChapters.map((item) => ({ ...item })));
        }
        if (!abortRef.current) await new Promise((resolve) => setTimeout(resolve, 220));
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pendingIndexes.length) }, () => worker()));
    setChapters(workingChapters.map((item) => ({ ...item })));
    setRunning(false);
    if (!abortRef.current) setMessage(totalFailures ? `本轮完成，仍有 ${totalFailures} 章失败，可点击继续制作重试` : "整理完成，可以下载 TXT 了");
    else if (!lastFailure) setMessage("已暂停，可继续制作");
  }

  function downloadTxt() {
    if (!book) return;
    const selected = chapters.filter((c) => c.selected && contentsRef.current[c.url]);
    const text = [
      book.title,
      book.author ? `作者：${book.author}` : "",
      book.source ? `来源：${book.source}` : "",
      `原始链接：${url}`,
      "",
      ...selected.flatMap((chapter) => [chapter.title, "", contentsRef.current[chapter.url], "", ""]),
    ].join("\r\n");
    const blob = new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${book.title.replace(/[\\/:*?\"<>|]/g, "_")}.txt`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  function toggleAll(value: boolean) {
    setChapters((items) => items.map((item) => ({ ...item, selected: value })));
  }

  const statusText = useMemo(() => {
    const failed = chapters.filter((c) => c.selected && c.status === "failed").length;
    return failed ? `${failed} 章失败，可再次点击“继续制作”重试` : `${doneCount} / ${selectedCount} 章已整理`;
  }, [chapters, doneCount, selectedCount]);

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="拾页首页"><span className="brand-mark">拾</span><span>拾页</span></a>
        <span className="tagline">把散落的章节，装订成一本书</span>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow">NOVEL TO TXT · 本地阅读工具</div>
        <h1>一条链接，<br /><em>收好整本故事。</em></h1>
        <p className="intro">读取公版、自由授权或你有权保存的公开章节，按原顺序整理正文，导出为兼容手机阅读器与 Kindle 的 UTF-8 TXT。</p>
        <div className="url-box">
          <label htmlFor="novel-url">小说目录页</label>
          <div className="url-row">
            <input id="novel-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/小说目录/" spellCheck={false} />
            <button className="primary" onClick={readDirectory} disabled={loading || !url.trim()}>{loading ? "读取中…" : "读取目录"}</button>
          </div>
          <p><span className="pulse" />{message}</p>
        </div>
        <div className="steps" aria-label="使用步骤">
          <div><b>01</b><span>粘贴目录链接</span></div><i />
          <div><b>02</b><span>选择所需章节</span></div><i />
          <div><b>03</b><span>导出 TXT</span></div>
        </div>
      </section>

      {book ? (
        <section className="workspace">
          <div className="book-head">
            <div><span className="section-label">{book.source || "已识别书目"}</span><h2>{book.title}</h2><p>{book.author || "作者信息未识别"} · 共 {chapters.length} 章{book.notice ? ` · ${book.notice}` : ""}</p></div>
            <div className="book-actions">
              <label className="speed-control">并发
                <select value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} disabled={running}>
                  <option value={1}>1 路（单篇）</option>
                  <option value={3}>3 路（稳妥）</option>
                  <option value={4}>4 路（公开书源）</option>
                  <option value={6}>6 路（推荐）</option>
                  <option value={10}>10 路（快速）</option>
                </select>
              </label>
              <button className="quiet" onClick={() => toggleAll(true)}>全选</button>
              <button className="quiet" onClick={() => toggleAll(false)}>清空</button>
            </div>
          </div>
          <div className="chapter-list">
            {chapters.map((chapter, index) => (
              <label className="chapter" key={chapter.url}>
                <input type="checkbox" checked={chapter.selected} onChange={() => setChapters((items) => items.map((c) => c.url === chapter.url ? { ...c, selected: !c.selected } : c))} />
                <span className="number">{String(index + 1).padStart(3, "0")}</span>
                <span className="chapter-title">{chapter.title}</span>
                <span className={`chapter-status ${chapter.status}`}>{chapter.status === "done" ? "已整理" : chapter.status === "failed" ? "重试" : "待处理"}</span>
              </label>
            ))}
          </div>
          <div className="export-bar">
            <div className="progress-copy"><strong>{statusText}</strong><span>{failureReason ? `原因：${failureReason}` : "TXT 使用 UTF-8 编码，中文设备可直接导入"}</span></div>
            <div className="meter" aria-label={`进度 ${percent}%`}><span style={{ width: `${percent}%` }} /></div>
            {running ? <button className="stop" onClick={() => { abortRef.current = true; }}>暂停</button> : doneCount === selectedCount && selectedCount > 0 ? <button className="primary" onClick={downloadTxt}>下载 TXT</button> : <button className="primary" onClick={buildTxt} disabled={!selectedCount}>{doneCount ? "继续制作" : "开始制作"}</button>}
          </div>
        </section>
      ) : (
        <section className="sample">
          <div className="source-list">
            <span className="section-label">已适配公开书源</span>
            {SOURCES.map((source) => <div className="source-row" key={source.name}><div><b>{source.name}</b><p>{source.detail}</p></div><button onClick={() => setUrl(source.url)}>{source.action}</button></div>)}
            <div className="source-row"><div><b>通用公开 HTML</b><p>兼容常见的“目录页 + 章节页”结构</p></div><span>自动识别</span></div>
          </div>
          <div className="note"><b>请尊重作者与网站</b><p>仅整理你有权访问和保存的内容。导出文件会保留书源和原始链接；站点限制自动访问时，本工具会停止并提示，不会绕过验证或付费限制。</p></div>
        </section>
      )}

      <footer><span>拾页 · 让长篇阅读回到安静的设备里</span><span>所有内容仅在本次整理流程中处理</span></footer>
    </main>
  );
}
