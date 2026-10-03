// 邮件 HTML 的元素定位引擎。
//
// 思路：一次扫描同时产出
//   1) 每个元素在原源码里的精确字符范围（records）
//   2) 注入了 data-edm-el 的预览 HTML（previewHtml）
// 预览里元素带上的序号与 records 下标一一对应，因此在 sandbox iframe 里点击
// 任何节点都能准确回到源码位置，不需要用 outerHTML 反查（重复片段会出错）。
//
// 预览阶段会移除 <script> 与 on* 事件属性，仅影响预览，不改动用户源码。

export type SourceRange = { start: number; end: number };

export type AttrRecord = {
  name: string;
  /** 属性名起始位置 */
  nameStart: number;
  /** 引号内的原始值范围 */
  valueStart: number;
  valueEnd: number;
  quote: '"' | "'" | '';
};

export type ElementRecord = {
  index: number;
  tag: string;
  /** 开始标签 '<' 的位置 */
  start: number;
  /** 元素整体结束位置（含结束标签） */
  end: number;
  /** 开始标签 '>' 之后的位置 */
  openEnd: number;
  /** 结束标签 '<' 的位置；没有结束标签时为 null */
  closeStart: number | null;
  selfClosing: boolean;
  attrs: AttrRecord[];
  /** 直接文本子节点的范围（不含子元素内部的内容） */
  textSegments: SourceRange[];
  parentIndex: number | null;
  depth: number;
};

export type AnalyzeResult = {
  records: ElementRecord[];
  previewHtml: string;
  stripped: { scripts: number; eventAttrs: number };
};

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** 内容不会被当作标签解析的元素 */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

/**
 * 预览 CSP：没有 script-src，模板脚本一律不执行；同时禁止表单提交、内嵌框架与远程字体。
 * iframe 沙箱使用 allow-same-origin 且不开 allow-scripts：
 * 宿主能读取 contentDocument 绑定事件，但模板里的任何脚本都没有执行机会。
 */
export const PREVIEW_SANDBOX = 'allow-same-origin';
export const PREVIEW_CSP =
  "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; font-src data:; media-src * data:; form-action 'none'; base-uri 'none'";

const EVENT_ATTR_RE = /^on/i;

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

