# session-bus

[English](./README.md) | **简体中文**

**你和 AI 的对话是项目资产,不该在换应用时丢掉。**

session-bus 是一条本地优先的"会话总线":它发现各 AI 应用(OpenAI Codex、Claude Cowork……)本来就写在你磁盘上的会话日志,翻译成统一格式、**按项目**归组存档,再回灌给任何一个 agent——既可以生成蒸馏后的交接文档,也可以作为 MCP 服务被 agent 在干活途中随时查询。

在 Codex 里开始一个项目,换到 Claude Cowork 继续。新 agent 知道之前说过什么、决定过什么、还剩什么没做——需要时还能逐字引用当时的原话。

```
 Codex ~/.codex/sessions/*.jsonl ─┐                ┌─ HANDOFF.md   (冷启动注入)
 Cowork 本地会话 ─────────────────┼→ 统一格式存档    ┼─ MCP 服务     (按需检索:
 (更多适配器开发中) ───────────────┘   ~/.sbus/       │   list_projects / list_sessions /
                                                    │   get_handoff / get_session /
                                                    └──  search_sessions)
```

## 为什么做这个

文件系统已经让各 AI 应用共享了"结果",但"过程"——为什么这么做、试过什么被否了、你提过哪些约束——被锁在每个应用的私有会话存储里。换应用(或者想用新模型开新会话)等于过程知识清零。session-bus 把过程变成可携带的资产。

三条设计承诺:

1. **本地优先。** 任何数据不出你的电脑;存档只是同一块磁盘上的派生缓存。
2. **只读采集。** 永不写入各应用的私有目录,对它们零风险,也不怕它们升级。
3. **可逆压缩。** 交接文档分三档蒸馏(brief/standard/full),但逐字历史永远只差一次 MCP 调用——不像应用内的上下文压缩,这里没有任何不可恢复的丢失。

## 安装(开发预览)

```bash
git clone <repo> && cd session-bus
npm install && npm run build && npm link
sbus scan        # 收录会话(增量、只读)
sbus ls          # 项目 → 会话清单
sbus handoff <项目> [--level brief|standard|full] [-o HANDOFF.md]
sbus search <关键词>
sbus mcp         # 启动 MCP 服务(stdio)
```

## 接入你的 agent

每个应用一条命令——自动改写对应配置文件(原文件备份为 `*.bak`),使用绝对路径,GUI 应用无需 shell PATH:

```bash
sbus setup cowork --apply   # Claude Cowork / Claude Desktop,改完后完全退出重启应用
sbus setup codex --apply    # Codex CLI/桌面端/IDE
sbus setup claude-code      # 打印 `claude mcp add` 命令
```

(去掉 `--apply` 则只打印配置片段,自己手动编辑。)

然后直接说人话:**"接着 Codex 在这个项目上的进度继续做。"**

## 当前状态

v0.1(MVP),已在真实数据上完成双向验收:Cowork 新会话通过 `get_handoff` 冷启动接手 Codex 项目,全程未向用户重复提问即继续工作;Codex 会话通过 MCP 精确回答"Cowork 接手后做了什么"。验证数据包含 60+ 真实会话、单个 199 MB 的超大会话、多次上下文压缩与跨天会话。

核心组件:Codex + Cowork 适配器 · 项目为中心的存档 · 三档交接文档 · 5 工具 MCP 服务(查询前自动增量刷新)· 输出脱敏 · 一条命令接入(`--apply`)。

路线图:Claude Code 与 Gemini CLI 适配器 → SessionStart hook 自动注入 → watch 模式 → 聊天应用(ChatGPT/Claude.ai)导出包导入 →(实验性)原生格式写回。

## 支持的数据源

| 来源 | 读取位置 | 状态 |
|---|---|---|
| OpenAI Codex(CLI/桌面端/IDE) | `~/.codex/sessions/**/rollout-*.jsonl` | ✅ |
| Claude Cowork | `…/Claude/local-agent-mode-sessions/**`(元数据 + 内部 Claude Code 格式转录;项目归属取自挂载文件夹) | ✅ |
| Claude Code | `~/.claude/projects/**.jsonl`(与 Cowork 共用解析器) | 计划中(近乎免费) |
| Gemini CLI | `~/.gemini/tmp/**` | 计划中 |

说明:Codex 的 `reasoning`(思考过程)由厂商加密,无法也无需读取;`.jsonl.zst` 压缩会话已识别、v0.2 解析;各应用会话格式均无官方文档且可能随版本变化,解析器刻意宽松(未知字段忽略、坏行计数不致命)。

## 隐私

会话里可能有密钥等敏感信息。session-bus 不上传任何东西;所有离开存档的内容(交接文档、MCP 响应)都会自动对常见凭据模式(API key、token、JWT、私钥)打码。

## 协议

MIT
