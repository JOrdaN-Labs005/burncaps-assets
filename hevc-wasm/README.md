# Software HEVC reader for burncaps.app

`hevcdec.c` is a small wrapper round FFmpeg's HEVC decoder. `build.sh` compiles it to WebAssembly from an unmodified FFmpeg release, and the workflow `.github/workflows/hevc-wasm.yml` runs that build.

It runs in the visitor's own browser, as the last resort for an HEVC (H.265) video on a device whose hardware decoder refuses it. The video never leaves the browser.

FFmpeg (https://ffmpeg.org) is licensed under the LGPL 2.1, and no GPL part is enabled in this build. The complete source is the FFmpeg release named in `build.sh` plus the wrapper here, so the WebAssembly can be rebuilt or modified and replaced.
