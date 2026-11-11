// The landing page's own words, in both languages (DESIGN-W1 1.1). Everything else on the page is the README's, cut by
// these headings at build time (site/render.ts), so the site never holds a second copy of the README's text.
// Pure data (and one word that takes the install way): the build (scripts/build-site.ts) and the page's script
// (site/page.ts) both import it.

export type Lang = "en" | "zh-CN";
export const LANGS: readonly Lang[] = ["en", "zh-CN"];

export interface SiteWords {
  /** The other language's link: its name in that language, its lang and the path to its page from this one. */
  other: { name: string; lang: Lang; href: string };
  github: string;
  /** The theme button's name and tooltip; aria-pressed says whether the page is dark now. */
  darkTheme: string;
  /** The device switch, a radio group. */
  device: string;
  phone: string;
  laptop: string;
  /** The frames' titles: the phone and the laptop on a wide screen, and the full-width frame on a narrow one. */
  phoneTitle: string;
  laptopTitle: string;
  demoTitle: string;
  note: string;
  noScript: string;
  copy: string;
  copied: string;
  copyFailed: string;
  /** A Copy button's accessible name: its own word first, then the install way of its heading. */
  copyName: (way: string) => string;
  /** The foot's links. */
  links: string;
  readme: string;
  contributing: string;
  security: string;
  /** The README's headings that the page is cut by (`##`, and `###` inside Install). */
  headings: {
    why: string;
    who: string;
    works: string;
    requirements: string;
    install: string;
    script: string;
    brew: string;
    source: string;
    remote: string;
    licence: string;
    trademarks: string;
  };
}

export const WORDS: Record<Lang, SiteWords> = {
  en: {
    other: { name: "简体中文", lang: "zh-CN", href: "zh-CN/" },
    github: "GitHub",
    darkTheme: "Dark theme",
    device: "Device",
    phone: "Phone",
    laptop: "Laptop",
    phoneTitle: "kitespan demo on a phone",
    laptopTitle: "kitespan demo on a laptop",
    demoTitle: "kitespan demo",
    note: "A demo in this tab, with made-up chats. Nothing is sent anywhere.",
    noScript: "The demo needs JavaScript.",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed",
    copyName: (way) => `Copy the command: ${way}`,
    links: "Links",
    readme: "README",
    contributing: "Contributing",
    security: "Security",
    headings: {
      why: "Why it exists",
      who: "Who it is for",
      works: "What works today",
      requirements: "Requirements",
      install: "Install",
      script: "With the install script",
      brew: "With Homebrew",
      source: "From source",
      remote: "From another device",
      licence: "Licence",
      trademarks: "Trademarks",
    },
  },
  "zh-CN": {
    other: { name: "English", lang: "en", href: "../" },
    github: "GitHub",
    darkTheme: "深色主题",
    device: "设备",
    phone: "手机",
    laptop: "笔记本电脑",
    phoneTitle: "kitespan 在手机上的演示",
    laptopTitle: "kitespan 在笔记本电脑上的演示",
    demoTitle: "kitespan 演示",
    note: "演示在本标签页中运行，对话都是虚构的，不会发送任何内容。",
    noScript: "演示需要 JavaScript。",
    copy: "复制",
    copied: "已复制",
    copyFailed: "复制失败",
    copyName: (way) => `复制命令：${way}`,
    links: "链接",
    readme: "README",
    contributing: "贡献指南",
    security: "安全",
    headings: {
      why: "为什么做它",
      who: "适合谁",
      works: "现在能用什么",
      requirements: "环境要求",
      install: "安装",
      script: "用安装脚本",
      brew: "用 Homebrew",
      source: "从源码安装",
      remote: "从其他设备访问",
      licence: "许可证",
      trademarks: "商标",
    },
  },
};
