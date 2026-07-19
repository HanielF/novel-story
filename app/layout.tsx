import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "拾页｜小说 TXT 整理工具",
  description: "读取小说目录与章节，整理为适合手机和 Kindle 导入的 UTF-8 TXT 文件。",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