/** 扫描 HTML，得到元素范围；preview=true 时同时生成预览 HTML */
export function analyzeHtml(html: string, opts: { preview?: boolean } = {}): AnalyzeResult {
  const preview = opts.preview === true;
  const records: ElementRecord[] = [];
  const stack: ElementRecord[] = [];
  const out: string[] = [];
  const stripped = { scripts: 0, eventAttrs: 0 };
  const n = html.length;
  let lastEmit = 0;
  let i = 0;

  const addText = (from: number, to: number) => {
    if (to <= from) return;
    const parent = stack[stack.length - 1];
    if (!parent) return;
    const seg = parent.textSegments[parent.textSegments.length - 1];
    if (seg && seg.end === from) seg.end = to;
    else parent.textSegments.push({ start: from, end: to });
  };

  const closeElement = (name: string, closeStart: number, after: number) => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].tag === name) {
        const rec = stack[k];
        rec.closeStart = closeStart;
        rec.end = after;
        // 中间未闭合的元素随之一并收尾，避免把它们误算到后面的兄弟节点
        for (let j = stack.length - 1; j > k; j--) stack[j].end = closeStart;
        stack.length = k;
        return;
      }
    }
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      addText(i, n);
      i = n;
      break;
    }
    if (lt > i) {
      addText(i, lt);
      i = lt;
    }

    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (html.startsWith('</', i)) {
      const gt = html.indexOf('>', i);
      const stop = gt === -1 ? n : gt + 1;
      const name = html
        .slice(i + 2, gt === -1 ? n : gt)
        .trim()
        .toLowerCase()
        .split(/\s/)[0];
      if (name) closeElement(name, i, stop);
      i = stop;
      continue;
    }

    const m = /^<([A-Za-z][^\s/>]*)/.exec(html.slice(i));
    if (!m) {
      addText(i, i + 1);
      i += 1;
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs: AttrRecord[] = [];
    let selfClosing = false;
    let openEnd = -1;
    let p = i + 1 + m[1].length;

    while (p < n) {
      while (p < n && isSpace(html[p])) p++;
      if (p >= n) break;
      const ch = html[p];
      if (ch === '>') {
        openEnd = p + 1;
        break;
      }
      if (ch === '/') {
        if (html[p + 1] === '>') {
          selfClosing = true;
          openEnd = p + 2;
          break;
        }
        p++;
        continue;
      }
      const nameStart = p;
      while (p < n && !isSpace(html[p]) && html[p] !== '=' && html[p] !== '>' && html[p] !== '/') p++;
      const name = html.slice(nameStart, p);
      if (!name) {
        p++;
        continue;
      }
      let q = p;
      while (q < n && isSpace(html[q])) q++;
      if (html[q] !== '=') {
        attrs.push({ name, nameStart, valueStart: p, valueEnd: p, quote: '' });
        continue;
      }
      q++;
      while (q < n && isSpace(html[q])) q++;
      let valueStart: number;
      let valueEnd: number;
      let quote: AttrRecord['quote'] = '';
      if (html[q] === '"' || html[q] === "'") {
        quote = html[q] as '"' | "'";
        valueStart = q + 1;
        const close = html.indexOf(quote, valueStart);
        valueEnd = close === -1 ? n : close;
        p = close === -1 ? n : close + 1;
      } else {
        valueStart = q;
        while (q < n && !isSpace(html[q]) && html[q] !== '>') q++;
        valueEnd = q;
        p = q;
      }
      attrs.push({ name, nameStart, valueStart, valueEnd, quote });
    }

    if (openEnd === -1) openEnd = n;
    const isVoid = VOID_TAGS.has(tag) || selfClosing;
    const rec: ElementRecord = {
      index: records.length,
      tag,
      start: i,
      end: openEnd,
      openEnd,
      closeStart: null,
      selfClosing: isVoid,
      attrs,
      textSegments: [],
      parentIndex: stack.length ? stack[stack.length - 1].index : null,
      depth: stack.length,
    };
    records.push(rec);

    // 原始文本元素：内容到对应的结束标签为止
    let contentEnd = openEnd;
    let elementEnd = openEnd;
    if (RAW_TEXT_TAGS.has(tag) && !isVoid) {
      const closeIdx = findRawTextEnd(html, tag, openEnd);
      contentEnd = closeIdx === -1 ? n : closeIdx;
      elementEnd = closeIdx === -1 ? n : closeIdx + tag.length + 3;
      rec.closeStart = closeIdx === -1 ? null : closeIdx;
      rec.end = elementEnd;
      if (tag === 'title' || tag === 'textarea') {
        // 可编辑的纯文本内容
        rec.textSegments.push({ start: openEnd, end: contentEnd });
      }
    }

    if (preview) {
      const drop = tag === 'script';
      if (drop) {
        // 连同内容整段删除，否则脚本会被原样写进预览
        out.push(html.slice(lastEmit, i));
        lastEmit = elementEnd;
        stripped.scripts++;
      } else {
        out.push(html.slice(lastEmit, i));
        out.push(rewriteStartTag(html, i, openEnd, rec, stripped));
        // 只发出了改写后的开始标签；原始文本内容留给下一轮 slice 发出，
        // 否则 <style>/<title> 的正文会被整段丢掉。
        lastEmit = openEnd;
      }
    }

    if (isVoid) {
      i = openEnd;
      continue;
    }
    if (RAW_TEXT_TAGS.has(tag)) {
      i = elementEnd;
      continue;
    }
    stack.push(rec);
    i = openEnd;
  }

  if (preview) {
    out.push(html.slice(lastEmit));
    return { records, previewHtml: wrapPreview(out.join('')), stripped };
  }
  return { records, previewHtml: '', stripped };
}

/** 找到原始文本元素的结束标签位置（'<' 的下标），找不到返回 -1 */
function findRawTextEnd(html: string, tag: string, from: number): number {
  const re = new RegExp(`</${tag}\\s*>`, 'gi');
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index : -1;
}

/** 把开始标签改写成带 data-edm-el 的形式，并顺手去掉 on* 事件属性 */
function rewriteStartTag(html: string, start: number, openEnd: number, rec: ElementRecord, stripped: { eventAttrs: number }): string {
  const closing = html.slice(openEnd - 2, openEnd) === '/>' ? '/>' : '>';
  const body = html.slice(start, openEnd - closing.length);
  let rebuilt = body;
  for (const a of [...rec.attrs].sort((x, y) => y.nameStart - x.nameStart)) {
    if (!EVENT_ATTR_RE.test(a.name)) continue;
    stripped.eventAttrs++;
    const from = a.nameStart - start;
    const to = findAttrEnd(body, from);
    rebuilt = rebuilt.slice(0, from) + rebuilt.slice(to);
  }
  return `${rebuilt} data-edm-el="${rec.index}"${closing}`;
}

