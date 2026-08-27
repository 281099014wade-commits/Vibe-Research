# App 图标

`icon.icns` 由 `icon.png`（1024×1024 母图）生成，母图另存一份在 `../assets/icon-source.png`。

**图案**：五根 K 线摆成一个 V，朱橙 `#F35D2B` 落在深蓝黑 `#0A0F1A` 的 macOS 圆角方上。

选它的理由只有一条能验证的：**在 Dock 的 16×16 下仍看得出是 K 线**。图标最终就是那么大被看见，
好不好看是次要的，认不认得出是首要的。

## 重新生成

```bash
# 母图放到 build/icon.png（1024×1024），然后：
IS=build/icon.iconset; mkdir -p "$IS"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "$IS/icon_${s}x${s}.png"
  sips -z $((s*2)) $((s*2)) build/icon.png --out "$IS/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$IS" -o build/icon.icns
```

## 换图标前先做这件事

把候选缩到 **16 / 32 / 128** 三档摆在一起看，再决定。做过四轮候选，
失败的那些无一例外都是**大图漂亮、缩小成一团泥** —— 显微镜、浑天仪、棱镜、多层卡片
都栽在同一点：一个剪影里叠了三层以上的结构，缩小后互相吃掉。

⚠️ 出图交给 `codex-image-gen`（不要自己用 HTML 排版截图）。给它简报时：
构图、材质、光影**交给它**；「必须是一个整体剪影、要在指甲盖大小活下来」这条**要明说** ——
这不是限制创意，是这个交付物的功能要求。两边任何一头偏了都会出废稿（两轮实证）。
