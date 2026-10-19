import { useRef, useState } from 'react'
import { formatDuration, useCountdown } from '@shared/ui/time'
import { ErrorAlert } from '../components/ui'

const EMPTY_DETAILS = {
  entryNumber: '',
  name: '',
  email: '',
  department: '',
  programme: '',
  password: ''
}

// Converts a server timestamp into a local deadline using the server's clock.
function localDeadline(at, serverTime) {
  return Date.now() + (new Date(at).getTime() - new Date(serverTime).getTime())
}

/** Student sign-in and registration (with email OTP verification). */
export default function StudentAuth({ api, onSignedIn }) {
  const [mode, setMode] = useState('login')
  const [loginPrefill, setLoginPrefill] = useState('')

  return (
    <div className="auth">
      <div className="auth-card">
        <div>
          <h1>{mode === 'login' ? 'Student sign in' : 'Create your library account'}</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            {mode === 'login'
              ? 'Use your IIT Delhi email or entry number.'
              : 'We will email a verification code to your IIT Delhi address.'}
          </p>
        </div>
        <div className="segmented" role="tablist">
          {[
            ['login', 'Sign in'],
            ['register', 'Register']
          ].map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? 'is-on' : ''}
              onClick={() => setMode(m)}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === 'login' ? (
          <LoginForm api={api} onSignedIn={onSignedIn} prefill={loginPrefill} />
        ) : (
          <RegisterFlow
            api={api}
            onGoToSignIn={(email) => {
              setLoginPrefill(email)
              setMode('login')
            }}
          />
        )}
      </div>
    </div>
  )
}

function LoginForm({ api, onSignedIn, prefill }) {
  const [identifier, setIdentifier] = useState(prefill)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!api || busy) return
    setBusy(true)
    setError(null)
    try {
      const data = await api.post('/api/auth/login', { identifier, password })
      onSignedIn({ token: data.token, user: data.student })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel form" onSubmit={submit}>
      <label className="field">
        Email or entry number
        <input
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          autoComplete="username"
          required
        />
      </label>
      <label className="field">
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <ErrorAlert error={error} />
      <button className="btn btn-block" type="submit" disabled={busy || !api}>
        {busy ? 'Please wait…' : 'Sign in'}
      </button>
    </form>
  )
}

/**
 * Registration steps:
 *   details -> (send code) -> code -> (verify, then create account) -> done
 * The account is only created by the server after the code is verified; the
 * registration token it returns is bound to the verified email.
 */
