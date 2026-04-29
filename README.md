# onlineEdit

一个极简的在线共享文本页面。

## 功能

- 所有人打开同一个页面后看到的是同一份文本
- 修改会实时同步到其他已打开页面
- 不做任何本地或服务端持久化
- 当最后一个页面关闭后，文本自然消失

## 技术方案

- 纯静态页面，适合直接放在 GitHub Pages
- 前端通过 `mqtt.js` 连接公共 MQTT WebSocket broker
- 不依赖自建后端，也不做 retained message 持久化

## 本地查看

建议用任意静态文件服务打开当前目录，例如：

```bash
python3 -m http.server 4173
```
