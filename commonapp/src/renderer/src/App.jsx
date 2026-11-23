import { useRoute } from '@shared/ui/router'
import Landing from './pages/Landing'
import StudentPortal from './pages/StudentPortal'
import StaffPortal from './pages/StaffPortal'
import CommunityPortal from './pages/CommunityPortal'

// CommonApp: student registration/portal, the staff/admin console, and the
// Community board. Community has its own list/new/detail sub-routes, so it
// matches on prefix and does its own parsing of the remainder.
export default function App() {
  const route = useRoute()
  if (route === '/student') return <StudentPortal />
  if (route === '/staff') return <StaffPortal />
  if (route === '/community' || route.startsWith('/community/')) return <CommunityPortal route={route} />
  return <Landing />
}
