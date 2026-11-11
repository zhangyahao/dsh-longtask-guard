# dsh-longtask-guard

DeepSeek Harness 的长任务护栏插件：**把臃肿的会话历史外化到文件，把看不见的推理捞回正文**。

长任务跑到几百步时，两个问题会一起出现：上下文越来越大、模型开始把整段分析写进 reasoning 而正文留空；一旦上游把这种回合判成「退化」，回合直接中止，界面上只剩一条错误，你既看不到结论，也不知道模型当时分析了什么。

这个插件针对这两点：

- **上下文外化**：请求发出前检查消息总量，超阈值就把早期超长消息正文收缩成一行索引，原文归档到项目 `.dsh-task/archive/`；
- **空正文救援**：监听会话事件，正文为空、分析全在 reasoning 的回合，自动落盘到 `.dsh-task/reasoning/`，并在回合结束时补一条可见的摘录消息。

## 为什么需要它

用真实长会话来举例（某 165 回合、约 7 MB 的会话日志）：

- 641 条 assistant 消息里，**602 条把内容写在 reasoning 块里**；
- 其中 **364 条正文为空**——这些回合在界面上的观感就是「模型想了一堆，但什么都没给你」；
- 某次长任务的第 165、166 回合，15 016 字符和 2 977 字符的分析全部落在 reasoning，正文只有一行 `❌ stream error: the turn degenerated again after the continuation nudge`。

reasoning 本身不是没落盘，只是默认折叠在界面里。插件做的事就是：把这段内容挪到你能直接看到的地方，并且把超大消息的正文换成文件索引，让上下文别再涨。

## 安装

需要 DSH 0.2.x。把仓库 clone 到本地任意目录，然后用 DSH 的插件管理器安装（`target` 填该目录的绝对路径）：

```powershell
git clone https://github.com/zhangyahao/dsh-longtask-guard.git
# 然后在会话里：
plugin_manager(action="install_bundle", target="<克隆目录的绝对路径>")
# 重启 DSH 生效
```

卸载：`plugin_manager(action="remove_bundle", target="dsh-longtask-guard")`。

## 配置

`cordis.patch.yml` 默认值：

```yaml
config:
  enabled: true
  externalizeAtChars: 600000    # 消息总字符超过它才外化（约 15 万 token）
  keepRecentMessages: 40        # 最近 40 条消息不动
  archiveDir: .dsh-task/archive # 相对会话工作目录；工作目录不可用时落 $DSH_HOME
  minMessageChars: 1200         # 单条消息至少这么长才值得收缩
  cooldownMessages: 60          # 两次收缩之间至少间隔的消息条数
  captureReasoning: true        # 是否做空正文救援
  minReasoningChars: 400        # reasoning 至少这么长才救援
  minTextChars: 20              # 正文短于这个长度视为「空正文」
  reasoningDir: .dsh-task/reasoning
  appendSummary: true           # 救援时是否往会话里补一条可见消息
  summaryExcerptChars: 2400     # 补发消息里摘录的长度上限
```

配置与统计持久化在 `$DSH_HOME/data/longtask-guard.json`，重启后保留。

**归档位置怎么定**（按会话目录走）：依次尝试 `agent.session.header.cwd`、`session.cwd`、`workingDirectory` 服务、`workspaceRegistry` 按 sessionId 反查；拿到就落在**该会话工作目录**下的 `.dsh-task/`（例如 `D:\ceyearnplm\.dsh-task\`、`D:\DeepSeek Harness\.dsh-task\`）。`$DSH_PROFILE_DIR`（形如 `...\profiles\desktop`）会被显式跳过——那是 DSH 的配置目录不是项目，归档落进去会变成孤儿文件；全都拿不到时才兜底 `$DSH_HOME`。`longtask_status` 会直接打印解析后的绝对路径。

## 工具

| 工具 | 用途 |
| --- | --- |
| `longtask_status` | 阈值、保留窗口、本次运行的收缩与救援统计 |
| `longtask_externalize` | 手动登记一次外化（`force: true` 绕过冷却） |
| `longtask_handoff` | 把进度写成交接文件 `.dsh-task/handoff-<时间>.md` |
| `longtask_reasoning` | 列出 / 读取救援归档的 reasoning 文件 |

工具不是必须的——外化与救援都在插件里自动运行，工具只是查看和手动干预的入口。

## 工作方式

### 外化

- 只收缩 `assistant` 与工具结果消息，**不动 user 消息**；单条不足 `minMessageChars` 的不收缩。
- 收缩后形如：`[ctx-externalized] #12 首行摘要…｜全文 15382 字符：<归档路径>`。
- 消息条数与结构不变（只改 `content`），不破坏下游对消息 id 的引用。
- 两次收缩之间至少间隔 `cooldownMessages` 条消息，避免每轮都动历史、破坏上游 prompt 缓存。

### 救援

- 判定：一条 assistant 消息的 `reasoning` 长度 ≥ `minReasoningChars`，且正文 `text` 长度 < `minTextChars`。
- 动作：回合结束时（`turn/end`）把 reasoning 写进 `.dsh-task/reasoning/turn-<回合>-<时间>.md`，再用 `session.append` 补一条可见消息：

  ```
  ⚠️ 上一轮正文为空，分析只写在了 reasoning 里（共 15382 字符），已归档到：
  D:\...\.dsh-task\reasoning\turn-165-2026-11-10T11-10-01.md

  —— 以下是这段分析的原文摘录 ——
  ……

  （完整内容读上面那个文件；直接回复「继续」即可从这份分析接着往下走。）
  ```

- 补发用的是宿主接受的消息结构（`message` + compact `stream`），失败会静默跳过、只保留归档。

## 与上下文压缩插件的关系

本插件**不替代**压缩插件（例如 billion-context）：

- 压缩插件负责「token 总量」：按范围折叠成摘要块、可还原、可搜索；
- 本插件负责「单条消息体积」和「内容可见性」：把超大正文换成文件索引、把空正文回合的推理捞回正文。

两者可以并存，建议把本插件的 `externalizeAtChars` 设得比压缩插件的触发点高一些，只在压缩管不到的单条超大消息上动手。

## 已知边界

- 上游的「退化回合中止」是过程逻辑，没有配置开关；本插件只能降低触发概率并在发生后把内容找回来，不能保证一定不发生。
- 外化会改变历史消息正文，**动过的那一轮上游 prompt 缓存会失效**，这是有意的取舍。
- 救援补发的消息在界面上是一条普通 assistant 消息，会进入历史；不需要时把 `appendSummary` 设为 false。
- 只处理消息正文；图片等非文本块原样保留。
- 救援依赖 `session/event` 与 `session.append` 两个宿主能力；宿主版本不提供时，只有外化生效。

## License

MIT