function RegisterFlow({ api, onGoToSignIn }) {
  const [step, setStep] = useState('details')
  const [details, setDetails] = useState(EMPTY_DETAILS)
  const [otpInfo, setOtpInfo] = useState(null) // { email, emailMasked, expiresDeadline, resendDeadline }
  const [code, setCode] = useState('')
  const [token, setToken] = useState(null) // { email, registrationToken }
  const [busy, setBusy] = useState(null) // 'send' | 'verify' | 'resend' | null
  const [error, setError] = useState(null)
  const inFlight = useRef(false)

  const set = (k) => (e) => setDetails((d) => ({ ...d, [k]: e.target.value }))
  const normalizedEmail = details.email.trim().toLowerCase()

  async function run(kind, fn) {
    if (inFlight.current || !api) return
    inFlight.current = true
    setBusy(kind)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err)
      if (err.code === 'OTP_COOLDOWN' && err.details?.retryAfterSeconds) {
        const resendDeadline = Date.now() + err.details.retryAfterSeconds * 1000
        setOtpInfo((o) => (o ? { ...o, resendDeadline } : o))
      }
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  async function sendCode() {
    const r = await api.post('/api/auth/register/request-otp', { email: details.email })
    setOtpInfo({
      email: r.email,
      emailMasked: r.emailMasked,
      expiresDeadline: localDeadline(r.expiresAt, r.serverTime),
      resendDeadline: localDeadline(r.resendAvailableAt, r.serverTime)
    })
    setCode('')
    setToken(null)
    setStep('code')
  }

  async function createAccount(registrationToken) {
    await api.post('/api/auth/register', { ...details, registrationToken })
    setStep('done')
  }

  function onDetailsSubmit(e) {
    e.preventDefault()
    // Already verified this exact email (e.g. after fixing another field): no new code needed.
    if (token && token.email === normalizedEmail) {
      run('send', () => createAccount(token.registrationToken))
    } else {
      run('send', sendCode)
    }
  }

  function onVerify(e) {
    e.preventDefault()
    run('verify', async () => {
      const v = await api.post('/api/auth/register/verify-otp', {
        email: otpInfo.email,
        otp: code
      })
      setToken({ email: v.email, registrationToken: v.registrationToken })
      try {
        await createAccount(v.registrationToken)
      } catch (err) {
        // Verified, but the details were rejected (e.g. entry number already used).
        // Return to the form; the verification stays valid for this email.
        setStep('details')
        throw err
      }
    })
  }

  if (step === 'done') {
    return (
      <div className="panel success-panel" role="status">
        <h2 style={{ fontSize: 17 }}>Account created</h2>
        <p className="muted">
          Your email was verified and your library account is ready. Sign in with your email or
          entry number and the password you chose.
        </p>
        <button className="btn" onClick={() => onGoToSignIn(normalizedEmail)}>
          Go to sign in
        </button>
      </div>
    )
  }

  if (step === 'code') {
    return (
      <CodeStep
        otpInfo={otpInfo}
        code={code}
        setCode={setCode}
        busy={busy}
        error={error}
        onVerify={onVerify}
        onResend={() => run('resend', sendCode)}
        onChangeEmail={() => {
          setStep('details')
          setOtpInfo(null)
          setCode('')
          setError(null)
        }}
      />
    )
  }

  const verified = token && token.email === normalizedEmail
  return (
    <form className="panel form" onSubmit={onDetailsSubmit}>
      <div className="form-grid">
        <label className="field">
          Entry number
          <input
            value={details.entryNumber}
            onChange={set('entryNumber')}
            placeholder="2021CS10123"
            required
          />
        </label>
        <label className="field">
          Full name
          <input value={details.name} onChange={set('name')} autoComplete="name" required />
        </label>
      </div>
      <label className="field">
        IIT Delhi email
        <input
          type="email"
          value={details.email}
          onChange={set('email')}
          autoComplete="email"
          required
        />
        {verified && <span className="field-hint">Verified ✓</span>}
      </label>
      <div className="form-grid">
        <label className="field">
          Department
          <input value={details.department} onChange={set('department')} required />
        </label>
        <label className="field">
          Programme
          <input
            value={details.programme}
            onChange={set('programme')}
            placeholder="B.Tech"
            required
          />
        </label>
      </div>
      <label className="field">
        Password
        <span className="field-hint">At least 8 characters.</span>
        <input
          type="password"
          value={details.password}
          onChange={set('password')}
          autoComplete="new-password"
          minLength={8}
          required
        />
      </label>
      <ErrorAlert error={error} />
      <button className="btn btn-block" type="submit" disabled={Boolean(busy) || !api}>
        {busy ? 'Please wait…' : verified ? 'Create account' : 'Send verification code'}
      </button>
    </form>
  )
}

function CodeStep({ otpInfo, code, setCode, busy, error, onVerify, onResend, onChangeEmail }) {
  const resendIn = useCountdown(otpInfo.resendDeadline, 3600)
  const expiresIn = useCountdown(otpInfo.expiresDeadline, 3600)
  const expired = expiresIn === 0
  const attemptsLeft = error?.code === 'OTP_INVALID' ? error.details?.attemptsRemaining : null

  return (
    <form className="panel form" onSubmit={onVerify}>
      <div>
        <h2 style={{ fontSize: 15 }}>Check your email</h2>
        <p className="muted" style={{ marginTop: 4 }}>
          We sent a 6-digit code to <strong>{otpInfo.emailMasked}</strong>.
        </p>
      </div>
      <label className="field">
        Verification code
        <input
          className="otp-input"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          aria-describedby="otp-meta"
          required
        />
      </label>
      <div className="otp-meta" id="otp-meta">
        <span>
          {expired ? 'Code expired' : `Expires in ${formatDuration((expiresIn ?? 0) * 1000)}`}
        </span>
        <button
          type="button"
          className="link-btn"
          onClick={onResend}
          disabled={Boolean(busy) || (resendIn ?? 0) > 0}
        >
          {busy === 'resend'
            ? 'Sending…'
            : resendIn > 0
              ? `Resend code in ${resendIn}s`
              : 'Resend code'}
        </button>
      </div>
      {error && (
        <div className="alert" role="alert">
          {error.message}
          {attemptsLeft != null && ` ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left.`}
          {Array.isArray(error.details) && (
            <ul>
              {error.details.map((d) => (
                <li key={d.path + d.message}>{d.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <button
        className="btn btn-block"
        type="submit"
        disabled={Boolean(busy) || code.length !== 6 || expired}
      >
        {busy === 'verify' ? 'Verifying…' : 'Verify and create account'}
      </button>
      <button type="button" className="link-btn" onClick={onChangeEmail} disabled={Boolean(busy)}>
        Change email or details
      </button>
    </form>
  )
}
