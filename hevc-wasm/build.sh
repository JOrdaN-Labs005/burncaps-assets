#!/usr/bin/env bash
# Builds hevc-dec.js + hevc-dec.wasm from an unmodified FFmpeg release.
# Needs Emscripten on the PATH. FFmpeg is LGPL 2.1: no GPL part is enabled.
set -euo pipefail
FFMPEG_TAG=n8.0
here="$(cd "$(dirname "$0")" && pwd)"
work="${RUNNER_TEMP:-/tmp}/ffmpeg-$FFMPEG_TAG"
out="$here/out"
mkdir -p "$out"
[ -d "$work" ] || git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git "$work"
cd "$work"
emconfigure ./configure \
  --target-os=none --arch=wasm32 --enable-cross-compile \
  --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc --ar=emar --ranlib=emranlib --nm=emnm \
  --extra-cflags="-O3 -msimd128 -DNDEBUG" \
  --disable-everything --disable-autodetect --disable-programs --disable-doc --disable-debug \
  --disable-avdevice --disable-avformat --disable-avfilter --disable-swscale --disable-swresample \
  --disable-network --disable-pthreads --disable-w32threads --disable-os2threads \
  --disable-runtime-cpudetect --disable-stripping \
  --enable-decoder=hevc --enable-parser=hevc
echo "--- configure said"; grep -E "HAVE_SIMD128|CONFIG_HEVC_DECODER|CONFIG_GPL " config.h || true
emmake make -j"$(nproc)" libavcodec/libavcodec.a libavutil/libavutil.a
emcc "$here/hevcdec.c" -I. libavcodec/libavcodec.a libavutil/libavutil.a \
  -o "$out/hevc-dec.js" -O3 -msimd128 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createHevcDec -sENVIRONMENT=worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=1073741824 -sSTACK_SIZE=2097152 \
  -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 -sASSERTIONS=0 \
  -sEXPORTED_FUNCTIONS=_malloc,_free -sEXPORTED_RUNTIME_METHODS=HEAPU8
ls -la "$out"
