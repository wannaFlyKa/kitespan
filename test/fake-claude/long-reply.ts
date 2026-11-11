// A long reply for the smooth-text checks (row 79): markdown of every kind the page renders (headings, paragraphs
// with emphasis, code spans and links, bullet, numbered and task lists, quotes, code fences and tables), the same text
// for the same length, so a check knows what the page must show at the end. The fake claude streams it for a message
// that names a paced stream (fake-claude.ts pacedTurn), and the reveal's benchmark renders it.

const WORDS = [
  "the", "reply", "streams", "in", "small", "pieces", "and", "the", "page", "shows", "each", "word", "at", "an", "even",
  "pace", "while", "the", "next", "piece", "is", "on", "its", "way", "so", "nothing", "jumps", "or", "flickers", "between",
  "forms", "of", "a", "block", "that", "is", "only", "half", "there", "yet",
];

function sentence(seed: number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[(seed * 7 + i * 3) % WORDS.length]!);
  const s = out.join(" ");
  return s[0]!.toUpperCase() + s.slice(1) + ".";
}

function section(i: number): string {
  const kind = i % 6;
  const head = `## Part ${i + 1}\n\n`;
  const para = `${sentence(i, 14)} It keeps **bold words**, *a quiet emphasis*, \`inline code\` and [a link](https://example.com/docs/${i}) as they are. ${sentence(i + 1, 11)}\n\n`;
  switch (kind) {
    case 0:
      return `${head}${para}- ${sentence(i + 2, 6)}\n- ${sentence(i + 3, 7)}\n- ${sentence(i + 4, 5)}\n\n`;
    case 1:
      return `${head}${para}\`\`\`ts\nexport function step${i}(shown: number, target: number): number {\n  // reveal at most what came\n  const next = Math.min(target, shown + ${i + 3});\n  return next;\n}\n\`\`\`\n\n`;
    case 2:
      return `${head}${para}| Name | Size | Note |\n| --- | ---: | --- |\n| alpha-${i} | ${i * 3 + 1} | ${sentence(i, 3)} |\n| beta-${i} | ${i * 5 + 2} | ${sentence(i + 1, 4)} |\n| gamma-${i} | ${i * 7 + 3} | ${sentence(i + 2, 3)} |\n\n`;
    case 3:
      return `${head}${para}1. ${sentence(i + 5, 6)}\n2. ${sentence(i + 6, 5)}\n3. ${sentence(i + 7, 6)}\n\n> ${sentence(i + 8, 9)}\n\n`;
    case 4:
      return `${head}${para}- [x] ${sentence(i + 9, 4)}\n- [ ] ${sentence(i + 10, 5)}\n\n\`\`\`bash\nbun test --cwd ./project-${i}\necho "done ${i}"\n\`\`\`\n\n`;
    default:
      return `${head}${para}${sentence(i + 11, 18)} ${sentence(i + 12, 16)}\n\n`;
  }
}

/** A reply of at least `chars` characters (the last section may run past it); always the same for the same length. */
export function longReply(chars: number): string {
  let out = "";
  for (let i = 0; out.length < chars; i++) out += section(i);
  return out.trimEnd();
}

// Q1 review: the same reply in Chinese, which has no spaces between its words, for the reveal's cost per frame where
// its unit is the word Intl.Segmenter finds (scripts/bench-reveal.ts --lang zh), and Chinese thinking text.

const ZH_WORDS = [
  "回复", "分成", "小段", "流入", "页面", "以", "均匀", "的", "速度", "显示", "每个", "词", "下一段", "还在", "路上", "所以",
  "没有", "跳动", "也", "没有", "闪烁", "一个", "只", "来了", "一半", "的", "代码块", "或者", "表格", "不会", "露出", "符号",
];

function zhSentence(seed: number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(ZH_WORDS[(seed * 7 + i * 3) % ZH_WORDS.length]!);
  return out.join("") + (seed % 3 ? "。" : "，然后继续。");
}

function zhSection(i: number): string {
  const kind = i % 6;
  const head = `## 第${i + 1}部分

`;
  const para = `${zhSentence(i, 14)}它保留**加粗的词**、*轻轻的强调*、\`行内代码\`和[一个链接](https://example.com/docs/${i})的样子。${zhSentence(i + 1, 11)}\n\n`;
  switch (kind) {
    case 0:
      return `${head}${para}- ${zhSentence(i + 2, 6)}\n- ${zhSentence(i + 3, 7)}\n- ${zhSentence(i + 4, 5)}\n\n`;
    case 1:
      return `${head}${para}\`\`\`ts\nexport function step${i}(shown: number, target: number): number {\n  // 最多显示已经来了的部分\n  const next = Math.min(target, shown + ${i + 3});\n  return next;\n}\n\`\`\`\n\n`;
    case 2:
      return `${head}${para}| 名称 | 大小 | 说明 |\n| --- | ---: | --- |\n| 甲-${i} | ${i * 3 + 1} | ${zhSentence(i, 3)} |\n| 乙-${i} | ${i * 5 + 2} | ${zhSentence(i + 1, 4)} |\n\n`;
    case 3:
      return `${head}${para}1. ${zhSentence(i + 5, 6)}\n2. ${zhSentence(i + 6, 5)}\n\n> ${zhSentence(i + 8, 9)}\n\n`;
    case 4:
      return `${head}${para}\`\`\`\n[${i}] 上传完成，等待下一次重试：文件已经清理\n[${i}] 第二次上传开始，没有发现新的错误\n\`\`\`\n\n`;
    default:
      // A long paragraph with no line break: one leaf of a few hundred characters.
      return `${head}${para}${zhSentence(i + 11, 40)}${zhSentence(i + 12, 40)}${zhSentence(i + 13, 40)}\n\n`;
  }
}

/** The Chinese reply of at least `chars` characters, the same for the same length (as longReply). */
export function longReplyZh(chars: number): string {
  let out = "";
  for (let i = 0; out.length < chars; i++) out += zhSection(i);
  return out.trimEnd();
}

/** Thinking text of at least `chars` characters: English or Chinese sentences, a paragraph break about every 200 characters. */
export function longThinking(chars: number, lang: "en" | "zh" = "en"): string {
  let out = "";
  let para = 0;
  for (let i = 0; out.length < chars; i++) {
    const s = lang === "zh" ? zhSentence(i, 9) : sentence(i, 12) + " ";
    out += s;
    para += s.length;
    if (para > 200) {
      out = out.trimEnd() + "\n\n";
      para = 0;
    }
  }
  return out.trimEnd();
}

/** The text of a message that asks the fake claude for a paced stream: about `chars` characters in `pieces` deltas, `ms` apart. */
export function pacedPrompt(chars: number, pieces: number, ms: number, thinking = false): string {
  return `fake-stream ${chars} ${pieces} ${ms}${thinking ? " thinking" : ""}`;
}

/** The fields of a paced-stream message, or null for any other text. */
export function pacedOf(text: string): { chars: number; pieces: number; ms: number; thinking: boolean } | null {
  const m = /(?:^|\s)fake-stream (\d{1,6}) (\d{1,5}) (\d{1,5})( thinking)?(?:\s|$)/.exec(text);
  if (!m) return null;
  const chars = Number(m[1]);
  const pieces = Math.max(1, Number(m[2]));
  const ms = Number(m[3]);
  return chars > 0 ? { chars, pieces, ms, thinking: !!m[4] } : null;
}
