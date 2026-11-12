/**
 * 响应侧 thinking 内容注入/改写
 *
 * 规则约定：when.field === 'thinking' 的规则作用在响应回程上，操作语义按
 * "包裹模型"设计：
 * - prepend / set  ：仅作用于第一个 thinking 分片（头部注入一次）
 * - append         ：仅作用于最后一个 thinking 分片（尾部注入一次）
 * - replace / delete / insert_before / insert_after：逐分片查找型改写
 *
 * 覆盖两条同协议透传路径：
 * - SSE：对 content_block_delta.thinking_delta 事件处理，未命中块字节级透传；
 *   尾部注入通过"延迟一片发射"实现（thinking 分片要等到看到非 thinking 事件
 *   才能确认自己是最后一个）
 * - 非 SSE：对 content[] 中 type === 'thinking' 的块按 首/中/尾 分派规则
 */
import { Transform } from 'node:stream';
import { applyPromptRules } from './rules/engine.js';
import type { PromptxyRule, PromptxyOp } from './types.js';

type RuleCtx = { method: string; path: string; model?: string };

/** 是否存在启用的响应侧 thinking 规则（无规则时零开销直通） */
export function hasActiveThinkingRules(rules: PromptxyRule[] | undefined): boolean {
  if (!rules || rules.length === 0) return false;
  return rules.some(rule => rule.enabled !== false && rule.when.field === 'thinking');
}

function isHeadOp(op: PromptxyOp): boolean {
  return op.type === 'prepend' || op.type === 'set';
}

function isTailOp(op: PromptxyOp): boolean {
  return op.type === 'append';
}

/**
 * 为 thinking 规则生成四种分派形态：
 * first（头部+查找型）/ middle（仅查找型）/ last（查找型+尾部）/ both（全部，仅单片时）
 */
function buildDispatchRules(rules: PromptxyRule[]): {
  first: PromptxyRule[];
  middle: PromptxyRule[];
  last: PromptxyRule[];
  both: PromptxyRule[];
} {
  const first: PromptxyRule[] = [];
  const middle: PromptxyRule[] = [];
  const last: PromptxyRule[] = [];
  const both: PromptxyRule[] = [];

  for (const rule of rules) {
    if (rule.when.field !== 'thinking') continue;
    first.push({ ...rule, ops: rule.ops.filter(op => !isTailOp(op)) });
    middle.push({ ...rule, ops: rule.ops.filter(op => !isHeadOp(op) && !isTailOp(op)) });
    last.push({ ...rule, ops: rule.ops.filter(op => !isHeadOp(op)) });
    both.push(rule);
  }
  return { first, middle, last, both };
}

function rewriteThinkingText(text: string, rules: PromptxyRule[], ctx: RuleCtx): string {
  if (rules.length === 0) return text;
  try {
    return applyPromptRules(text, { ...ctx, client: 'claude', field: 'thinking' }, rules).text;
  } catch {
    // 单段改写失败时原样放行，避免中断整个响应流
    return text;
  }
}

/** 非 SSE：按 首/中/尾 分派改写 content[] 的 thinking 块，返回是否有改动 */
export function rewriteThinkingInJsonBody(body: any, rules: PromptxyRule[], ctx: RuleCtx): boolean {
  if (!body || typeof body !== 'object' || !Array.isArray(body.content)) return false;

  const { first, middle, last, both } = buildDispatchRules(rules);
  const indices: number[] = [];
  body.content.forEach((block: any, i: number) => {
    if (
      block &&
      typeof block === 'object' &&
      block.type === 'thinking' &&
      typeof block.thinking === 'string' &&
      block.thinking.length > 0
    ) {
      indices.push(i);
    }
  });

  let changed = false;
  indices.forEach((idx, pos) => {
    const ruleSet =
      indices.length === 1 ? both : pos === 0 ? first : pos === indices.length - 1 ? last : middle;
    const original = body.content[idx].thinking as string;
    const rewritten = rewriteThinkingText(original, ruleSet, ctx);
    if (rewritten !== original) {
      body.content[idx].thinking = rewritten;
      changed = true;
    }
  });
  return changed;
}

/** 尝试改写一条 SSE data 负载（JSON 字符串），返回新字符串或 undefined 表示未变 */
function rewriteDataLine(payload: string, rules: PromptxyRule[], ctx: RuleCtx): string | undefined {
  let obj: any;
  try {
    obj = JSON.parse(payload);
  } catch {
    return undefined;
  }

  let changed = false;

  // 流式 thinking 增量
  if (
    obj?.type === 'content_block_delta' &&
    obj?.delta?.type === 'thinking_delta' &&
    typeof obj?.delta?.thinking === 'string' &&
    obj.delta.thinking.length > 0
  ) {
    const rewritten = rewriteThinkingText(obj.delta.thinking, rules, ctx);
    if (rewritten !== obj.delta.thinking) {
      obj.delta.thinking = rewritten;
      changed = true;
    }
  }

  // 个别实现会在 content_block_start 内联初始 thinking 文本
  if (
    obj?.type === 'content_block_start' &&
    obj?.content_block?.type === 'thinking' &&
    typeof obj?.content_block?.thinking === 'string' &&
    obj.content_block.thinking.length > 0
  ) {
    const rewritten = rewriteThinkingText(obj.content_block.thinking, rules, ctx);
    if (rewritten !== obj.content_block.thinking) {
      obj.content_block.thinking = rewritten;
      changed = true;
    }
  }

  return changed ? JSON.stringify(obj) : undefined;
}

