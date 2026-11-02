# 为什么 Chrome 不认 `--load-extension`

> 这是兼容性记录，不是绕过方法。结论是：**日常安装请走 `chrome://extensions`**，
> 命令行参数只在自动化测试里用 Chrome for Testing。

## 背景

Google 从 Chrome 137 起不再支持 `--load-extension`，142 又把临时开关
`DisableLoadExtensionCommandLineSwitch` 一并移除。官方意图是：正式版 Chrome 只允许
通过 Web Store 或 `chrome://extensions` 手动加载扩展。

## 实测（2026-11，本机）

| 浏览器 | 参数 | 结果 |
|---|---|---|
| Google Chrome 156（正式版） | `--load-extension` | ❌ 静默忽略，无任何报错 |
| Google Chrome 156 | 再加 `--disable-features=DisableLoadExtensionCommandLineSwitch` | ❌ 仍然忽略（开关已被移除） |
| Chrome for Testing 148 | `--load-extension` | ✅ 正常加载 |
| Chrome for Testing 148 | 同上 + 开关 | ✅ |

## 怎么判断被静默忽略了

正式版 Chrome 不会报错。检查 `/json/list`（远程调试端口）里有没有你自己的扩展目标：

```bash
# 只有 Chrome 自带扩展的 id 出现 = 你的扩展没加载
curl -s 127.0.0.1:9222/json/list | grep chrome-extension
```

另一个干扰项：`--disable-extensions-except` 会在日志里留下
`not allowed in Google Chrome, ignoring`，容易被误读成 `--load-extension` 的问题。

## 结论

- **日常使用**：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序。不受任何影响。
- **自动化测试**：用 Chrome for Testing 或 Chromium，`--load-extension` 仍然可用。
- 正式版 Chrome 想恢复命令行加载：目前没有受支持的方式。
