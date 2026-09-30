# Multi Search Engine

## 基本信息

- **名称**: multi-search-engine
- **版本**: v2.0.1
- **描述**: 集成17个搜索引擎（8国内+9国际），支持高级搜索语法
- **发布时间**: 2026-02-06

## 搜索引擎

**国内（8个）**: 百度、必应、360、搜狗、微信、头条、集思录
**国际（9个）**: Google、DuckDuckGo、Yahoo、Brave、Startpage、Ecosia、Qwant、WolframAlpha

## 核心功能

- 高级搜索操作符（site:, filetype:, intitle:等）
- DuckDuckGo Bangs快捷命令
- 时间筛选（小时/天/周/月/年）
- 隐私保护搜索
- WolframAlpha知识计算

## 更新记录

### v2.0.1 (2026-02-06)
- 精简文档，优化发布

### v2.0.0 (2026-02-06)
- 新增9个国际搜索引擎
- 强化深度搜索能力

### v1.0.0 (2026-02-04)
- 初始版本：8个国内搜索引擎

## 使用示例

```javascript
// Google搜索
web_fetch({"url": "https://www.google.com/search?q=python"})

// 隐私搜索
web_fetch({"url": "https://duckduckgo.com/html/?q=privacy"})

// 站内搜索
web_fetch({"url": "https://www.google.com/search?q=site:github.com+python"})
```

MIT License

> ⚠️ **版权人待确认**：本文件此前只有「MIT License」这一行，既没有许可正文，
> 也没有版权署名，同目录下也没有 LICENSE 文件。下方按 MIT 标准文本补齐正文；
> 署名一栏在确认来源方之前保留为「待确认」，不臆造权利主体。确认后请替换该行。

Copyright (c) 版权人待确认

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
