import { cp, copyFile, mkdir } from 'node:fs/promises'

await mkdir('public/assets', { recursive: true })
await cp('dist/assets', 'public/assets', { recursive: true, force: true })
await copyFile('dist/index.html', 'public/index.html')
