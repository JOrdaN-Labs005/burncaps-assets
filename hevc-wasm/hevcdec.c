// The smallest wrapper round FFmpeg's HEVC decoder, compiled to WebAssembly for
// burncaps.app. It runs in the visitor's own browser, in a worker, as the last
// resort for an HEVC (H.265) video on a device whose hardware decoder refuses
// it: browsers have no software HEVC decoder of their own, so without this
// such a video cannot be exported on that device at all. Nothing leaves the
// browser. Built by build.sh from an unmodified FFmpeg release; FFmpeg is
// LGPL 2.1 (this build enables nothing under the GPL).
#include <emscripten/emscripten.h>
#include <stdint.h>
#include <string.h>
#include "libavcodec/avcodec.h"
#include "libavutil/common.h"
#include "libavutil/frame.h"
#include "libavutil/mem.h"
#include "libavutil/pixdesc.h"

static AVCodecContext *c = NULL;
static AVPacket *pkt = NULL;
static AVFrame *fr = NULL;

EMSCRIPTEN_KEEPALIVE void hd_close(void) {
  if (c) avcodec_free_context(&c);
  if (pkt) av_packet_free(&pkt);
  if (fr) av_frame_free(&fr);
}

// extra: the hvcC record (the bytes inside the MP4's hvcC box). 0, or negative.
EMSCRIPTEN_KEEPALIVE int hd_open(const uint8_t *extra, int size) {
  hd_close();
  const AVCodec *dec = avcodec_find_decoder(AV_CODEC_ID_HEVC);
  if (!dec) return -1000;
  c = avcodec_alloc_context3(dec);
  pkt = av_packet_alloc();
  fr = av_frame_alloc();
  if (!c || !pkt || !fr) return -1001;
  c->thread_count = 1;
  // A damaged picture is still a picture: one bad frame must not leave a hole.
  c->flags |= AV_CODEC_FLAG_OUTPUT_CORRUPT;
  if (extra && size > 0) {
    c->extradata = av_mallocz(size + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!c->extradata) return -1002;
    memcpy(c->extradata, extra, size);
    c->extradata_size = size;
  }
  return avcodec_open2(c, dec, NULL);
}

// One sample, as it is in the MP4 (length-prefixed NAL units). data NULL: the
// end of a run, every waiting picture comes out. 0, or negative.
EMSCRIPTEN_KEEPALIVE int hd_send(const uint8_t *data, int size, double pts, int key) {
  if (!data) return avcodec_send_packet(c, NULL);
  int r = av_new_packet(pkt, size);
  if (r < 0) return r;
  memcpy(pkt->data, data, size);
  pkt->pts = (int64_t)pts;
  if (key) pkt->flags |= AV_PKT_FLAG_KEY;
  r = avcodec_send_packet(c, pkt);
  av_packet_unref(pkt);
  return r;
}

// 1 a picture is ready, 0 none for now, negative an error.
EMSCRIPTEN_KEEPALIVE int hd_receive(void) {
  av_frame_unref(fr);
  int r = avcodec_receive_frame(c, fr);
  if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) return 0;
  return r < 0 ? r : 1;
}

// After a run ends the decoder starts afresh at the next key picture.
EMSCRIPTEN_KEEPALIVE void hd_reset(void) { avcodec_flush_buffers(c); }

EMSCRIPTEN_KEEPALIVE int hd_width(void) { return fr->width; }
EMSCRIPTEN_KEEPALIVE int hd_height(void) { return fr->height; }
EMSCRIPTEN_KEEPALIVE double hd_pts(void) { return (double)fr->pts; }
EMSCRIPTEN_KEEPALIVE int hd_full_range(void) { return fr->color_range == AVCOL_RANGE_JPEG; }
EMSCRIPTEN_KEEPALIVE int hd_primaries(void) { return fr->color_primaries; }
EMSCRIPTEN_KEEPALIVE int hd_transfer(void) { return fr->color_trc; }
EMSCRIPTEN_KEEPALIVE int hd_matrix(void) { return fr->colorspace; }
EMSCRIPTEN_KEEPALIVE int hd_size(void) {
  int cw = (fr->width + 1) >> 1, ch = (fr->height + 1) >> 1;
  return fr->width * fr->height + 2 * cw * ch;
}

static void plane(uint8_t *dst, int dw, int dh, const uint8_t *src, int stride, int sx, int sy, int depth) {
  for (int y = 0; y < dh; y++, dst += dw) {
    const uint8_t *line = src + y * sy * stride;
    if (depth == 8) {
      if (sx == 1) memcpy(dst, line, dw);
      else for (int x = 0; x < dw; x++) dst[x] = line[x * sx];
    } else {
      const uint16_t *l = (const uint16_t *)line;
      int down = depth - 8;
      for (int x = 0; x < dw; x++) dst[x] = (uint8_t)FFMIN(l[x * sx] >> down, 255);
    }
  }
}

// The picture as tightly packed 8-bit 4:2:0 (Y, then U, then V), whatever
// HEVC profile it came in. 0, or negative for a format it cannot read.
EMSCRIPTEN_KEEPALIVE int hd_i420(uint8_t *dst) {
  const AVPixFmtDescriptor *d = av_pix_fmt_desc_get(fr->format);
  if (!d || (d->flags & (AV_PIX_FMT_FLAG_RGB | AV_PIX_FMT_FLAG_PAL | AV_PIX_FMT_FLAG_FLOAT))) return -1003;
  if (d->comp[0].depth > 16 || !(d->flags & AV_PIX_FMT_FLAG_PLANAR || d->nb_components == 1)) return -1004;
  int w = fr->width, h = fr->height, cw = (w + 1) >> 1, ch = (h + 1) >> 1, depth = d->comp[0].depth;
  plane(dst, w, h, fr->data[0], fr->linesize[0], 1, 1, depth);
  uint8_t *u = dst + w * h, *v = u + cw * ch;
  if (d->nb_components < 3) { memset(u, 128, 2 * cw * ch); return 0; }
  int sx = 1 << (1 - d->log2_chroma_w), sy = 1 << (1 - d->log2_chroma_h);
  plane(u, cw, ch, fr->data[1], fr->linesize[1], sx, sy, depth);
  plane(v, cw, ch, fr->data[2], fr->linesize[2], sx, sy, depth);
  return 0;
}
