# audio-wasm

FFmpeg's sound decoders (n8.0, LGPL 2.1, nothing under the GPL) compiled to WebAssembly for burncaps.app.
It is the last resort when a device's own decoders will not read a recording's sound. It runs in the visitor's
browser, in a worker; nothing leaves the browser. `build.sh` needs Emscripten; the workflow
`audio-wasm.yml` builds it on GitHub, run by hand, and keeps `out/` as the artifact.
