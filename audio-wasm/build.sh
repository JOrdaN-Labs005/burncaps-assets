#!/usr/bin/env bash
# Builds audio-dec.js + audio-dec.wasm from an unmodified FFmpeg release.
# Needs Emscripten on the PATH. FFmpeg is LGPL 2.1: no GPL part is enabled.
set -euo pipefail
FFMPEG_TAG=n8.0
here="$(cd "$(dirname "$0")" && pwd)"
work="${RUNNER_TEMP:-/tmp}/ffmpeg-audio-$FFMPEG_TAG"
out="$here/out"
mkdir -p "$out"
[ -d "$work" ] || git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git "$work"
cd "$work"
emconfigure ./configure \
  --target-os=none --arch=wasm32 --enable-cross-compile \
  --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc --ar=emar --ranlib=emranlib --nm=emnm \
  --extra-cflags="-O3 -DNDEBUG" \
  --disable-everything --disable-autodetect --disable-programs --disable-doc --disable-debug \
  --disable-avdevice --disable-avformat --disable-avfilter --disable-swscale --disable-swresample \
  --disable-network --disable-pthreads --disable-w32threads --disable-os2threads \
  --disable-runtime-cpudetect --disable-stripping \
  --enable-decoder=aac,aac_latm,mp3float,mp2float,ac3,eac3,alac,flac,amrnb,amrwb,adpcm_ima_qt,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be,pcm_u8,pcm_alaw,pcm_mulaw
echo "--- configure said"; grep -E "CONFIG_AAC_DECODER|CONFIG_AC3_DECODER|CONFIG_GPL " config.h || true
emmake make -j"$(nproc)" libavcodec/libavcodec.a libavutil/libavutil.a
emcc "$here/audiodec.c" -I. libavcodec/libavcodec.a libavutil/libavutil.a \
  -o "$out/audio-dec.js" -O3 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createAudioDec -sENVIRONMENT=worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sMAXIMUM_MEMORY=268435456 -sSTACK_SIZE=1048576 \
  -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 -sASSERTIONS=0 \
  -sEXPORTED_FUNCTIONS=_malloc,_free -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32,stringToUTF8,lengthBytesUTF8
ls -la "$out"