/** 从属性名起点找到属性结束（引号之后），用于删除属性 */
function findAttrEnd(body: string, from: number): number {
  let p = from;
  while (p < body.length && !isSpace(body[p]) && body[p] !== '=') p++;
  while (p < body.length && isSpace(body[p])) p++;
  if (body[p] !== '=') return p;
  p++;
  while (p < body.length && isSpace(body[p])) p++;
  if (body[p] === '"' || body[p] === "'") {
    const close = body.indexOf(body[p], p + 1);
    return close === -1 ? body.length : close + 1;
  }
  while (p < body.length && !isSpace(body[p])) p++;
  return p;
}

function wrapPreview(inner: string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><base target="_blank">`;
  if (/<head[\s>]/i.test(inner)) return inner.replace(/<head([^>]*)>/i, (m) => `${m}${head}`);
  if (/<html[\s>]/i.test(inner)) return inner.replace(/(<html[^>]*>)/i, `$1<head>${head}</head>`);
  return `${head}${inner}`;
}

// ---------- 源码改写 ----------

export function replaceRange(html: string, range: SourceRange, replacement: string): string {
  return html.slice(0, range.start) + replacement + html.slice(range.end);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function getAttribute(html: string, el: ElementRecord, name: string): string | null {
  const a = el.attrs.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!a) return null;
  return decodeEntities(html.slice(a.valueStart, a.valueEnd));
}

export type AttrPatch = { name: string; value: string };

/** 改写或插入属性，返回新的完整 HTML */
export function setAttributes(html: string, el: ElementRecord, patches: AttrPatch[]): string {
  const edits: { from: number; to: number; text: string }[] = [];
  const inserts: AttrPatch[] = [];
  for (const patch of patches) {
    const a = el.attrs.find((x) => x.name.toLowerCase() === patch.name.toLowerCase());
    if (!a) {
      inserts.push(patch);
      continue;
    }
    const escaped = escapeHtml(patch.value);
    // 范围从引号内部开始，因此替换文本必须自带结尾引号，否则会写出 src=""新值"
    const text = a.quote ? `${escaped}${a.quote}` : `"${escaped}"`;
    edits.push({ from: a.valueStart, to: a.valueEnd + (a.quote ? 1 : 0), text });
  }
  // 从后往前改，保证前面的偏移仍然有效
  let out = html;
  for (const e of edits.sort((x, y) => y.from - x.from)) {
    out = out.slice(0, e.from) + e.text + out.slice(e.to);
  }
  if (inserts.length) {
    const list = inserts.map((p) => ` ${p.name}="${escapeHtml(p.value)}"`).join('');
    out = out.slice(0, el.openEnd - 1) + list + out.slice(el.openEnd - 1);
  }
  return out;
}

export function setTextSegment(html: string, seg: SourceRange, text: string): string {
  return replaceRange(html, seg, escapeHtml(text));
}

/** 元素内可以直接编辑的文本片段（忽略纯空白） */
export function editableTextSegments(html: string, el: ElementRecord): { index: number; range: SourceRange; text: string }[] {
  return el.textSegments
    .map((range, index) => ({ index, range, text: decodeEntities(html.slice(range.start, range.end)) }))
    .filter((s) => s.text.trim().length > 0);
}

/** 元素可编辑的文本内容；含嵌套子元素时返回 null，提示用户改用源码编辑 */
export function simpleTextOf(html: string, el: ElementRecord): string | null {
  if (el.textSegments.length === 0) return null;
  return decodeEntities(html.slice(el.textSegments[0].start, el.textSegments[el.textSegments.length - 1].end));
}

export function elementLabel(html: string, el: ElementRecord): string {
  const idOrClass = getAttribute(html, el, 'class') || getAttribute(html, el, 'id');
  const text = simpleTextOf(html, el)?.trim().slice(0, 40);
  return `<${el.tag}${idOrClass ? ' .' + idOrClass.split(/\s+/)[0] : ''}>${text ? ' ' + text : ''}`;
}

/** 行号 + 列号，供源码定位提示 */
export function lineOf(html: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = 0;
  for (let i = 0; i < offset && i < html.length; i++) {
    if (html[i] === '\n') {
      line++;
      last = i + 1;
    }
  }
  return { line, column: offset - last + 1 };
}