/** 改写单个 SSE 事件块：仅替换命中的 data: 行，其余行原样保留 */
function rewriteSseBlock(block: string, rules: PromptxyRule[], ctx: RuleCtx): string {
  // 快速预筛：不含 thinking 的块直接透传（绝大多数事件）
  if (!block.includes('thinking')) return block;

  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    const rewritten = rewriteDataLine(payload, rules, ctx);
    if (rewritten !== undefined) {
      lines[i] = `data: ${rewritten}`;
    }
  }
  return lines.join('\n');
}

function isThinkingDeltaBlock(block: string): boolean {
  return block.includes('"thinking_delta"');
}

/** 将事件块中的 thinking 文本清空（用于 set 整体替换后抑制同块后续分片） */
function blankThinkingBlock(block: string): string {
  if (!block.includes('thinking')) return block;
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      let changed = false;
      if (
        obj?.type === 'content_block_delta' &&
        obj?.delta?.type === 'thinking_delta' &&
        typeof obj?.delta?.thinking === 'string'
      ) {
        obj.delta.thinking = '';
        changed = true;
      }
      if (
        obj?.type === 'content_block_start' &&
        obj?.content_block?.type === 'thinking' &&
        typeof obj?.content_block?.thinking === 'string'
      ) {
        obj.content_block.thinking = '';
        changed = true;
      }
      if (changed) lines[i] = `data: ${JSON.stringify(obj)}`;
    } catch {
      // 非 JSON 负载原样保留
    }
  }
  return lines.join('\n');
}

/**
 * SSE Transform：按事件块（\n\n 分隔）缓冲改写。
 * thinking 分片延迟一片发射：看到非 thinking_delta 的后续事件时，才把上一片
 * 按"尾片"处理后发出。头部（prepend）全局只注入一次（第一个 thinking 分片），
 * 尾部（append）全局只注入一次（第一个 thinking 块的结束片）。
 */
export function createThinkingRewriteStream(rules: PromptxyRule[], ctx: RuleCtx): Transform {
  let buffer = '';
  let pending: string | null = null;
  let headApplied = false;
  let tailApplied = false;
  let suppressFirstBlockRest = false;
  const hasSetOp = rules.some(
    r => r.when.field === 'thinking' && r.enabled !== false && r.ops.some(op => op.type === 'set')
  );
  const { first, middle, last, both } = buildDispatchRules(rules);
  let out = '';

  function pickRules(isRunEnd: boolean): PromptxyRule[] {
    const useFirst = !headApplied;
    const useLast = isRunEnd && !tailApplied;
    if (useFirst && useLast) return both;
    if (useFirst) return first;
    if (useLast) return last;
    return middle;
  }

  function emitPending(isRunEnd: boolean): void {
    if (pending === null) return;
    if (suppressFirstBlockRest) {
      // set 已整体替换首片：同块后续分片全部清空，原文不外泄
      out += blankThinkingBlock(pending) + '\n\n';
      if (isRunEnd) suppressFirstBlockRest = false;
      pending = null;
      return;
    }
    const useFirst = !headApplied;
    const useLast = isRunEnd && !tailApplied;
    out += rewriteSseBlock(pending, pickRules(isRunEnd), ctx) + '\n\n';
    if (useFirst) {
      headApplied = true;
      if (hasSetOp) suppressFirstBlockRest = true;
    }
    if (useLast) tailApplied = true;
    if (isRunEnd) suppressFirstBlockRest = false;
    pending = null;
  }

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        buffer += chunk.toString('utf-8');

        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          if (isThinkingDeltaBlock(block)) {
            // 上一片仍在等待：现在来了新 thinking 片，说明上一片不是结尾
            emitPending(false);
            pending = block;
          } else if (block.includes('ping')) {
            // ping 心跳不是 thinking 块结束信号，直接透传（pending 继续持有）
            out += block + '\n\n';
          } else {
            // 非 thinking 事件（signature_delta / content_block_stop / 文本块等）：
            // pending 所在的 thinking 块到此结束，pending 即尾片
            emitPending(true);
            out += block + '\n\n';
          }
        }

        callback(null, out.length > 0 ? out : undefined);
        out = '';
      } catch {
        // 任何解析异常都不阻断响应
        callback(null, chunk);
      }
    },
    flush(callback) {
      emitPending(true);
      if (buffer.length > 0) {
        this.push(buffer);
        buffer = '';
      }
      callback();
    },
  });
}
