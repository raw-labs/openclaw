import type { MarkdownIt, Token } from "markdown-it";
import type { ControlUiTextReference } from "../../../src/plugin-sdk/control-ui.js";
import type { MarkdownRenderEnv } from "./markdown-render-options.ts";

/** Formatting may lend prose context; code, links, images, and breaks cannot. */
function proseRuns(children: readonly Token[]) {
  const runs: { text: string; tokens: { token: Token; start: number; end: number }[] }[] = [];
  let run: (typeof runs)[number] | undefined;
  let linkDepth = 0;
  for (const token of children) {
    if (token.type === "link_open") {
      linkDepth++;
    } else if (token.type === "link_close") {
      linkDepth = Math.max(0, linkDepth - 1);
    }
    if (!linkDepth && token.type === "text") {
      if (!run) {
        runs.push((run = { text: "", tokens: [] }));
      }
      const start = run.text.length;
      run.text += token.content;
      run.tokens.push({ token, start, end: run.text.length });
    } else if (!/^(?:em|strong)_(?:open|close)$/.test(token.type)) {
      run = undefined;
    }
  }
  return runs;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

export function installMarkdownTextReferences(parser: MarkdownIt): void {
  parser.core.ruler.before("web-link-classes", "plugin-text-references", (state) => {
    // SAFETY: markdown.ts supplies normalized render options to markdown-it's untyped env.
    const providers = (state.env as Partial<MarkdownRenderEnv> | undefined)?.textReferences ?? [];
    if (!providers.length) {
      return;
    }
    let heading = false;
    for (const block of state.tokens) {
      if (block.type === "heading_open") {
        heading = true;
      } else if (block.type === "heading_close") {
        heading = false;
      }
      const children = block.children;
      if (heading || block.type !== "inline" || !children) {
        continue;
      }
      const links = children.flatMap((token) => {
        const href = token.type === "link_open" ? token.attrGet("href") : null;
        return typeof href === "string" && href ? [href] : [];
      });
      const replacements = new Map<
        Token,
        { start: number; end: number; value: ControlUiTextReference }[]
      >();
      for (const run of proseRuns(children)) {
        const candidates: {
          segment: (typeof run.tokens)[number];
          value: ControlUiTextReference;
        }[] = [];
        for (const provider of providers) {
          for (const value of provider.resolve({ text: run.text, links }).slice(0, 256)) {
            if (
              !Number.isInteger(value.start) ||
              !Number.isInteger(value.end) ||
              value.start < 0 ||
              value.end <= value.start ||
              value.end > run.text.length ||
              splitsSurrogatePair(run.text, value.start) ||
              splitsSurrogatePair(run.text, value.end) ||
              (value.label !== undefined &&
                (value.label.length > 200 || /[\r\n]/.test(value.label)))
            ) {
              continue;
            }
            // A link must fit one text token. Transparent emphasis still supplies context.
            const segment = run.tokens.find(
              ({ start, end }) => value.start >= start && value.end <= end,
            );
            if (!segment) {
              continue;
            }
            candidates.push({ segment, value });
          }
        }
        for (const candidate of candidates) {
          const { segment, value } = candidate;
          if (
            candidates.some(
              (other) =>
                other !== candidate &&
                value.start < other.value.end &&
                value.end > other.value.start,
            )
          ) {
            continue;
          }
          const values = replacements.get(segment.token) ?? [];
          values.push({
            start: value.start - segment.start,
            end: value.end - segment.start,
            value,
          });
          replacements.set(segment.token, values);
        }
      }
      for (let index = children.length - 1; index >= 0; index--) {
        const token = children[index]!;
        const values = replacements.get(token)?.toSorted((a, b) => a.start - b.start);
        if (!values?.length) {
          continue;
        }
        const tokens: Token[] = [];
        const text = (content: string) => {
          if (!content) {
            return;
          }
          const value = new state.Token("text", "", 0);
          value.content = content;
          tokens.push(value);
        };
        let cursor = 0;
        for (const { start, end, value } of values) {
          text(token.content.slice(cursor, start));
          const open = new state.Token("link_open", "a", 1);
          open.attrSet("href", value.url);
          tokens.push(open);
          text(value.label ?? token.content.slice(start, end));
          tokens.push(new state.Token("link_close", "a", -1));
          cursor = end;
        }
        text(token.content.slice(cursor));
        children.splice(index, 1, ...tokens);
      }
    }
  });
}
