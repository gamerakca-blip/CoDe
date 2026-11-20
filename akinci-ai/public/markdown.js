// Küçük, güvenli Markdown işleyici: önce HTML kaçırılır, sonra sınırlı sözdizimi uygulanır.

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

function table(lines) {
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const head = cells(lines[0]);
  const rows = lines.slice(2).map(cells);
  return `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

export function renderMarkdown(src) {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(
        `<div class="codeblock"><div class="codeblock-head"><span>${esc(lang || "kod")}</span><button type="button" data-copy>Kopyala</button></div><pre><code>${esc(body.join("\n"))}</code></pre></div>`,
      );
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(h[1].length, 3);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) { out.push("<hr>"); i++; continue; }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+/.test(lines[i + 1])) {
      const block = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) block.push(lines[i++]);
      out.push(table(block));
      continue;
    }

    if (/^\s*>/.test(line)) {
      const block = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) block.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(block.join("\n"))}</blockquote>`);
      continue;
    }

    const listRe = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
    const li = line.match(listRe);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(listRe);
        if (m && /\d/.test(m[1]) === ordered) { items.push(m[2]); i++; }
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1] += " " + lines[i].trim(); i++; }
        else break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
      continue;
    }

    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !listRe.test(lines[i]) && !/^\s*>/.test(lines[i])
    ) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }

  return out.join("");
}
