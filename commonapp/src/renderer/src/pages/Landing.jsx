import iitdLogo from '@iitd-logo'
import { AppShell } from '../components/ui'

export default function Landing() {
  return (
    <AppShell>
      <div className="landing">
        <div className="landing-inner">
          <div className="landing-brand">
            <img
              className="landing-logo"
              src={iitdLogo}
              alt="Indian Institute of Technology Delhi"
            />
            <div>
              <h1>Central Library, IIT Delhi</h1>
              <p>Choose how you want to sign in.</p>
            </div>
          </div>
          <div className="role-grid">
            <a className="role-card" href="#/student">
              <strong>
                Student <span aria-hidden="true">→</span>
              </strong>
              <span>Register, sign in, see your visit and live seat availability.</span>
            </a>
            <a className="role-card" href="#/staff">
              <strong>
                Staff / Admin <span aria-hidden="true">→</span>
              </strong>
              <span>Library desk and administration: visits, logs, cards, terminals, tables.</span>
            </a>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
