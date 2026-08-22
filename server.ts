import express from 'express'
import app from './server/index.js'

// Vercel's Express detector looks for the framework import in the recognized
// root entrypoint; the application itself stays in server/index.ts for local use.
void express

export default app
