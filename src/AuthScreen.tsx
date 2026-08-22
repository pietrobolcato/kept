import { useState, type FormEvent } from 'react'
import { ArrowRight, Check, Eye, EyeOff, Image as ImageIcon, Link2, LoaderCircle, LockKeyhole, Search, Sparkles } from 'lucide-react'
import { supabase, supabaseConfigured } from './lib/supabase'

type Mode = 'login' | 'signup'

function AuthLogo() {
  return <div className="auth-brand" aria-label="Kept"><span><i /><i /><i /></span><strong>kept</strong></div>
}

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const changeMode = (next: Mode) => {
    setMode(next)
    setError('')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabaseConfigured) {
      setError('Supabase is not configured in this environment yet.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      if (mode === 'signup') {
        const { data, error: signUpError } = await supabase.auth.signUp({ email: email.trim(), password })
        if (signUpError) throw signUpError
        if (!data.session) throw new Error('This Supabase project still requires email confirmation. Disable Confirm email in Authentication settings.')
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (signInError) throw signInError
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Authentication failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-story" aria-label="About Kept">
        <AuthLogo />
        <div className="auth-story-copy">
          <p className="eyebrow">Your visual memory</p>
          <h1>Everything worth finding again.</h1>
          <p>Save the things that catch your eye. Kept understands them, organises them, and brings them back when you need them.</p>
        </div>
        <div className="auth-memory-stack" aria-hidden="true">
          <div className="auth-memory-card card-one"><span><ImageIcon size={14} /> HOME IDEAS</span><strong>Warm oak reading corner</strong><small>interior · furniture · calm</small></div>
          <div className="auth-memory-card card-two"><span><Link2 size={14} /> DESIGN</span><strong>Interfaces with texture</strong><small>editorial · tactile · web</small></div>
          <div className="auth-search-pill"><Search size={16} /><span>soft green sofa</span><em>92% match</em></div>
        </div>
        <p className="auth-private"><LockKeyhole size={13} /> Private by design · each library is isolated</p>
      </section>

      <section className="auth-access">
        <div className="auth-mobile-brand"><AuthLogo /></div>
        <div className="auth-form-wrap">
          <div className="auth-orbit"><Sparkles size={21} /><i /></div>
          <p className="eyebrow">Personal space</p>
          <h2>{mode === 'login' ? 'Welcome back.' : 'Start your library.'}</h2>
          <p className="auth-subtitle">{mode === 'login' ? 'Sign in to everything you’ve kept.' : 'One private place for links, images, and ideas.'}</p>

          <div className="auth-mode" role="tablist" aria-label="Authentication mode">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => changeMode('login')}>Log in</button>
            <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'active' : ''} onClick={() => changeMode('signup')}>Create account</button>
          </div>

          <form className="auth-form" onSubmit={(event) => void submit(event)}>
            <label><span>Email</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
            <label><span>Password</span><div className="auth-password"><input type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'} /><button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
            {mode === 'signup' && <p className="auth-password-note"><Check size={12} /> No email confirmation required</p>}
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button className="auth-submit" type="submit" disabled={submitting || !email.trim() || password.length < 8}>{submitting ? <><LoaderCircle className="spin" size={16} /> {mode === 'login' ? 'Signing in…' : 'Creating your space…'}</> : <>{mode === 'login' ? 'Enter Kept' : 'Create my space'} <ArrowRight size={16} /></>}</button>
          </form>
          <p className="auth-footnote">Internal access · password authentication</p>
        </div>
      </section>
    </main>
  )
}

export function AuthLoading() {
  return <main className="auth-loading"><AuthLogo /><div><span /><span /><span /></div><p>Opening your library…</p></main>
}
