import { useRoute } from '@shared/ui/router'
import Landing from './pages/Landing'
import StudentPortal from './pages/StudentPortal'
import StaffPortal from './pages/StaffPortal'

// CommonApp: student registration/portal and the staff/admin console.
export default function App() {
  const route = useRoute()
  if (route === '/student') return <StudentPortal />
  if (route === '/staff') return <StaffPortal />
  return <Landing />
}
