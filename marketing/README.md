# Kept campaign kit

The campaign is built from reusable HTML/CSS rather than flattened design files. It uses fictional demo memories only; no personal library data or provider credentials are involved.

## Render

Requirements: Node.js 20+, `npx`, Chromium available to Playwright, and FFmpeg with H.264 support.

```bash
npm run marketing:render
```

The command renders six 1920×1080 scenes, four public still formats, and a 14.3-second silent H.264 promotional video. Intermediate frames live under ignored `output/marketing/`; publishable assets live in `docs/media/`.

The video is intentionally silent for muted autoplay and easy soundtrack replacement. All copy and layouts are editable in `promo.html`.

## Generated campaign image

`source/collection-hero.jpg` was made with the built-in image-generation workflow, then converted to an efficient project-local JPEG.

Prompt:

> Premium photorealistic editorial still life of a sculptural cream modular sofa, postmodern chrome table lamp, dark walnut design book, and compact modernist coastal-house model in a warm off-white gallery interior; late-afternoon light, warm ivory/charcoal/walnut/muted olive palette, one tiny acid-lime accent; landscape composition with calm negative space; no people, brands, logos, typography, or watermark.

The three additional visual memories are fictional demo assets already included in `public/images/`.
