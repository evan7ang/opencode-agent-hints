# 证据

## 真网关抓包（脱敏）

`real-gateway-*.jsonl`：`bash e2e/real-gateway.sh` 通过
[`agent-hint-watcher`](../../../agent-hint-watcher) 透明中转真实网关得到的捕获。

已脱敏：只保留时间、路径、模型、wire 消息数、角色序列、hint 来源、解码后的 hint；
不含请求头凭据、提示词与响应体。会话 id 是随机 opaque 标识，本来就会随 opencode 自带的
`X-Session-Id` 头出现在线路上。

一次真实运行（deepseek-v4.1-flash）的时间线：

```text
#1  标题请求       hint=null                                          msgs=3
#2  主线           start   call=1 epoch=0 3/user_waiting  600s@2      msgs=2
#3  主线           append  call=2 epoch=0 1/critical_path  60s@4      msgs=4
#4  manage stop    compact? no: stop  call=2 epoch=0  evict            msgs=0   → HTTP 400（普通网关拒绝空 messages）
```

`msg_offset` 与 wire `messageCount` 逐条相等；`x-session-id` 与 hint 的 `session_id` 一致；
`X-Agent-Hint` 头被真实网关接受（主线请求均得到模型回复）。

## 脚本上游 e2e（可重复）

`bash e2e/run.sh all` 的四段抓包（`e2e/.tmp/<phase>/cap-*.jsonl`，不入库）：

```text
A1  #1 title(no hint)  #2 start c1 e0 3/uw 600s@2  #3 append c2 e0 1/cp 60s@4  #4 stop
A2  #1 resume c3        #2 append c3 e0 3/uw (suppressed)  #3 append c4 e0 1/cp 60s@8  #4 stop
B   #1 title  #2 A start c1  #3 title  #4 B start c1  #5 pause A c1  #6 resume A c2
    #7 A append c2 3/uw 60s@4  #8 pause B c1
C   #1 title  #2 start c1  #3 append c2  #4 compaction summary (no hint)
    #5 compact c2 e0  #6 append c2 e1 (suppressed)  #7 stop
D   #1 title  #2 start c1  #3 pause c1 (blur)  #4 resume c2 (focus)
```

真 TUI 检查（`python3 e2e/tui-check.py`）：在 pty 里启动真实 TUI、提交一条提示后，
服务端日志出现 `focus signal <id>`，退出时出现 `blur signal <id>`——证明 TUI part 通过回环通道
发送了真实信号。
