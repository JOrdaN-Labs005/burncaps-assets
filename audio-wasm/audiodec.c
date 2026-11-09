// The smallest wrapper round FFmpeg's sound decoders, compiled to WebAssembly
// for burncaps.app. It runs in the visitor's own browser, in a worker, as the
// last resort for a recording whose sound the device's own decoders will not
// read: a phone's AAC decoder can refuse a file its player opened, and
// browsers have no decoder of their own for AC-3, E-AC-3, ALAC or AMR. Nothing
// leaves the browser. Built by build.sh from an unmodified FFmpeg release;
// FFmpeg is LGPL 2.1 (this build enables nothing under the GPL).
#include <emscripten/emscripten.h>
#include <stdint.h>
#include <string.h>
#include "libavcodec/avcodec.h"
#include "libavutil/channel_layout.h"
#include "libavutil/common.h"
#include "libavutil/frame.h"
#include "libavutil/mem.h"
#include "libavutil/samplefmt.h"

static AVCodecContext *c = NULL;
static AVPacket *pkt = NULL;
static AVFrame *fr = NULL;

EMSCRIPTEN_KEEPALIVE void ad_close(void) {
  if (c) avcodec_free_context(&c);
  if (pkt) av_packet_free(&pkt);
  if (fr) av_frame_free(&fr);
}

// name: FFmpeg's decoder name. extra: the codec's setup bytes (for AAC the
// AudioSpecificConfig), or none. 0, or negative.
EMSCRIPTEN_KEEPALIVE int ad_open(const char *name, const uint8_t *extra, int size, int rate, int channels) {
  ad_close();
  const AVCodec *dec = avcodec_find_decoder_by_name(name);
  if (!dec) return -1000;
  c = avcodec_alloc_context3(dec);
  pkt = av_packet_alloc();
  fr = av_frame_alloc();
  if (!c || !pkt || !fr) return -1001;
  c->thread_count = 1;
  if (rate > 0) c->sample_rate = rate;
  if (channels > 0) av_channel_layout_default(&c->ch_layout, channels);
  if (extra && size > 0) {
    c->extradata = av_mallocz(size + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!c->extradata) return -1002;
    memcpy(c->extradata, extra, size);
    c->extradata_size = size;
  }
  return avcodec_open2(c, dec, NULL);
}

// One sample as it is in the file. data NULL: the end, all that is waiting
// comes out. 0, or negative.
EMSCRIPTEN_KEEPALIVE int ad_send(const uint8_t *data, int size) {
  if (!data) return avcodec_send_packet(c, NULL);
  int r = av_new_packet(pkt, size);
  if (r < 0) return r;
  memcpy(pkt->data, data, size);
  r = avcodec_send_packet(c, pkt);
  av_packet_unref(pkt);
  return r;
}

// 1 a block of sound is ready, 0 none for now, negative an error.
EMSCRIPTEN_KEEPALIVE int ad_receive(void) {
  av_frame_unref(fr);
  int r = avcodec_receive_frame(c, fr);
  if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) return 0;
  return r < 0 ? r : 1;
}

EMSCRIPTEN_KEEPALIVE int ad_samples(void) { return fr->nb_samples; }
EMSCRIPTEN_KEEPALIVE int ad_rate(void) { return fr->sample_rate; }
EMSCRIPTEN_KEEPALIVE int ad_channels(void) { return fr->ch_layout.nb_channels; }

static float one(const uint8_t *p, int i, enum AVSampleFormat f) {
  switch (f) {
    case AV_SAMPLE_FMT_U8: return (p[i] - 128) / 128.f;
    case AV_SAMPLE_FMT_S16: return ((const int16_t *)p)[i] / 32768.f;
    case AV_SAMPLE_FMT_S32: return ((const int32_t *)p)[i] / 2147483648.f;
    case AV_SAMPLE_FMT_S64: return (float)(((const int64_t *)p)[i] / 9223372036854775808.0);
    case AV_SAMPLE_FMT_FLT: return ((const float *)p)[i];
    case AV_SAMPLE_FMT_DBL: return (float)((const double *)p)[i];
    default: return 0;
  }
}

// The block as mono 32-bit float, every channel averaged. dst holds
// ad_samples() floats. 0, or negative for a format it cannot read.
EMSCRIPTEN_KEEPALIVE int ad_mono(float *dst) {
  int n = fr->nb_samples, ch = fr->ch_layout.nb_channels;
  if (n <= 0 || ch <= 0) return -1003;
  enum AVSampleFormat f = fr->format;
  int planar = av_sample_fmt_is_planar(f);
  enum AVSampleFormat base = av_get_packed_sample_fmt(f);
  if (base == AV_SAMPLE_FMT_NONE) return -1004;
  for (int i = 0; i < n; i++) {
    float v = 0;
    for (int k = 0; k < ch; k++) v += planar ? one(fr->extended_data[k], i, base) : one(fr->extended_data[0], i * ch + k, base);
    dst[i] = v / ch;
  }
  return 0;
}
