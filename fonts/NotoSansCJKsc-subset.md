# Noto Sans CJK SC subset

`NotoSansCJKsc-subset.otf` is the fallback face for this app's Chinese text. The PocketJS build
reads `../fonts.json`, which lists this font as a fallback and `cjk-charset.txt` as a
character file, so every listed character is baked into the app's font atlases from this face.

- Source: [NotoSansCJKsc-Regular.otf](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf)
  at commit `f8d157532fbfaeda587e826d4cd5b21a49186f7c`.
- Source SHA-256: `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b` (16437364 bytes).
- Characters: 2482 (the characters of this app's text that Inter does not map).
- Subset size: 668196 bytes.

Each glyph keeps the source advance width and outline at the source units per em, and the
font keeps the source ascender and descender, so baked advances match the full font.
Hinting and OpenType layout tables are not carried over.

Regenerate after the app's text changes (the source font is downloaded once and cached):

```sh
bun tools/cjk-font.ts --app=<app dir> [--scan=<project file> ...]
```

Add `--check` to verify, without network access, that the committed subset covers the text.

The font is licensed under the SIL Open Font License 1.1; the copyright notice and the
license text are in `LICENSE-NotoSansCJK.txt`. `../pak.json` ships that file inside the app's pak
as `license:NotoSansCJK.txt`, and the web and desktop packaging tools copy it beside the build.
The subset is a Modified Version under that license and is renamed "Noto Sans CJK SC Subset".
