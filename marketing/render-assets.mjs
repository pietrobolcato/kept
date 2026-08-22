#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = pathToFileURL(join(root, 'marketing', 'promo.html')).href
const frames = join(root, 'output', 'marketing')
const media = join(root, 'docs', 'media')
mkdirSync(frames, { recursive: true })
mkdirSync(media, { recursive: true })

function screenshot(scene, width, height, output) {
  execFileSync('npx', [
    '--yes', 'playwright@latest', 'screenshot', '--browser', 'chromium',
    '--viewport-size', `${width},${height}`, '--wait-for-timeout', '250',
    `${source}?scene=${scene}`, output,
  ], { stdio: 'inherit' })
}

const scenes = ['cover', 'capture', 'search', 'assistant', 'share', 'end']
for (const scene of scenes) screenshot(scene, 1920, 1080, join(frames, `${scene}.png`))
screenshot('cover', 1920, 1080, join(media, 'kept-hero.png'))
screenshot('cover', 1280, 640, join(media, 'kept-og.png'))
screenshot('square', 1080, 1080, join(media, 'kept-social-square.png'))
screenshot('story', 1080, 1920, join(media, 'kept-social-story.png'))

const ffmpegInputs = scenes.flatMap((scene) => ['-loop', '1', '-t', '2.8', '-i', join(frames, `${scene}.png`)])
const filters = scenes.map((_, index) => {
  const direction = index % 2 === 0 ? `(iw-1920)*t/2.8` : `(iw-1920)*(1-t/2.8)`
  return `[${index}:v]scale=1980:1114,crop=1920:1080:x='${direction}':y=17,setsar=1,fps=30[v${index}]`
})
filters.push('[v0][v1]xfade=transition=fade:duration=0.5:offset=2.3[x1]')
filters.push('[x1][v2]xfade=transition=fade:duration=0.5:offset=4.6[x2]')
filters.push('[x2][v3]xfade=transition=fade:duration=0.5:offset=6.9[x3]')
filters.push('[x3][v4]xfade=transition=fade:duration=0.5:offset=9.2[x4]')
filters.push('[x4][v5]xfade=transition=fade:duration=0.5:offset=11.5[out]')

execFileSync('ffmpeg', [
  '-y', ...ffmpegInputs, '-filter_complex', filters.join(';'), '-map', '[out]',
  '-t', '14.3', '-r', '30', '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(media, 'kept-promo.mp4'),
], { stdio: 'inherit' })

execFileSync('ffmpeg', [
  '-y', '-ss', '0.2', '-i', join(media, 'kept-promo.mp4'), '-frames:v', '1',
  '-update', '1', '-q:v', '2', join(media, 'kept-promo-poster.jpg'),
], { stdio: 'inherit' })

console.log(`Rendered campaign assets to ${media}`)
