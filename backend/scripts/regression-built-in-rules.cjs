/**
 * 内置三条规则的回归测试（不依赖 vitest，直接用编译产物）
 *
 * 规则一 px-devtest-system        请求侧 system 锚定 replace 追加 Spec
 * 规则二 px-devtest-thinking      响应侧 thinking 头部 prepend 完整 Spec
 * 规则三 px-cc-agent-safety-strip 请求侧 system 删除安全条款整段
 *
 * 运行：node scripts/regression-built-in-rules.js
 */
const fs = require('fs');
const path = require('path');
const { Transform } = require('node:stream');
const { mutateClaudeBody } = require('../dist/promptxy/adapters/claude.js');
const {
  rewriteThinkingInJsonBody,
  createThinkingRewriteStream,
} = require('../dist/promptxy/response-thinking.js');

const configPath = path.resolve(__dirname, '../../promptxy.config.json');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const rules = cfg.rules;

const CLAUSE =
  'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.';
const SPEC_HEAD = '# Assistant Operating Specification';
const ANCHOR = "You are Claude Code, Anthropic's official CLI for Claude.";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/** 构造典型 CC 2.1.296 请求体（system 三块） */
function ccBody() {
  return {
    model: 'glm-4.7',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296.4ac; cc_entrypoint=cli;' },
      { type: 'text', text: ANCHOR, cache_control: { type: 'ephemeral' } },
      {
        type: 'text',
        text: `You are an agent working with the user toward their goals, using your own judgment along the way.\n\n${CLAUSE}\n\n# Harness\n - Text you output outside of tool use is displayed to the user.`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  };
}

const ctx = { method: 'POST', path: '/v1/messages', model: 'glm-4.7' };

// ---------------------------------------------------------------- 请求侧
console.log('\n== 请求侧：规则一（system 注入）+ 规则三（删除安全条款）==');

{
  const body = ccBody();
  const { body: out, matches } = mutateClaudeBody({ body: { ...body, system: JSON.parse(JSON.stringify(body.system)) }, method: 'POST', path: '/v1/messages', rules });

  const ids = new Set(matches.map(m => m.ruleId));
  check('规则一+三均命中', ids.has('px-devtest-system') && ids.has('px-cc-agent-safety-strip'));

  const sys = out.system;
  check('规则一：system[1] 追加完整 Spec', sys[1].text.startsWith(ANCHOR) && sys[1].text.includes(SPEC_HEAD) && sys[1].text.length > ANCHOR.length + 20000);
  check('规则一：Spec 以 18 节收尾', sys[1].text.trimEnd().endsWith('is by definition the residue and is discarded.'));
  check('规则一：system[0] billing 块原样', sys[0].text === body.system[0].text);

  check('规则三：system[2] 安全条款已删除', !sys[2].text.includes('IMPORTANT: Assist with'));
  check('规则三：删除后空行结构完好', /along the way\.\n\n# Harness/.test(sys[2].text));
  check('规则三：agent 提示词其余内容保留', sys[2].text.includes('You are an agent working with the user') && sys[2].text.includes('# Harness'));
  check('规则三：cache_control 标记保留', sys[2].cache_control && sys[2].cache_control.type === 'ephemeral');
}

{
  // 无安全条款的请求（子代理/旧版形状）：规则三应 no-op，规则一不受影响
  const body = ccBody();
  body.system.pop();
  const { body: out } = mutateClaudeBody({ body, method: 'POST', path: '/v1/messages', rules });
  check('无条款请求：规则一仍生效', out.system[1].text.includes(SPEC_HEAD));
  check('无条款请求：无第三块不受影响', out.system.length === 2);
}

{
  // system 为纯字符串（非数组）形状
  const body = { model: 'glm-4.7', system: `${ANCHOR}\n\n${CLAUSE}\n\n# Harness`, messages: [] };
  const { body: out } = mutateClaudeBody({ body, method: 'POST', path: '/v1/messages', rules });
  check('system 字符串形状：Spec 注入 + 条款删除同时生效', out.system.includes(SPEC_HEAD) && !out.system.includes('IMPORTANT: Assist with'));
}

{
  // 规则匹配面：pathRegex 为子串匹配，count_tokens 也命中（预期行为：
  // token 计数应反映改写后的请求体，避免 CC 低估上下文占用）
  const body = ccBody();
  const { body: out } = mutateClaudeBody({ body, method: 'POST', path: '/v1/messages/count_tokens', rules });
  check('count_tokens 路径：规则同样生效（计数与真实请求一致）', out.system[1].text.includes(SPEC_HEAD) && !out.system[2].text.includes('IMPORTANT: Assist with'));
}

// ---------------------------------------------------------------- 响应侧非 SSE
console.log('\n== 响应侧非 SSE：规则二（thinking 头部注入）==');

{
  // 单 thinking 块
  const res = {
    content: [
      { type: 'thinking', thinking: 'Let me analyze the request.\nStep 1: read files.', signature: 'sig1' },
      { type: 'text', text: 'answer' },
    ],
  };
  const changed = rewriteThinkingInJsonBody(res, rules, ctx);
  const t = res.content[0].thinking;
  check('非 SSE：命中改写', changed === true);
  check('非 SSE：Spec 注入在头部', t.startsWith(SPEC_HEAD));
  check('非 SSE：原生思考完整保留', t.trimEnd().endsWith('Step 1: read files.'));
  check('非 SSE：注入恰好一次', t.split(SPEC_HEAD).length === 2);
  check('非 SSE：text 块不受影响', res.content[1].text === 'answer');
}

{
  // 多 thinking 块：prepend 只进首块
  const res = {
    content: [
      { type: 'thinking', thinking: 'first run of thought' },
      { type: 'thinking', thinking: 'second run of thought' },
      { type: 'text', text: 'answer' },
    ],
  };
  rewriteThinkingInJsonBody(res, rules, ctx);
  check('多 thinking 块：仅首块注入', res.content[0].thinking.includes(SPEC_HEAD) && !res.content[1].thinking.includes(SPEC_HEAD));
  check('多 thinking 块：两块原生思考保留', res.content[0].thinking.endsWith('first run of thought') && res.content[1].thinking === 'second run of thought');
}

// ---------------------------------------------------------------- 响应侧 SSE
async function main() {
console.log('\n== 响应侧 SSE：规则二（thinking 流式注入）==');

function sse(blocks) {
  return blocks.map(b => (typeof b === 'string' ? b : `data: ${JSON.stringify(b)}`)).join('\n\n') + '\n\n';
}
function collect(stream, input) {
  return new Promise(resolve => {
    let out = '';
    stream.on('data', c => (out += c.toString()));
    stream.on('end', () => resolve(out));
    stream.end(input);
  });
}

{
  // 三片 thinking + 结束事件 + 文本块
  const input = sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'chunk A. ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'chunk B. ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'chunk C.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 's' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'final answer' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_stop' },
  ]);

  const out = await collect(createThinkingRewriteStream(rules, ctx), input);
  const deltas = [...out.matchAll(/data: (.+)/g)].map(m => m[1]).map(s => { try { return JSON.parse(s); } catch { return null; } });

  const thinkingChunks = deltas.filter(d => d?.delta?.type === 'thinking_delta').map(d => d.delta.thinking);
  check('SSE：thinking 分片数量不变', thinkingChunks.length === 3);
  check('SSE：Spec 注入首片头部', thinkingChunks[0].startsWith(SPEC_HEAD));
  check('SSE：首片原生内容保留', thinkingChunks[0].trimEnd().endsWith('chunk A.'));
  check('SSE：中尾分片原样', thinkingChunks[1] === 'chunk B. ' && thinkingChunks[2] === 'chunk C.');
  check('SSE：注入恰好一次', out.split(SPEC_HEAD).length === 2);
  const textDelta = deltas.find(d => d?.delta?.type === 'text_delta');
  check('SSE：文本块不受影响', textDelta && textDelta.delta.text === 'final answer');
  const sigIdx = deltas.findIndex(d => d?.delta?.type === 'signature_delta');
  const stopIdx = deltas.findIndex(d => d?.type === 'content_block_stop');
  check('SSE：事件顺序保持', sigIdx !== -1 && stopIdx > sigIdx);
}

{
  // 无 thinking 的纯文本响应：完全透传
  const input = sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'plain' } },
    { type: 'message_stop' },
  ]);
  const out = await collect(createThinkingRewriteStream(rules, ctx), input);
  check('SSE：无 thinking 响应零改动透传', out === input);
}

{
  // ping 心跳穿插：pending 不被误判为尾片
  const input = sse([
    'event: ping\ndata: {"type":"ping"}',
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'chunk 1. ' } },
    'event: ping\ndata: {"type":"ping"}',
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'chunk 2.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]);
  const out = await collect(createThinkingRewriteStream(rules, ctx), input);
  const thinkingChunks = [...out.matchAll(/data: (.+)/g)].map(m => m[1]).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(d => d?.delta?.type === 'thinking_delta').map(d => d.delta.thinking);
  check('SSE+ping：两片均保留且仅首片注入', thinkingChunks.length === 2 && thinkingChunks[0].includes(SPEC_HEAD) && thinkingChunks[1] === 'chunk 2.');
  check('SSE+ping：ping 事件原样保留', (out.match(/"type":"ping"/g) || []).length === 2);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
